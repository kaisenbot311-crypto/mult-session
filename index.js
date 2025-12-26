// app.js
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs-extra";
import { fileURLToPath } from "url";
import initializeTelegramBot from "./bot.js";

import { manager, main } from "./lib/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());

// ensure sessions dir exists
const SESSIONS_DIR = path.join(process.cwd(), "sessions");
await fs.mkdirp(SESSIONS_DIR);

// Utility: format pairing code in groups of 4 (AAAA-BBBB-CCCC)
function fmtCode(raw) {
  if (!raw) return raw;
  // remove whitespace then group
  const s = String(raw).replace(/\s+/g, "");
  return s.match(/.{1,4}/g)?.join("-") || s;
}

// Start a session (if not already running)
app.get("/start/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const sock = await manager.start(sid);
    res.json({
      ok: true,
      sessionId: sid,
      running: manager.isRunning(sid),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Pair by code (GET) — returns pairing code string
// Usage: GET /pair/:sessionId/:phone  (e.g. 919812345678)
app.get("/pair/:num/", async (req, res) => {
  const sid = req.params.num;
  const phone = sid;

  if (!/^[0-9]{6,15}$/.test(phone)) {
    return res.status(400).json({
      ok: false,
      error: "phone must be digits (E.164 without +), e.g. 919812345678",
    });
  }

  try {
    // ensure session started
    const sock = await manager.start(sid);

    let attempts = 0;
    let lastErr = null;

    while (attempts < 4) {
      attempts++;
      try {
        let raw;

        if (typeof sock.requestPairingCode === "function") {
          raw = await sock.requestPairingCode(phone);
        } else if (typeof sock.generatePairingCode === "function") {
          raw = await sock.generatePairingCode(phone);
        } else {
          throw new Error("Pairing API not supported by this Baileys version");
        }

        const formatted = fmtCode(raw);

        return res.json({
          ok: true,
          sessionId: sid,
          phone,
          code: formatted,
          raw,
        });
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err).toLowerCase();

        // retry on transient errors
        if (
          msg.includes("connection closed") ||
          msg.includes("request timeout") ||
          msg.includes("not open")
        ) {
          await new Promise((r) => setTimeout(r, 1000 * attempts));
          continue;
        }

        // break on permanent errors
        if (
          msg.includes("rate") ||
          msg.includes("forbidden") ||
          msg.includes("not allowed")
        ) {
          break;
        }

        break;
      }
    }

    return res.status(500).json({
      ok: false,
      error: lastErr?.message || "Failed to request pairing code",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// Stop (graceful close, keep creds)
app.post("/stop/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const ok = await manager.stop(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Logout (permanent) - logout + delete creds
app.post("/logout/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const ok = await manager.logout(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// list known sessions
app.get("/sessions", (req, res) => {
  res.json({ sessions: manager.list() });
});

// health
app.get("/", (req, res) =>
  res.send("Baileys Multi-session Server (pair-code ready)")
);

// -- startup
const PORT = process.env.PORT || 3000;

(async function init() {
  try {
    // ensure lib main is initialized (attaches events, loads plugins) but do NOT auto-start if you want full control
    await main({ autoStartAll: false });

    app.listen(PORT, async () => {
      console.log(`Server listening on ${PORT}`);

      // start all sessions that were registered in meta (staggered by SessionManager)
      try {
        await manager.startAll();
        console.log("Attempted to start registered sessions");
      } catch (e) {
        console.warn("startAll err", e?.message || e);
      }
      try {
        initializeTelegramBot(manager);
      } catch (e) {
        console.warn("bot err", e?.message || e);
      }
    });
  } catch (err) {
    console.error("Initialization error", err);
    process.exit(1);
  }
})();
