const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const EventEmitter = require('events');
const createSocketFn = require('./createSocket');
const { DisconnectReason } = require('@whiskeysockets/baileys');

// Small semaphore for concurrency control
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
    await new Promise(resolve => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.queue.length) this.queue.shift()();
  }
}

class SessionManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessions = new Map(); // sessionId => entry
    this.metaFile = path.join(process.cwd(), 'sessions.json');
    this.sessionsDir = path.join(process.cwd(), 'sessions');
    this.concurrency = opts.concurrency || 20; // how many sockets to start concurrently
    this.semaphore = new Semaphore(this.concurrency);
    this.startDelayMs = opts.startDelayMs || 200; // small delay between starts to reduce bursts
    this.defaultBackoff = opts.defaultBackoff || 1000;
    this.maxBackoff = opts.maxBackoff || 60_000;

    // load metadata (list of sessions) if present
    this._loadMeta().catch(e => console.warn('loadMeta err', e.message || e));
  }

  async _loadMeta() {
    try {
      const raw = await fsPromises.readFile(this.metaFile, 'utf-8');
      const list = JSON.parse(raw || '[]');
      for (const id of list) {
        if (!this.sessions.has(id)) {
          this.sessions.set(id, { sock: null, backoffMs: this.defaultBackoff, restarting: false, status: 'stopped' });
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('meta load error', e.message || e);
    }
  }

  async _persistMeta() {
    try {
      const list = Array.from(this.sessions.keys());
      await fsPromises.writeFile(this.metaFile, JSON.stringify(list, null, 2), 'utf-8');
    } catch (e) {
      console.warn('meta persist error', e.message || e);
    }
  }

  // register a session ID (does not start socket)
  register(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { sock: null, backoffMs: this.defaultBackoff, restarting: false, status: 'stopped' });
      this._persistMeta();
    }
  }

  unregister(sessionId) {
    this.sessions.delete(sessionId);
    this._persistMeta();
  }

  // Start single session (idempotent)
  async start(sessionId) {
    this.register(sessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('failed to register');
    if (entry.sock) return entry.sock; // already running

    await this.semaphore.acquire();
    try {
      // create socket
      entry.status = 'starting';
      const sock = await createSocketFn(sessionId);
      entry.sock = sock;
      entry.status = 'connected';
      entry.restarting = false;
      entry.backoffMs = this.defaultBackoff;

      // minimal listeners: forward relevant events for plugins
      sock.ev.on('messages.upsert', m => {
        // don't keep message bodies in memory; emit immediately
        this.emit('messages.upsert', sessionId, m);
      });

      // group updates and participants
      sock.ev.on('groups.update', up => this.emit('groups.update', sessionId, up));
      sock.ev.on('group-participants.update', up => this.emit('group-participants.update', sessionId, up));

      // creds and connection updates
      sock.ev.on('creds.update', up => this.emit('creds.update', sessionId, up));
      sock.ev.on('connection.update', update => this._handleConnectionUpdate(sessionId, update));

      // optional: other light events
      // sock.ev.on('contacts.update', up => this.emit('contacts.update', sessionId, up));

      // save back
      this.sessions.set(sessionId, entry);
      return sock;
    } finally {
      // small delay to avoid burst
      await new Promise(r => setTimeout(r, this.startDelayMs));
      this.semaphore.release();
    }
  }

  // Start all registered sessions (staggered, concurrent)
  async startAll() {
    const keys = Array.from(this.sessions.keys());
    const tasks = keys.map(async (sid) => {
      try { await this.start(sid); } catch (e) { console.warn('startAll error', sid, e?.message || e); }
    });
    // run with concurrency using semaphore
    // we will sequentially await small batches to avoid make too many promises at once
    const concurrency = this.concurrency;
    for (let i = 0; i < tasks.length; i += concurrency) {
      const chunk = tasks.slice(i, i + concurrency);
      await Promise.all(chunk.map(fn => fn()));
    }
  }

  async stop(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.sock) return false;
    try {
      entry.status = 'stopping';
      try { entry.sock.ws.close(); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
    entry.sock = null;
    entry.status = 'stopped';
    this.sessions.set(sessionId, entry);
    return true;
  }

  // logout: call socket.logout() if available, then delete auth folder, remove metadata
  async logout(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    try {
      if (entry.sock && typeof entry.sock.logout === 'function') {
        await entry.sock.logout();
      } else if (entry.sock && entry.sock.ws) {
        try { entry.sock.ws.close(); } catch (e) {}
      }
    } catch (e) { console.warn('logout sock err', e?.message || e); }

    // delete auth folder
    const sessionPath = path.join(this.sessionsDir, sessionId);
    try { await fsPromises.rm(sessionPath, { recursive: true, force: true }); } catch (e) {}

    // remove from map & persist
    this.sessions.delete(sessionId);
    await this._persistMeta();
    this.emit('loggedOut', sessionId);
    return true;
  }

  isRunning(sessionId) {
    const entry = this.sessions.get(sessionId);
    return !!(entry && entry.sock);
  }

  list() {
    const out = [];
    for (const [k, v] of this.sessions.entries()) {
      out.push({ sessionId: k, status: v.status, backoffMs: v.backoffMs });
    }
    return out;
  }

  // Private: handle connection updates and decide reconnect or permanent failure
  async _handleConnectionUpdate(sessionId, update) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) this.emit('qr', sessionId, qr);
    this.emit('connection.update', sessionId, update);

    if (connection === 'open') {
      entry.status = 'connected';
      entry.backoffMs = this.defaultBackoff;
      entry.restarting = false;
      this.sessions.set(sessionId, entry);
      this.emit('connected', sessionId);
      return;
    }

    if (connection === 'close') {
      // derive reason
      let reason = null;
      try {
        reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.output?.payload?.reason || null;
      } catch (e) { reason = null; }

      // normalize reason checks
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const payloadReason = lastDisconnect?.error?.output?.payload?.reason;

      const isLoggedOut = statusCode === 401 || payloadReason === 'loggedOut' || payloadReason === 'logout' || String(reason).toLowerCase().includes('loggedout') || String(payloadReason).toLowerCase().includes('loggedout') || String(payloadReason).toLowerCase().includes('forbidden');

      if (isLoggedOut) {
        // permanent: delete auth & remove
        console.log(`[${sessionId}] permanent disconnect (${statusCode || payloadReason}). Cleaning session.`);
        try {
          const sessionPath = path.join(this.sessionsDir, sessionId);
          await fsPromises.rm(sessionPath, { recursive: true, force: true });
        } catch (e) {}
        this.sessions.delete(sessionId);
        await this._persistMeta();
        this.emit('session.deleted', sessionId, { reason: payloadReason || statusCode });
        return;
      }

      // otherwise transient -> auto reconnect with exponential backoff
      if (!entry.restarting) {
        entry.restarting = true;
        entry.sock = null; // clear socket ref for GC
        entry.status = 'reconnecting';
        const backoff = entry.backoffMs || this.defaultBackoff;
        console.log(`[${sessionId}] transient disconnect, will reconnect in ${backoff}ms`);
        setTimeout(async () => {
          try {
            entry.restarting = false;
            entry.backoffMs = Math.min((entry.backoffMs || this.defaultBackoff) * 2, this.maxBackoff);
            await this.start(sessionId);
            console.log(`[${sessionId}] reconnect attempt finished`);
          } catch (e) {
            console.warn(`[${sessionId}] reconnect failed`, e?.message || e);
            entry.restarting = false;
          }
        }, backoff);
      }
    }
  }
}

module.exports = SessionManager;
