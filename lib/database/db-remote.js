// dbmanager.js (ESM)
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class DBManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.filePath = options.filePath || path.join(__dirname, "db.json");
    this.writeDebounceMs = options.writeDebounceMs ?? 1000;
    this.atomicWrite = options.atomicWrite ?? true;
    this.maxUsers = options.maxUsers ?? null;
    this.maxKeysPerUser = options.maxKeysPerUser ?? null;
    this.returnDirectRef = options.returnDirectRef ?? true;

    // Main in-memory store: Map<userId, Map<key, valueObject>>
    this.store = new Map();

    // Write queue debounce:
    this._pendingWrite = false;
    this._writeTimer = null;
    this._dirty = false; // whether cache changed since last write

    // init immediately (sync read on startup to avoid race)
    this._initFromFile();
  }

  // -------------------------
  // Internal helpers
  // -------------------------
  _initFromFile() {
    try {
      if (!fs.existsSync(this.filePath)) {
        // ensure parent dir exists
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify({}, null, 2), "utf8");
      }
      const raw = fs.readFileSync(this.filePath, "utf8") || "{}";
      const obj = JSON.parse(raw);

      // Convert to Map<user, Map<key,value>>
      for (const [userId, keysObj] of Object.entries(obj)) {
        const m = new Map();
        for (const [k, v] of Object.entries(keysObj || {})) {
          m.set(k, v);
        }
        this.store.set(userId, m);
      }

      // No write needed right after init
      this._dirty = false;
    } catch (err) {
      throw new Error("Failed to initialize DBManager: " + err.message);
    }
  }

  _scheduleWrite() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._dirty = true;
    this._writeTimer = setTimeout(
      () => this._flushToDisk(),
      this.writeDebounceMs
    );
  }

  _flushToDisk() {
    if (!this._dirty) return;
    const dataObj = this._serializeToObject();
    const tmpPath = this.filePath + ".tmp";
    const writeFn = (content) => {
      if (this.atomicWrite) {
        fs.writeFileSync(tmpPath, content, "utf8");
        fs.renameSync(tmpPath, this.filePath);
      } else {
        fs.writeFileSync(this.filePath, content, "utf8");
      }
      this._dirty = false;
      this.emit("flush");
    };
    try {
      const content = JSON.stringify(dataObj, null, 2);
      writeFn(content);
    } catch (err) {
      this.emit("error", err);
    }
  }

  _serializeToObject() {
    const out = {};
    for (const [userId, map] of this.store) {
      const obj = {};
      for (const [k, v] of map) {
        obj[k] = v;
      }
      out[userId] = obj;
    }
    return out;
  }

  _ensureUserMap(userId) {
    let m = this.store.get(userId);
    if (!m) {
      m = new Map();
      this.store.set(userId, m);
      this._applyLRUIfNeeded();
    } else {
      // move userId to end (most recently used) to implement LRU behavior
      if (this.maxUsers) {
        this.store.delete(userId);
        this.store.set(userId, m);
      }
    }
    return m;
  }

  _applyLRUIfNeeded() {
    if (!this.maxUsers) return;
    while (this.store.size > this.maxUsers) {
      const firstKey = this.store.keys().next().value;
      this.store.delete(firstKey);
      this.emit("evictUser", firstKey);
    }
  }

  _applyMaxKeysToUser(userMap) {
    if (!this.maxKeysPerUser) return;
    while (userMap.size > this.maxKeysPerUser) {
      const oldestKey = userMap.keys().next().value;
      userMap.delete(oldestKey);
    }
  }

  // -------------------------
  // Public API
  // -------------------------

  /**
   * get(userId, key)
   * returns null if not found. By default returns direct reference for max speed.
   */
  get(userId, key) {
    const m = this.store.get(userId);
    if (!m) return null;
    const val = m.get(key) ?? null;

    // update LRU recency
    if (this.maxUsers && this.store.has(userId)) {
      const userMap = this.store.get(userId);
      this.store.delete(userId);
      this.store.set(userId, userMap);
    }
    if (!val) return null;
    return this.returnDirectRef ? val : deepClone(val);
  }

  /**
   * set(userId, key, valueObject)
   * valueObject is a plain object, e.g. { status: true, message: "Welcome" }
   */
  set(userId, key, value) {
    if (typeof userId === "number") userId = String(userId);
    const m = this._ensureUserMap(userId);
    m.set(key, value);
    this._applyMaxKeysToUser(m);
    this._scheduleWrite();
    this.emit("set", { userId, key, value });
  }

  /**
   * delKey(userId, key) -> delete a single key for user
   */
  delKey(userId, key) {
    const m = this.store.get(userId);
    if (!m) return false;
    const existed = m.delete(key);
    if (m.size === 0) this.store.delete(userId);
    if (existed) {
      this._scheduleWrite();
      this.emit("delKey", { userId, key });
    }
    return existed;
  }

  /**
   * delUser(userId) -> delete entire user data
   */
  delUser(userId) {
    const existed = this.store.delete(userId);
    if (existed) {
      this._scheduleWrite();
      this.emit("delUser", userId);
    }
    return existed;
  }

  /**
   * getAll(userId) -> return all keys for user as plain object (or null)
   */
  getAll(userId) {
    const m = this.store.get(userId);
    if (!m) return null;
    const obj = {};
    for (const [k, v] of m) obj[k] = v;

    // update LRU recency
    if (this.maxUsers) {
      this.store.delete(userId);
      this.store.set(userId, m);
    }
    return obj;
  }

  /**
   * syncFlush() -> force flush to disk immediately (blocking)
   */
  syncFlush() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this._flushToDisk();
  }

  /**
   * close() -> flush and cleanup timers
   */
  close() {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this.syncFlush();
  }

  /**
   * stats() -> helper for debugging/perf: returns counts
   */
  stats() {
    let keys = 0;
    for (const m of this.store.values()) keys += m.size;
    return { users: this.store.size, keys };
  }
}

// small deep clone helper function
function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}
