import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from "baileys";
import pino from "pino";
import path from "path";
import fs from "fs/promises";

export async function createSocket(sessionId) {
  const sessionsDir = path.join(process.cwd(), "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionPath = path.join(sessionsDir, sessionId);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    browser: Browsers.ubuntu("Chrome"),
  });

  sock.ev.on("creds.update", saveCreds);

  return sock;
}
