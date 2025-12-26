// ============================================
// index.js - Main Server (ESM + Multi-User)
// Modified: improved startup, DB events, shutdown, /status
// ============================================
import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs-extra";
import { createBaileysConnection, logoutSession } from "./lib/connection.js";
import {
  getAllSessions as dbGetAllSessions,
  getSession as dbGetSession,
} from "./lib/database/sessions.js";
import { restoreSelectedFiles } from "./lib/auth-persist.js";
import { generatePairingCode } from "./lib/pairing.js";
import config from "./config.js";
import cache from "./lib/cache.js";
import manager from "./lib/manager.js";
// Optional local DB module (your in-memory JSON loader)
import db from "./lib/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// -----------------------------
// Utility helpers
// -----------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * startBot(number)
 * Start a single baileys instance for a given session number.
 */
async function startBot(number) {
  try {
    console.log(`🔄 [${number}] Starting bot...`);
    const baseDir = config.AUTH_DIR;
    const sessionDir = path.join(baseDir, String(number));

    // Ensure directories exist
    await fs.promises.mkdir(baseDir, { recursive: true });
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const conn = await createBaileysConnection(number);
    if (!conn) {
      console.error(`❌ [${number}] Failed to create connection`);
      return null;
    }
    console.log(`✅ [${number}] Connection created successfully`);
    return conn;
  } catch (err) {
    console.error(`❌ Failed to start bot for ${number}:`, err);
    return null;
  }
}

/**
 * initializeSessions()
 * - Restores session files from DB -> disk if necessary
 * - Looks for existing auth folders and starts connections
 */
async function initializeSessions() {
  // dynamic import baileys for delay helper
  const baileys = await import("baileys").catch(() => null);
  const delay =
    baileys?.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  try {
    console.log("🌱 Initializing bot sessions...");
    const baseDir = config.AUTH_DIR || path.join(__dirname, "auth");

    // ensure base dir exists
    await fs.promises.mkdir(baseDir, { recursive: true });

    // materialize DB sessions (selected-files) to disk if they exist
    try {
      const dbSessions = (await dbGetAllSessions()) || [];
      for (const s of dbSessions) {
        const number = String(s.number);
        const authDir = path.join(baseDir, number);
        const credsPath = path.join(authDir, "creds.json");

        try {
          await fs.promises.mkdir(authDir, { recursive: true });

          if (s?.creds && s.creds._selected_files) {
            try {
              const res = await restoreSelectedFiles(
                number,
                authDir,
                async (num) => {
                  return await dbGetSession(num);
                }
              );
              if (!res.ok) {
                console.warn(
                  `⚠️ [${number}] restoreSelectedFiles failed:`,
                  res.reason
                );
                // fallback to write plain creds.json if missing
                try {
                  await fs.promises.access(credsPath);
                } catch (e) {
                  if (s.creds) {
                    const credsCopy = Object.assign({}, s.creds);
                    delete credsCopy._selected_files;
                    await fs.promises.writeFile(
                      credsPath,
                      JSON.stringify(credsCopy, null, 2),
                      "utf8"
                    );
                  }
                }
              }
            } catch (e) {
              console.warn(
                `⚠️ Failed to materialize DB session ${number} to disk:`,
                e.message || e
              );
              try {
                await fs.promises.access(credsPath);
              } catch (err) {
                if (s.creds) {
                  const credsCopy = Object.assign({}, s.creds);
                  delete credsCopy._selected_files;
                  await fs.promises.writeFile(
                    credsPath,
                    JSON.stringify(credsCopy, null, 2),
                    "utf8"
                  );
                }
              }
            }
          } else {
            // legacy fallback: write creds.json if missing
            try {
              await fs.promises.access(credsPath);
            } catch (e) {
              if (s.creds) {
                await fs.promises.writeFile(
                  credsPath,
                  JSON.stringify(s.creds, null, 2),
                  "utf8"
                );
              }
            }
          }
        } catch (e) {
          console.warn(
            `⚠️ Failed to materialize DB session ${number} to disk:`,
            e.message || e
          );
        }
      }
    } catch (e) {
      // ignore DB read errors - continue with filesystem scan
      console.warn("⚠️ Could not read DB sessions:", e?.message || e);
    }

    // read folders in auth dir to find session folders with creds.json
    let folders = [];
    try {
      folders = await fs.promises.readdir(baseDir);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      folders = [];
    }

    const sessionNumbers = [];
    for (const f of folders) {
      const credsPath = path.join(baseDir, f, "creds.json");
      try {
        await fs.promises.access(credsPath);
        sessionNumbers.push(f);
      } catch (e) {
        // ignore folders without creds
      }
    }

    if (!sessionNumbers.length) {
      console.log(
        "⚠️ No existing sessions found. Use /pair endpoint to add new sessions."
      );
      return;
    }

    console.log(`♻️ Restoring ${sessionNumbers.length} sessions...`);

    // concurrency control
    const concurrency =
      parseInt(process.env.RESTORE_CONCURRENCY || "3", 10) || 3;
    const queue = sessionNumbers.slice();
    const workers = Array.from({
      length: Math.min(concurrency, queue.length),
    }).map(async () => {
      while (queue.length) {
        const number = queue.shift();
        if (!number) break;
        try {
          console.log(`🔄 Restoring session for ${number}...`);
          await startBot(number);
          await delay(2000); // polite delay between starts
        } catch (err) {
          console.error(`❌ Failed restoring session for ${number}:`, err);
          try {
            await fs.appendFile(
              path.join(__dirname, "restore-errors.log"),
              `[${new Date().toISOString()}] Session ${number} restore failed: ${
                err?.message || err
              }\n`
            );
          } catch (logErr) {
            console.error("❌ Failed to log restore error:", logErr);
          }
        }
      }
    });

    await Promise.all(workers);
    console.log("✅ Initialization complete. sessions active.");
  } catch (err) {
    console.error("❌ initializeSessions() failed:", err);
  }
}

