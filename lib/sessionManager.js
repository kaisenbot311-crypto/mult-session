import fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import EventEmitter from "events";
import { DisconnectReason } from "@whiskeysockets/baileys"; // used to detect permanent logout reasons

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    // resolved from release()
    this.active++;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.queue.length) {
      const next = this.queue.shift();
      try {
        next();
      } catch (e) {
        // ignore
      }
    }
  }
}

export default class SessionManager extends EventEmitter {
  /**
   * opts:
   *  - createSocket: async function(sessionId) => sock (required)
   *  - sessionsDir: path to store session auth folders (optional)
   *  - metaFile: path to persist session ids (optional)
   *  - concurrency: number (optional)
   *  - startDelayMs: number (optional)
   *  - reconnectLimit: number (optional, default 10)
   *  - defaultBackoff: number (optional)
   *  - maxBackoff: number (optional)
   */
  constructor(opts = {}) {
    super();
    if (!opts.createSocket) throw new Error("createSocket option required");
    this.createSocket = opts.createSocket;
    // optional DB instance provided by caller to avoid circular imports
    this.db = opts.db;
    this.sessions = new Map(); // sessionId => { sock, backoffMs, restarting, status, reconnectTimer, deleted, reconnectAttempts }
    // make paths absolute to avoid CWD surprises
    this.sessionsDir = path.resolve(opts.sessionsDir || path.join(process.cwd(), "sessions"));
    this.metaFile = path.resolve(opts.metaFile || path.join(process.cwd(), "sessions.json"));
    this.concurrency = opts.concurrency || 10;
    this.semaphore = new Semaphore(this.concurrency);
    this.startDelayMs = typeof opts.startDelayMs === "number" ? opts.startDelayMs : 200;
    this.defaultBackoff = typeof opts.defaultBackoff === "number" ? opts.defaultBackoff : 1000;
    this.maxBackoff = typeof opts.maxBackoff === "number" ? opts.maxBackoff : 60_000;
    this.reconnectLimit = typeof opts.reconnectLimit === "number" ? opts.reconnectLimit : 10;

    // try to synchronously load meta on startup to avoid race with register()
    try {
      this._loadMetaSync();
      this.ready = Promise.resolve();
    } catch (e) {
      console.warn("session manager: sync meta load failed, falling back to async:", e?.message || e);
      this.ready = this._loadMeta().catch((e2) => {
        console.warn("session manager: failed to load meta", e2?.message || e2);
      });
    }
  }

