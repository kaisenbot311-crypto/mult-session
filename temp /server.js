const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const qrcode = require("qrcode-terminal");
const fs = require("fs");

const SessionManagerClass = require("./lib/sessionManager");
const sessionManager = new SessionManagerClass({
  concurrency: 20,
  startDelayMs: 150,
});

// on startup: ensure sessions dir exists
const sessionsDir = path.join(process.cwd(), "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });
g;
const app = express();
app.use(bodyParser.json());

// Utility: format pairing code groups of 4
function fmtCode(raw) {
  if (!raw) return raw;
  return raw.match(/.{1,4}/g)?.join("-") || raw;
}

// Start session (if not running)
app.get("/start/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const sock = await sessionManager.start(sid);
    res.json({
      ok: true,
      sessionId: sid,
      running: sessionManager.isRunning(sid),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Pair by code (GET) — returns pairing code string
// Usage: GET /pair/:sessionId/:phone
app.get("/pair/:sessionId/:phone", async (req, res) => {
  const sid = req.params.sessionId;
  const phone = req.params.phone; // expected E.164 digits without +
  if (!/^[0-9]{6,15}$/.test(phone))
    return res
      .status(400)
      .json({ ok: false, error: "phone must be digits e.g. 919812345678" });

  try {
    // ensure session started
    const sock = await sessionManager.start(sid);

    // try requestPairingCode with retries/backoff
    let attempts = 0;
    let lastErr = null;
    while (attempts < 4) {
      attempts++;
      try {
        // some Baileys versions expose requestPairingCode, else use generatePairingCode variant
        if (typeof sock.requestPairingCode === "function") {
          const raw = await sock.requestPairingCode(phone);
          const formatted = fmtCode(raw);
          // also print in terminal
          try {
            qrcode.generate(raw, { small: true });
          } catch (e) {}
          return res.json({ ok: true, code: formatted, raw });
        } else if (typeof sock.generatePairingCode === "function") {
          const raw = await sock.generatePairingCode(phone);
          const formatted = fmtCode(raw);
          return res.json({ ok: true, code: formatted, raw });
        } else {
          throw new Error("pairing API not supported by this Baileys version");
        }
      } catch (err) {
        lastErr = err;
        // if connection closed or transient, wait and retry
        const msg = String(err?.message || err);
        if (
          msg.toLowerCase().includes("connection closed") ||
          msg.toLowerCase().includes("request timeout") ||
          msg.toLowerCase().includes("not open")
        ) {
          await new Promise((r) => setTimeout(r, 1000 * attempts));
          continue;
        }
        // if rate-limited or forbidden, break
        if (
          msg.toLowerCase().includes("rate") ||
          msg.toLowerCase().includes("forbidden") ||
          msg.toLowerCase().includes("not allowed")
        )
          break;
        // fallback break
        break;
      }
    }

    return res.status(500).json({
      ok: false,
      error: lastErr?.message || "failed to request pairing code",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Stop (graceful close, keep creds)
app.post("/stop/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const ok = await sessionManager.stop(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Logout (permanent) - logout + delete creds
app.post("/logout/:sessionId", async (req, res) => {
  const sid = req.params.sessionId;
  try {
    const ok = await sessionManager.logout(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// list known sessions
app.get("/sessions", (req, res) => {
  res.json({ sessions: sessionManager.list() });
});

// health
app.get("/", (req, res) =>
  res.send("Baileys Multi-session Server (pair-code ready)")
);

// start HTTP server and then auto-start known sessions
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Server listening on", PORT);
  // start all sessions registered in sessions.json in a staggered manner
  // note: if you have many sessions (500+), adjust concurrency accordingly
  try {
    await sessionManager.startAll();
    console.log("Attempted to start registered sessions");
  } catch (e) {
    console.warn("startAll err", e?.message || e);
  }
});