// ==================== ROUTES ====================
app.get("/kaithheathcheck", (req, res) => {
  res.status(200).send("OK");
});

app.get("/", (req, res) => {
  res.send("Server Running");
});

app.get("/status", (req, res) => {
  try {
    // manager.getAllConnections() expected to exist (used below originally)
    const allConnections =
      typeof manager.getAllConnections === "function"
        ? manager.getAllConnections()
        : [];

    const sessions = {};
    (allConnections || []).forEach(({ file_path, connection, healthy }) => {
      sessions[file_path] = {
        connected: !!healthy,
        user: connection?.user?.name || "unknown",
        jid: connection?.user?.id || null,
        healthy: !!healthy,
      };
    });

    res.json({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      db: typeof db.stats === "function" ? db.stats() : { users: 0, keys: 0 },
      cache:
        typeof cache.stats === "function"
          ? cache.stats()
          : { enabled: !!cache },
      totalConnections: (allConnections || []).length,
      healthyConnections: (allConnections || []).filter((c) => c.healthy)
        .length,
      sessions,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Pair new device endpoint
 */
app.get("/pair", async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required (e.g., ?number=1234567890)",
      });
    }

    if (manager.isConnected && manager.isConnected(number)) {
      return res.status(409).json({
        success: false,
        message: "This number is already connected",
      });
    }

    const sessionId = number.replace(/[^0-9]/g, "");
    const pairingCode = await generatePairingCode(sessionId, number);

    res.json({
      success: true,
      sessionId,
      pairingCode,
      message:
        "Enter this code in WhatsApp: Settings > Linked Devices > Link a Device",
    });
  } catch (error) {
    console.error("Pairing error:", error);
    res.status(500).json({
      success: false,
      message: error.message || String(error),
    });
  }
});

/**
 * Logout endpoint
 */
app.get("/logout", async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }
    const sessionId = number.replace(/[^0-9]/g, "");
    console.log(`🚪 /logout initiated for ${sessionId}`);
    const success = await logoutSession(sessionId);
    if (success) {
      console.log(`✅ /logout completed for ${sessionId}`);
      return res.json({
        success: true,
        message: `Session ${sessionId} logged out successfully`,
      });
    } else {
      console.warn(
        `⚠️ /logout: Session ${sessionId} not found or already logged out`
      );
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    }
  } catch (error) {
    console.error("Logout error:", error);
    res
      .status(500)
      .json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Reconnect endpoint
 */
app.get("/reconnect", async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) {
      return res
        .status(400)
        .json({ success: false, message: "Phone number is required" });
    }
    const sessionId = number.replace(/[^0-9]/g, "");
    // Logout first
    await logoutSession(sessionId).catch(() => {});
    await wait(1000);
    const sock = await createBaileysConnection(sessionId);
    if (sock) {
      res.json({
        success: true,
        message: `Session ${sessionId} reconnected successfully`,
      });
    } else {
      throw new Error("Failed to reconnect");
    }
  } catch (error) {
    console.error("Reconnect error:", error);
    res
      .status(500)
      .json({ success: false, message: error.message || String(error) });
  }
});