  // ----- robust synchronous loader (used at startup) -----
  _loadMetaSync() {
    try {
      try {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      } catch (e) { }
      let raw;
      try {
        raw = fs.readFileSync(this.metaFile, "utf-8");
      } catch (e) {
        if (e?.code === "ENOENT") raw = "[]";
        else throw e;
      }
      let list;
      try {
        list = JSON.parse(raw || "[]");
      } catch (e) {
        console.warn("session manager: invalid meta JSON, ignoring (sync)", e?.message || e);
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      for (const id of list) {
        if (!this.sessions.has(id)) {
          this.sessions.set(id, {
            sock: null,
            backoffMs: this.defaultBackoff,
            restarting: false,
            status: "stopped",
            reconnectTimer: null,
            deleted: false,
            reconnectAttempts: 0,
          });
        }
      }
      try {
        this._persistMetaSync();
      } catch (e) {
        // try async persist if sync persist fails
        this._persistMeta().catch(() => { });
      }
    } catch (e) {
      throw e;
    }
  }

  // ----- async loader fallback -----
  async _loadMeta() {
    try {
      await fsPromises.mkdir(this.sessionsDir, { recursive: true });
      const raw = await fsPromises.readFile(this.metaFile, "utf-8").catch((e) => {
        if (e?.code === "ENOENT") return "[]";
        throw e;
      });
      let list;
      try {
        list = JSON.parse(raw || "[]");
      } catch (e) {
        console.warn("session manager: invalid meta JSON, ignoring", e?.message || e);
        list = [];
      }
      if (!Array.isArray(list)) list = [];
      for (const id of list) {
        if (!this.sessions.has(id)) {
          this.sessions.set(id, {
            sock: null,
            backoffMs: this.defaultBackoff,
            restarting: false,
            status: "stopped",
            reconnectTimer: null,
            deleted: false,
            reconnectAttempts: 0,
          });
        }
      }
      await this._persistMeta().catch(() => { });
    } catch (e) {
      if (e?.code !== "ENOENT") console.warn("meta load error", e?.message || e);
    }
  }

  // ----- async, atomic persist with small retry logic -----
  async _persistMeta() {
    try {
      const dir = path.dirname(this.metaFile);
      await fsPromises.mkdir(dir, { recursive: true });
      const list = Array.from(this.sessions.keys());
      const tmp = `${this.metaFile}.tmp`;
      // write tmp
      await fsPromises.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");
      // ensure tmp exists then try rename with a few retries
      let attempts = 0;
      while (attempts < 4) {
        try {
          // confirm tmp exists before rename
          await fsPromises.stat(tmp);
          await fsPromises.rename(tmp, this.metaFile);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 4) {
            throw err;
          }
          // if tmp disappeared, rewrite it and retry
          if (err?.code === "ENOENT") {
            try {
              await fsPromises.writeFile(tmp, JSON.stringify(list, null, 2), "utf-8");
            } catch (writeErr) {
              // ignore writeErr, will retry
            }
          }
          // small backoff before retry
          await new Promise((r) => setTimeout(r, 50 * attempts));
        }
      }
      // best-effort fsync on directory
      try {
        const dirFd = fs.openSync(dir, "r");
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch (e) {
        // ignore — some envs restrict fsync
      }
      this.emit("meta.updated", list);
    } catch (e) {
      console.warn("meta persist error", e?.message || e);
    }
  }

  // ----- synchronous, atomic persist with defensive checks -----
  _persistMetaSync() {
    try {
      const dir = path.dirname(this.metaFile);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) { }
      const list = Array.from(this.sessions.keys());
      const tmp = `${this.metaFile}.tmp`;
      // write temp file synchronously then rename (with retries)
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");
      let attempts = 0;
      while (attempts < 4) {
        try {
          if (!fs.existsSync(tmp)) {
            // try to write again
            fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf-8");
          }
          fs.renameSync(tmp, this.metaFile);
          break;
        } catch (e) {
          attempts++;
          if (attempts >= 4) {
            throw e;
          }
          // brief pause (sync sleep via blocking loop is nasty — keep attempts limited)
        }
      }
      try {
        const dirFd = fs.openSync(dir, "r");
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch (e) { }
      this.emit("meta.updated", list);
    } catch (e) {
      // fallback to async attempt if sync fails
      try {
        this._persistMeta().catch(() => { });
      } catch (_) { }
      console.warn("meta persist sync error", e?.message || e);
    }
  }

  /**
   * register(sessionId)
   * - Synchronous API for backwards compatibility: ensures meta is persisted before return.
   * - This prevents race where caller does not await and process restarts immediately.
   */
  register(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sock: null,
        backoffMs: this.defaultBackoff,
        restarting: false,
        status: "stopped",
        reconnectTimer: null,
        deleted: false,
        reconnectAttempts: 0,
      });
    } else {
      // if previously marked deleted, unmark when explicitly registering
      const entry = this.sessions.get(sessionId);
      if (entry.deleted) entry.deleted = false;
      if (typeof entry.reconnectAttempts !== "number") entry.reconnectAttempts = 0;
    }
    // Persist synchronously to guarantee on-disk presence immediately
    this._persistMetaSync();
  }

  /**
   * unregister(sessionId) - synchronous (persists immediately)
   */
  unregister(sessionId) {
    if (this.sessions.has(sessionId)) {
      const entry = this.sessions.get(sessionId);
      // cancel any pending reconnect timer
      if (entry?.reconnectTimer) {
        try {
          clearTimeout(entry.reconnectTimer);
        } catch { }
        entry.reconnectTimer = null;
      }
      this.sessions.delete(sessionId);
      this._persistMetaSync();
    }
  }

  async start(sessionId) {
    // wait for initial meta load
    if (this.ready) await this.ready;
    // ensure session exists
    this.register(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error("failed to register session");
    if (entry.deleted) {
      throw new Error("session marked deleted; won't start");
    }
    // guard: avoid double-start when already starting/restarting
    if (entry.status === "starting" || entry.restarting) {
      return entry.sock;
    }
    if (entry.sock) return entry.sock; // already running

    await this.semaphore.acquire();
    try {
      entry.status = "starting";
      this.sessions.set(sessionId, entry);

      let sock;
      try {
        sock = await this.createSocket(sessionId);
      } catch (err) {
        // ensure state is consistent when createSocket fails
        console.warn(`[${sessionId}] createSocket failed:`, err?.message || err);
        entry.status = "stopped";
        entry.sock = null;
        entry.restarting = false;
        this.sessions.set(sessionId, entry);
        throw err;
      }

      // attach socket & events
      entry.sock = sock;
      entry.status = "connected";
      entry.restarting = false;
      entry.backoffMs = this.defaultBackoff;
      entry.reconnectAttempts = 0;

      // clear any reconnect timer if present
      if (entry.reconnectTimer) {
        try {
          clearTimeout(entry.reconnectTimer);
        } catch { }
        entry.reconnectTimer = null;
      }

      if (sock && sock.ev && typeof sock.ev.on === "function") {
        // wrap handlers to catch/reject promise rejections
        const safeOn = (ev, handler) => {
          try {
            sock.ev.on(ev, (...args) => {
              // call async handler but catch rejections
              Promise.resolve().then(() => handler(...args)).catch((e) => {
                console.warn(`[${sessionId}] event handler ${ev} error:`, e?.message || e);
              });
            });
          } catch (e) {
            // non-fatal
            console.warn(`[${sessionId}] failed to attach handler ${ev}:`, e?.message || e);
          }
        };

        safeOn("messages.upsert", (m) => this.emit("messages.upsert", sessionId, m));
        safeOn("groups.update", (u) => this.emit("groups.update", sessionId, u));
        safeOn("group-participants.update", (u) => this.emit("group-participants.update", sessionId, u));
        safeOn("creds.update", (u) => this.emit("creds.update", sessionId, u));
        safeOn("connection.update", (update) => this._handleConnectionUpdate(sessionId, update));
      }

      // persist meta async (we already did sync on register, but persist again to be safe)
      this._persistMeta().catch(() => { });

      this.sessions.set(sessionId, entry);
      return sock;
    } finally {
      // small stagger to avoid bursts
      try {
        await new Promise((r) => setTimeout(r, this.startDelayMs));
      } catch { }
      this.semaphore.release();
    }
  }

  async startAll() {
    if (this.ready) await this.ready;
    const keys = Array.from(this.sessions.keys());
    const concurrency = this.concurrency;
    for (let i = 0; i < keys.length; i += concurrency) {
      const chunk = keys.slice(i, i + concurrency).map((sid) =>
        this.start(sid).catch((e) => {
          console.warn("startAll chunk error", sid, e?.message || e);
        })
      );
      await Promise.all(chunk);
    }
  }

  async stop(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    // clear any pending reconnect timer so it doesn't restart later
    if (entry.reconnectTimer) {
      try {
        clearTimeout(entry.reconnectTimer);
      } catch { }
      entry.reconnectTimer = null;
    }

    try {
      entry.status = "stopping";
      try {
        if (typeof entry.sock?.ev?.removeAllListeners === "function") {
          try {
            entry.sock.ev.removeAllListeners();
          } catch { }
        }
        if (typeof entry.sock === "object" && entry.sock !== null) {
          if (typeof entry.sock.logout === "function") {
            await entry.sock.logout();
          } else if (entry.sock.ws) {
            try {
              entry.sock.ws.close();
            } catch { }
          }
        }
      } catch (e) {
        // ignore
      }
    } finally {
      entry.sock = null;
      entry.status = "stopped";
      this.sessions.set(sessionId, entry);
    }

    return true;
  }

  async logout(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    try {
      if (entry.sock && typeof entry.sock.logout === "function") {
        await entry.sock.logout();
      } else if (entry.sock && entry.sock.ws) {
        try {
          entry.sock.ws.close();
        } catch { }
      }
    } catch (e) {
      console.warn("logout sock err", e?.message || e);
    }

    // cancel any pending reconnect timer
    if (entry.reconnectTimer) {
      try {
        clearTimeout(entry.reconnectTimer);
      } catch { }
      entry.reconnectTimer = null;
    }

    // remove auth folder if exists
    const sessionPath = path.join(this.sessionsDir, sessionId);
    try {
      await fsPromises.rm(sessionPath, { recursive: true, force: true });
    } catch (e) { }

    // mark deleted and delete from in-memory map
    entry.deleted = true;
    entry.sock = null;
    entry.restarting = false;
    this.sessions.delete(sessionId);

    // persist (async ok)
    await this._persistMeta();

    // call db.logout once to mark blocked and clear in-memory session state
    try {
      if (this.db && typeof this.db.logout === "function") {
        await this.db.logout(sessionId);
      }
    } catch (e) {
      console.warn("db.logout failed during logout()", e?.message || e);
    }

    // emit events
    this.emit("loggedOut", sessionId);
    this.emit("session.deleted", sessionId, { reason: "client-initiated-logout" });
    return true;
  }

  isRunning(sessionId) {
    const entry = this.sessions.get(sessionId);
    return !!(entry && entry.sock);
  }

  list() {
    const out = [];
    for (const [k, v] of this.sessions.entries()) {
      out.push({
        sessionId: k,
        status: v.status,
        backoffMs: v.backoffMs,
        reconnectAttempts: v.reconnectAttempts || 0,
      });
    }
    return out;
  }

  /**
   * getAllConnections()
   * Return an array of connection info objects for external consumers (e.g., admin UIs).
   */
  getAllConnections() {
    const out = [];
    for (const [sid, entry] of this.sessions.entries()) {
      out.push({
        file_path: sid,
        connection: entry.sock || null,
        healthy: !!entry.sock,
      });
    }
    return out;
  }

  /**
   * _isPermanentDisconnect
   * Heuristics to detect a permanent logout vs transient disconnects.
   * We explicitly check for well-known HTTP auth codes (401, 403) and
   * textual reasons indicating logged out / invalid session. Everything else
   * is treated as transient so a reconnect attempt will be scheduled.
   */
  _isPermanentDisconnect(lastDisconnect) {
    if (!lastDisconnect) return false;

    // extract possible numeric status code (many libs expose it differently)
    const statusCode =
      lastDisconnect?.error?.output?.statusCode ||
      lastDisconnect?.statusCode ||
      lastDisconnect?.error?.statusCode ||
      lastDisconnect?.error?.output?.statusCode;

    // payload reason / message
    const payloadReason =
      lastDisconnect?.error?.output?.payload?.reason ||
      lastDisconnect?.error?.output?.payload?.message ||
      lastDisconnect?.error?.output?.payload?.status ||
      lastDisconnect?.reason ||
      lastDisconnect?.error?.message ||
      lastDisconnect?.message;

    // convert to string lowercased for textual checks
    const reasonStr = String(statusCode || payloadReason || "").toLowerCase();

    // If statusCode is a number — check known codes
    if (typeof statusCode === "number") {
      // some libraries use enums; check a few likely comparisons (DisconnectReason may be string/number)
      if (
        statusCode === DisconnectReason?.loggedOut ||
        statusCode === DisconnectReason?.forbidden ||
        statusCode === DisconnectReason?.badSession
      ) {
        return true;
      }
      if (statusCode === 401 || statusCode === 403) return true;
    }

    // textual checks (avoid matching plain 'logout' to reduce false positives)
    if (
      reasonStr.includes("loggedout") ||
      reasonStr.includes("logged out") ||
      reasonStr.includes("forbidden") ||
      reasonStr.includes("invalid session") ||
      reasonStr.includes("bad session") ||
      reasonStr.includes("invalid credentials") ||
      reasonStr.includes("not authorized") ||
      reasonStr.includes("unauthorized")
    ) {
      return true;
    }

    return false;
  }

  async _handleConnectionUpdate(sessionId, update) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    const { connection, lastDisconnect } = update;
    this.emit("connection.update", sessionId, update);

    // Helper: cancel reconnect timer safely
    const _clearReconnectTimer = (e) => {
      if (e?.reconnectTimer) {
        try {
          clearTimeout(e.reconnectTimer);
        } catch (ex) { }
        e.reconnectTimer = null;
      }
    };

    if (connection === "open") {
      entry.status = "connected";
      entry.backoffMs = this.defaultBackoff;
      entry.restarting = false;
      entry.reconnectAttempts = 0;
      _clearReconnectTimer(entry);
      this.sessions.set(sessionId, entry);
      // ensure saved on disk when socket actually opened
      await this._persistMeta().catch(() => { });
      this.emit("connected", sessionId);
      return;
    }

    if (connection === "close") {
      // attempt to detect permanent logout vs transient disconnect
      const isLoggedOut = this._isPermanentDisconnect(lastDisconnect);

      // logging for debugging
      try {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.statusCode;
        const payloadReason =
          lastDisconnect?.error?.output?.payload?.reason ||
          lastDisconnect?.reason ||
          lastDisconnect?.message;
        console.log(
          `[${sessionId}] connection.close: statusCode=${statusCode}`,
          "reason=",
          payloadReason
        );
      } catch (e) { }

      // If permanent logout: clean up immediately
      if (isLoggedOut) {
        try {
          _clearReconnectTimer(entry);
          entry.sock = null;
          entry.restarting = false;

          const sessionPath = path.join(this.sessionsDir, sessionId);
          await fsPromises.rm(sessionPath, { recursive: true, force: true }).catch(() => { });
          await db.setHot(sessionId, "login", false);

          // call db.logout once and handle errors gracefully
          if (this.db && typeof this.db.logout === "function") {

            await this.db.logout(sessionId).catch((e) =>
              console.warn("db.logout failed during handleConnectionUpdate", e?.message || e)
            );
          }
        } catch (e) {
          console.warn("error removing session auth dir", e?.message || e);
        }

        // remove from map and persist
        this.sessions.delete(sessionId);
        await this._persistMeta().catch(() => { });

        this.emit("session.deleted", sessionId, {
          reason:
            lastDisconnect?.error?.output?.payload?.reason ||
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.reason ||
            lastDisconnect?.message,
        });

        // also emit loggedOut for consumers that use that event
        this.emit("loggedOut", sessionId);
        return;
      }

      // Not permanent — increment reconnectAttempts and check limit
      entry.reconnectAttempts = (entry.reconnectAttempts || 0) + 1;
      this.sessions.set(sessionId, entry);

      // If user/session tried reconnecting too many times, force logout
      if (entry.reconnectAttempts >= this.reconnectLimit) {
        try {
          _clearReconnectTimer(entry);
          entry.sock = null;
          entry.restarting = false;
          const sessionPath = path.join(this.sessionsDir, sessionId);
          await fsPromises.rm(sessionPath, { recursive: true, force: true }).catch(() => { });
          if (this.db && typeof this.db.logout === "function") {
            await this.db.logout(sessionId).catch((e) =>
              console.warn("db.logout failed when exceeding reconnect limit", e?.message || e)
            );
          }
        } catch (e) {
          console.warn("error removing session auth dir (limit)", e?.message || e);
        }
        this.sessions.delete(sessionId);
        await this._persistMeta().catch(() => { });
        this.emit("session.deleted", sessionId, {
          reason: "reconnect-limit-exceeded",
        });
        this.emit("loggedOut", sessionId);
        return;
      }

      // If transient and under limit: schedule reconnect with exponential backoff
      if (!entry.restarting) {
        entry.restarting = true;
        entry.sock = null;
        entry.status = "reconnecting";
        const backoff = entry.backoffMs || this.defaultBackoff;

        const timer = setTimeout(async () => {
          try {
            // if session removed meanwhile, do not attempt start
            if (!this.sessions.has(sessionId)) return;
            const curEntry = this.sessions.get(sessionId);
            if (!curEntry) return;
            if (curEntry.status === "connected") return;
            curEntry.restarting = false;
            curEntry.backoffMs = Math.min((curEntry.backoffMs || this.defaultBackoff) * 2, this.maxBackoff);
            this.sessions.set(sessionId, curEntry);
            await this.start(sessionId);
          } catch (e) {
            console.warn(`[${sessionId}] reconnect failed`, e?.message || e);
            const cur = this.sessions.get(sessionId);
            if (cur) cur.restarting = false;
          }
        }, backoff);

        entry.reconnectTimer = timer;
        this.sessions.set(sessionId, entry);
      }
    }
  }
}