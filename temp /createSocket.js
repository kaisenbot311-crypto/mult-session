const fs = require("fs");
const path = require("path");
const P = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

async function createSocket(sessionId, opts = {}) {
  const sessionsDir = path.join(process.cwd(), "sessions");
  const sessionPath = path.join(sessionsDir, sessionId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  // keep logger silent to save overhead
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" }),
    // disable memory-heavy options here
  });

  // persist creds when changed
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (e) {
      /* ignore */
    }
  });

  return sock;
}

module.exports = createSocket;
