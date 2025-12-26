import DBManager from "./dbmanager.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new DBManager({
  filePath: path.join(__dirname, "data", "db.json"),
  writeDebounceMs: 500, // faster writes
  atomicWrite: true, // safe writes
  maxUsers: 10000, // LRU eviction
  maxKeysPerUser: 100, // per-user limit
  returnDirectRef: true, // fastest
});

export default db;