app.get("/sessions", (req, res) => {
  try {
    const sessions = {};
    const allConnections =
      typeof manager.getAllConnections === "function"
        ? manager.getAllConnections()
        : [];

    allConnections.forEach(({ file_path, connection, healthy }) => {
      sessions[file_path] = {
        connected: !!healthy,
        user: connection?.user?.name || "unknown",
        jid: connection?.user?.id || null,
        healthy: !!healthy,
      };
    });

    res.json({
      total: Object.keys(sessions).length,
      healthy: (allConnections || []).filter((c) => c.healthy).length,
      sessions,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ------------------- Startup & server -------------------
const server = app.listen(PORT, async () => {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`${"=".repeat(50)}`);
  console.log(
    `📱 Pair new device: http://localhost:${PORT}/pair?number=YOUR_NUMBER`
  );
  console.log(`📊 Check status: http://localhost:${PORT}/status`);
  console.log(`🚪 Logout: http://localhost:${PORT}/logout?number=YOUR_NUMBER`);
  console.log(
    `🔄 Reconnect: http://localhost:${PORT}/reconnect?number=YOUR_NUMBER`
  );
  console.log(`${"=".repeat(50)}\n`);

  // ---- Initialization sequence ----
  try {
    // 1) Initialize cache
    try {
      if (cache && typeof cache.init === "function") {
        await cache.init();
        console.log("✅ Cache initialized");
      } else {
        console.log("ℹ️ No cache.init() available, skipping cache init");
      }
    } catch (e) {
      console.warn("⚠️ Cache init failed:", e?.message || e);
    }

    // 2) Ensure DB sync (if using Sequelize-style DB)
    try {
      if (config?.DATABASE && typeof config.DATABASE.sync === "function") {
        await config.DATABASE.sync();
        console.log("✅ Database synced");
      }
    } catch (dbErr) {
      console.error("❌ Failed to sync database:", dbErr?.message || dbErr);
    }

    // 3) Optional: wait for in-memory DB ready (if your db exposes ready)
    try {
      if (db && typeof db.ready !== "undefined") {
        if (db.ready === true) {
          console.log("✅ DB already ready in memory");
        } else {
          // wait for 'ready' event or timeout 5s
          await new Promise((resolve) => {
            let done = false;
            const onReady = () => {
              if (done) return;
              done = true;
              clearTimeout(timeout);
              db.off && db.off("ready", onReady);
              resolve();
            };
            const timeout = setTimeout(() => {
              if (done) return;
              done = true;
              db.off && db.off("ready", onReady);
              console.warn("⚠️ DB ready event timeout (continuing startup)");
              resolve();
            }, 5000);
            db.on && db.on("ready", onReady);
          });
        }
      } else {
        console.log("ℹ️ DB ready flag not present, continuing");
      }
    } catch (e) {
      console.warn("⚠️ DB ready wait failed:", e?.message || e);
    }

    // 4) Log DB stats if available
    try {
      if (db && typeof db.stats === "function") {
        console.log("DB stats:", db.stats());
      }
    } catch (e) {
      console.warn("⚠️ Could not read DB stats:", e?.message || e);
    }

    // 5) Initialize sessions (restore + start)
    await initializeSessions();
  } catch (e) {
    console.error("❌ Startup initialization error:", e);
  }
});

// ------------------- DB & Cache event hooks -------------------
// Popular event hooks: error / flush / evictUser / set
if (db) {
  if (typeof db.on === "function") {
    db.on("error", (err) => console.error("DB ERROR:", err));
    db.on("flush", () => console.log("DB flushed to disk"));
    db.on("evictUser", (u) => console.log("DB evicted user:", u));
    db.on("set", (info) => {
      // small log - don't spam in high-throughput apps
      // console.log("DB set:", info.userId, info.key);
    });
  }
}

// ------------------- Graceful shutdown -------------------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🔻 Received ${signal} - shutting down gracefully...`);

  // Stop accepting new connections
  try {
    if (server && typeof server.close === "function") {
      await new Promise((resolve) => {
        server.close(() => {
          console.log("HTTP server closed");
          resolve();
        });
        // Force close after 10s
        setTimeout(resolve, 10000).unref();
      });
    }
  } catch (e) {
    console.warn("Error closing server:", e);
  }

  // 1) attempt to logout all active sessions
  try {
    const allSessions =
      typeof dbGetAllSessions === "function" ? await dbGetAllSessions() : [];
    if (Array.isArray(allSessions) && allSessions.length) {
      console.log(`🔌 Logging out ${allSessions.length} sessions...`);
      const promises = allSessions.map(async (s) => {
        try {
          const id = String(s.number).replace(/[^0-9]/g, "");
          await logoutSession(id).catch(() => {});
        } catch (e) {
          // ignore per-session errors
        }
      });
      // wait but cap to 15s
      await Promise.race([Promise.all(promises), wait(15000)]);
      console.log("🔌 Session logout attempts finished (best-effort)");
    } else {
      // fallback: iterate manager connections
      if (manager && typeof manager.getAllConnections === "function") {
        const conns = manager.getAllConnections() || [];
        console.log(
          `🔌 Logging out ${conns.length} connections from manager...`
        );
        await Promise.all(
          conns.map(async (c) => {
            try {
              const fp = c.file_path || c.id || c.sessionId;
              if (!fp) return;
              const sid = String(fp).replace(/[^0-9]/g, "");
              await logoutSession(sid).catch(() => {});
            } catch (e) {}
          })
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("Error during session logout:", e);
  }

  // 2) close cache (if supported)
  try {
    if (cache && typeof cache.close === "function") {
      await cache.close();
      console.log("Cache closed");
    }
  } catch (e) {
    console.warn("Error closing cache:", e);
  }

  // 3) flush & close DB
  try {
    if (db && typeof db.close === "function") {
      db.close();
      console.log("DB closed/flushed");
    }
  } catch (e) {
    console.warn("Error closing DB:", e);
  }

  console.log("Shutdown complete. Exiting.");
  process.exit(0);
}

// handle signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// catch unexpected exceptions (log then shutdown)
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
  // do not immediately exit for some rejections, but begin shutdown
  shutdown("unhandledRejection");
});
