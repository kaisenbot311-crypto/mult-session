// createSocket.js - FIXED VERSION
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import fs from "fs/promises";

export async function createSocket(sessionId) {
  const sessionsDir = path.join(process.cwd(), "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionPath = path.join(sessionsDir, sessionId);

  // Use multi-file auth state
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Get latest Baileys version
  const { version } = await fetchLatestBaileysVersion();

  console.log(
    `[${sessionId}] Creating socket with Baileys v${version.join(".")}`
  );

  // FIXED: Better socket configuration for pairing
  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: Browsers.ubuntu("Chrome"),

    // IMPORTANT: These settings help with pairing stability
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,

    // Mark as available immediately
    markOnlineOnConnect: true,

    // Sync settings
    syncFullHistory: false,

    // Message retry settings
    getMessage: async (key) => {
      return { conversation: "" };
    },
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Enhanced connection logging
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(`[${sessionId}] QR code generated`);
    }

    if (connection === "connecting") {
      console.log(`[${sessionId}] Connecting...`);
    }

    if (connection === "open") {
      console.log(`[${sessionId}] ✅ Connection opened successfully`);
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error;
      console.log(
        `[${sessionId}] Connection closed: ${statusCode} - ${reason}`
      );
    }
  });

  return sock;
}
