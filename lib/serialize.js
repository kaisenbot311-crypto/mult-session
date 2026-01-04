// serialize.js
import {
  getContentType,
  downloadContentFromMessage,
  jidNormalizedUser,
  areJidsSameUser,
  extractMessageContent,
} from "@whiskeysockets/baileys";
import { Jimp } from "jimp";
const CLEANUP_MS = Number(process.env.SERIALIZER_RAW_TTL_MS) || 5_000;
const MAX_BODY_LENGTH = Number(process.env.SERIALIZER_MAX_BODY_LEN) || 2000;
const METADATA_CACHE_TTL_MS = Number(process.env.SERIALIZER_METADATA_TTL_MS) || 10_000; // default 10s
const metadataCache = new Map(); // key: groupJid -> { md, expires }
 


const JPEG = "image/jpeg";

export async function makePp(buf) {
  const img = await Jimp.read(buf);

  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const crop = img.clone().crop({ x: 0, y: 0, w, h });

  const imgBuf = await crop
    .clone()
    .scaleToFit({ w: 324, h: 720 })
    .getBuffer(JPEG);

  const prevBuf = await crop
    .clone()
    .normalize()
    .getBuffer(JPEG);

  return {
    img: imgBuf,
    prev: prevBuf
  };
}
class MsgWrapper {
  constructor({ raw, conn, sessionId, key, from, fromMe, isFromMe, sender, isGroup, pushName, type, body, content, quoted, mentions }) {
    this.raw = raw;
    this.mek = raw;
    this.client = conn;
    this.conn = conn;
    this.key = key;
    this.bot = jidNormalizedUser(conn?.user?.id || "");
    this.id = key.id;
    this.from = from;
    this.fromMe = fromMe;
    this.sender = sender;
    this.isGroup = isGroup;
    this.isFromMe = isFromMe;
    this.isfromMe = isFromMe;
    this.pushName = pushName;
    this.type = type;
    this.body = body;
    this.content = content;
    this.quoted = quoted;
    this.mentions = mentions;
    this._createdAt = Date.now();
    this._sessionId = sessionId;
    this.botJid = this.bot;
    this.botnum = this.bot.split("@")[0];
    // schedule raw cleanup
    if (CLEANUP_MS > 0) {
      const t = setTimeout(() => { try { this.discardRaw(); } catch (e) { } }, CLEANUP_MS);
      if (t && t.unref) t.unref();
    }
  }
  // small utilities
  botJid() {
    try { return jidNormalizedUser(this.conn?.user?.id || ""); } catch { return null; }
  }
  botnum() {
    try { const b = this.botJid() || ""; return b.split("@")[0]; } catch { return null; }
  }
  /* async loadGroupInfo() {
     if (!this.isGroup) return this;
     try {
       // fetch group metadata directly from connection (no cache)
       const md = typeof this.conn.groupMetadata === "function" ? await this.conn.groupMetadata(this.from) : (this.conn.groupMetadata || null);
       this.groupMetadata = md || {};
       let participants = [];
       if (Array.isArray(md?.participants)) participants = md.participants;
       else if (Array.isArray(md?.adminIds)) participants = md.adminIds.map((id) => ({ id, isAdmin: true }));
       this.groupParticipants = participants || [];
       this.groupAdmins = (this.groupParticipants || []).filter(p => p && (p.isAdmin === true || p.admin === 'admin' || p.admin === 'superadmin')).map(p => jidNormalizedUser(p.id));
       this.groupOwner = this.groupMetadata?.owner ? jidNormalizedUser(this.groupMetadata.owner) : this.groupAdmins[0] || null;
       this.joinApprovalMode = this.groupMetadata?.joinApprovalMode || false;
       this.memberAddMode = this.groupMetadata?.memberAddMode || false;
       this.announce = this.groupMetadata?.announce || false;
       this.restrict = this.groupMetadata?.restrict || false;
       const botJid = jidNormalizedUser(this.conn.user.id);
       const botLid = jidNormalizedUser(this.conn.user.lid);
       this.isAdmin = (this.groupAdmins || []).some((adminId) => areJidsSameUser(adminId, this.sender));
       this.isBotAdmin = (this.groupAdmins || []).some((adminId) => (botJid && areJidsSameUser(adminId, botJid)) || (botLid && areJidsSameUser(adminId, botLid)));
     } catch (err) {
       console.error('Error loading group info:', err);
     }
     return this;
   }
   */

  async loadGroupInfo() {
    if (!this.isGroup) return this;
    try {
      const now = Date.now();
      const cacheKey = this.from;
      const cached = metadataCache.get(cacheKey);
      let md = null;
      if (cached && cached.expires > now && cached.md) {
        md = cached.md;
      } else {
        try {
          md = typeof this.conn.groupMetadata === "function"
            ? await this.conn.groupMetadata(this.from)
            : (this.conn.groupMetadata || null);
        } catch (e) {
          md = null;
        }
        if (md) {
          try {
            metadataCache.set(cacheKey, { md, expires: now + METADATA_CACHE_TTL_MS });
          } catch (e) {
            // ignore cache set errors
          }
        } else {
          try { metadataCache.delete(cacheKey); } catch (e) { }
        }
      }
      this.groupMetadata = md || {};
      let participants = [];
      if (Array.isArray(md?.participants)) participants = md.participants;
      else if (Array.isArray(md?.adminIds)) participants = md.adminIds.map((id) => ({ id, isAdmin: true }));
      this.groupParticipants = participants || [];
      this.groupAdmins = (this.groupParticipants || [])
        .filter(p => p && (p.isAdmin === true || p.admin === 'admin' || p.admin === 'superadmin'))
        .map(p => jidNormalizedUser(typeof p === 'string' ? p : (p.id || p)));
      this.groupOwner = this.groupMetadata?.owner ? jidNormalizedUser(this.groupMetadata.owner) : this.groupAdmins[0] || null;
      this.joinApprovalMode = this.groupMetadata?.joinApprovalMode || false;
      this.memberAddMode = this.groupMetadata?.memberAddMode || false;
      this.announce = this.groupMetadata?.announce || false;
      this.restrict = this.groupMetadata?.restrict || false;
      const botJid = this.conn?.user?.id ? jidNormalizedUser(this.conn.user.id) : null;
      const botLid = this.conn?.user?.lid ? jidNormalizedUser(this.conn.user.lid) : null;
      const senderId = this.sender || null;
      this.isAdmin = (this.groupAdmins || []).some((adminId) => areJidsSameUser(adminId, senderId));
      this.isBotAdmin = (this.groupAdmins || []).some((adminId) =>
        (botJid && areJidsSameUser(adminId, botJid)) || (botLid && areJidsSameUser(adminId, botLid))
      );

    } catch (err) {
      console.error('Error loading group info:', err);
    }
    return this;
  }
  async _refreshCache() { // kept name for compatibility: re-fetch group info directly
    try { await this.loadGroupInfo(); } catch (e) { }
  }
  // group helpers (keep original semantics)
  async muteGroup() { try { const res = await this.conn.groupSettingUpdate(this.from, 'announcement'); await this._refreshCache(); return res; } catch (e) { console.error('Error muting group:', e); return null; } }
  async unmuteGroup() { try { const res = await this.conn.groupSettingUpdate(this.from, 'not_announcement'); await this._refreshCache(); return res; } catch (e) { console.error('Error unmuting group:', e); return null; } }
  async setSubject(text) { try { const res = await this.conn.groupUpdateSubject(this.from, text); await this._refreshCache(); return res; } catch (e) { console.error('Error updating subject:', e); return null; } }
  async setDescription(text) { try { const res = await this.conn.groupUpdateDescription(this.from, text); await this._refreshCache(); return res; } catch (e) { console.error('Error updating description:', e); return null; } }
  async addParticipant(jid) { try { const jids = Array.isArray(jid) ? jid : [jid]; const normalized = jids.map(j => jidNormalizedUser(j)); const res = await this.conn.groupParticipantsUpdate(this.from, normalized, 'add'); await this._refreshCache(); return res; } catch (e) { console.error('Error adding participant:', e); return null; } }
  async removeParticipant(jid) { try { const jids = Array.isArray(jid) ? jid : [jid]; const normalized = jids.map(j => jidNormalizedUser(j)); const res = await this.conn.groupParticipantsUpdate(this.from, normalized, 'remove'); await this._refreshCache(); return res; } catch (e) { console.error('Error removing participant:', e); return null; } }
  async promoteParticipant(jid) { try { const jids = Array.isArray(jid) ? jid : [jid]; const normalized = jids.map(j => jidNormalizedUser(j)); const res = await this.conn.groupParticipantsUpdate(this.from, normalized, 'promote'); await this._refreshCache(); return res; } catch (e) { console.error('Error promoting participant:', e); return null; } }
  async demoteParticipant(jid) { try { const jids = Array.isArray(jid) ? jid : [jid]; const normalized = jids.map(j => jidNormalizedUser(j)); const res = await this.conn.groupParticipantsUpdate(this.from, normalized, 'demote'); await this._refreshCache(); return res; } catch (e) { console.error('Error demoting participant:', e); return null; } }
  async leaveGroup() { try { const res = await this.conn.groupLeave(this.from); return res; } catch (e) { console.error('Error leaving group:', e); return null; } }
  async inviteCode() { try { return await this.conn.groupInviteCode(this.from); } catch (e) { console.error('Error getting invite code:', e); return null; } }
  async revokeInvite() { try { const res = await this.conn.groupRevokeInvite(this.from); await this._refreshCache(); return res; } catch (e) { console.error('Error revoking invite:', e); return null; } }
  async getInviteInfo(code) { try { return await this.conn.groupGetInviteInfo(code); } catch (e) { console.error('Error getting invite info:', e); return null; } }
  async joinViaInvite(code) { try { return await this.conn.groupAcceptInvite(code); } catch (e) { console.error('Error joining via invite:', e); return null; } }
  async getJoinRequests() { try { return await this.conn.groupRequestParticipantsList(this.from); } catch (e) { console.error('Error getting join requests:', e); return null; } }
  async updateJoinRequests(jids, action = 'approve') { try { const normalized = Array.isArray(jids) ? jids.map(j => jidNormalizedUser(j)) : [jidNormalizedUser(jids)]; const res = await this.conn.groupRequestParticipantsUpdate(this.from, normalized, action); await this._refreshCache(); return res; } catch (e) { console.error('Error updating join requests:', e); return null; } }
  async setMemberAddMode(enable = true) { try { try { const attempt = await this.conn.groupSettingUpdate(this.from, enable ? 'member_add_mode' : 'not_member_add_mode'); await this._refreshCache(); return attempt; } catch (e) { const fallback = await this.conn.groupSettingUpdate(this.from, enable ? 'not_announcement' : 'announcement'); await this._refreshCache(); return fallback; } } catch (e) { console.error('Error setting member add mode:', e); return null; } }
  // status/profile/block helpers
  async fetchStatus(jid) { try { return await this.conn.fetchStatus(jidNormalizedUser(jid)); } catch (e) { console.error('Error fetching status:', e); return null; } }
  async profilePictureUrl(jid, type = 'image') { try { return await this.conn.profilePictureUrl(jidNormalizedUser(jid), type); } catch (e) { console.error('Error getting profile picture:', e); return null; } }
  async blockUser(jid) { try { return await this.conn.updateBlockStatus(jidNormalizedUser(jid), 'block'); } catch (e) { console.error('Error blocking user:', e); return null; } }
  async unblockUser(jid) { try { return await this.conn.updateBlockStatus(jidNormalizedUser(jid), 'unblock'); } catch (e) { console.error('Error unblocking user:', e); return null; } }
  getParticipants() { return this.groupParticipants || []; }
  isParticipant(jid) { const normalized = jidNormalizedUser(jid); return this.getParticipants().some((p) => { const pid = typeof p === 'string' ? p : p?.id || p; return areJidsSameUser(jidNormalizedUser(pid), normalized); }); }
  async download() { try { if (!this.content) return null; const stream = await downloadContentFromMessage(this.content, this.type.replace('Message', '')); const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); } catch (e) { console.error('Error downloading media:', e); return null; } }
  async send(payload, options = {}) { try { if (payload?.delete) return await this.conn.sendMessage(this.from, { delete: payload.delete }); let cend; if (typeof payload === 'string') cend = { text: payload }; else if (payload.video) cend = { video: payload.video, caption: payload.caption || '', mimetype: payload.mimetype || 'video/mp4' }; else if (payload.image) cend = { image: payload.image, caption: payload.caption || '' }; else if (payload.audio) cend = { audio: payload.audio, mimetype: payload.mimetype || 'audio/mp4', ptt: payload.ptt || false }; else cend = payload; if (options.mentions) cend.mentions = options.mentions; if (options.edit) cend.edit = options.edit; return await this.conn.sendMessage(this.from, cend, { quoted: options.quoted }); } catch (e) { console.error('Error sending message:', e); return null; } }
  async react(emoji) { try { return await this.conn.sendMessage(this.from, { react: { text: emoji, key: this.key } }); } catch (e) { console.error('Error reacting:', e); return null; } }
  async replyMethod(payload, options = {}) { try { if (payload?.delete) return await this.conn.sendMessage(this.from, { delete: payload.delete }); let cend; if (typeof payload === 'string') cend = { text: payload }; else if (payload.video) cend = { video: payload.video, caption: payload.caption || '', mimetype: payload.mimetype || 'video/mp4' }; else if (payload.image) cend = { image: payload.image, caption: payload.caption || '' }; else if (payload.audio) cend = { audio: payload.audio, mimetype: payload.mimetype || 'audio/mp4', ptt: payload.ptt || false }; else cend = payload; if (options.mentions) cend.mentions = options.mentions; if (options.edit) cend.edit = options.edit; return await this.conn.sendMessage(this.from, cend, { quoted: this.raw }); } catch (e) { console.error('Error sending reply:', e); return null; } }
  sendreply(payload, options = {}) { return this.replyMethod(payload, options); }
  sendReply(payload, options = {}) { return this.replyMethod(payload, options); }
  reply(payload, options = {}) { return this.replyMethod(payload, options); }
  async setPp(jid, buf) { try { const img = await makePp(buf); if (typeof this.conn.updateProfilePicture === 'function') { try { await this.conn.updateProfilePicture(jidNormalizedUser(jid), img); } catch (e) { } } if (typeof this.conn.query === 'function') { await this.conn.query({ tag: 'iq', attrs: { to: jidNormalizedUser(jid), type: 'set', xmlns: 'w:profile:picture' }, content: [{ tag: 'picture', attrs: { type: 'image' }, content: img }] }); } try { await this._refreshCache(); } catch { } return true; } catch (e) { console.error('Error setting profile picture:', e); return null; } }
  async getLID(phoneNumber) { try { if (!this.conn.signalRepository?.lidMapping) return null; return await this.conn.signalRepository.lidMapping.getLIDForPN(phoneNumber); } catch (e) { console.error('Error getting LID:', e); return null; } }
  async getPN(lid) { try { if (!this.conn.signalRepository?.lidMapping) return null; return await this.conn.signalRepository.lidMapping.getPNForLID(lid); } catch (e) { console.error('Error getting PN:', e); return null; } }
  isPnUser(jid) { return jid?.includes('@s.whatsapp.net') || false; }
  isLidUser(jid) { return jid?.includes('@lid') || false; }
  areJidsSame(jid1, jid2) { return areJidsSameUser(jidNormalizedUser(jid1), jidNormalizedUser(jid2)); }
  discardRaw() { try { if (this.raw) delete this.raw; if (this.mek) delete this.mek; if (this.quoted && typeof this.quoted === 'object') delete this.quoted.msg; } catch (e) { } }
  getRaw() { return this.raw; }
}
export default class Serializer {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }
  serializeSync(msg) {
    const conn = this.conn;
    const key = msg.key || {};
    const from = key.remoteJid || key.remoteJidAlt || "";
    const fromMe = key.fromMe || false;
    const sender = jidNormalizedUser(key.participant || key.participantAlt || from || "");
    const isGroup = String(from || "").endsWith("@g.us");
    const pushName = msg.pushName || "Unknown";
    const messageContent = extractMessageContent(msg.message);
    const type = getContentType(messageContent || msg.message);
    const content = messageContent?.[type] || msg.message?.[type];
    const isFromMe =
      fromMe ||
      areJidsSameUser(sender, jidNormalizedUser(conn?.user?.id)) ||
      (conn?.user?.lid && areJidsSameUser(sender, jidNormalizedUser(conn?.user?.lid)));
    const body = (function () {
      if (!content) return "";
      const raw =
        type === "conversation" ? content
          : type === "extendedTextMessage" ? content.text
            : type === "imageMessage" && content.caption ? content.caption
              : type === "videoMessage" && content.caption ? content.caption
                : type === "templateButtonReplyMessage" ? content.selectedDisplayText
                  : type === "buttonsResponseMessage" ? content.selectedButtonId
                    : type === "listResponseMessage" ? content.singleSelectReply?.selectedRowId
                      : "";
      return typeof raw === "string" ? raw.slice(0, MAX_BODY_LENGTH) : "";
    })();
    const quoted = (function () {
      const context = msg.message?.extendedTextMessage?.contextInfo;
      const quotedMsg = context?.quotedMessage;
      if (!quotedMsg) return null;
      const qt = getContentType(quotedMsg);
      const qContent = quotedMsg[qt];
      const b =
        qt === "conversation" ? qContent
          : qt === "extendedTextMessage" ? qContent.text || ""
            : qt === "imageMessage" ? qContent.caption || ""
              : qt === "videoMessage" ? qContent.caption || ""
                : qt === "templateButtonReplyMessage" ? qContent.selectedDisplayText || ""
                  : qt === "buttonsResponseMessage" ? qContent.selectedButtonId || ""
                    : qt === "listResponseMessage" ? qContent.singleSelectReply?.selectedRowId || ""
                      : "";
      const quotedParticipant = jidNormalizedUser(context?.participant || context?.participantAlt || from || "");
      const isQuotedFromMe =
        areJidsSameUser(quotedParticipant, jidNormalizedUser(conn?.user?.id || "")) ||
        (conn?.user?.lid && areJidsSameUser(quotedParticipant, jidNormalizedUser(conn?.user?.lid || "")));
      return {
        type: qt,
        msg: typeof qContent === "object" ? { ...qContent } : qContent,
        body: typeof b === "string" ? b.slice(0, MAX_BODY_LENGTH) : "",
        fromMe: isQuotedFromMe,
        participant: quotedParticipant,
        id: context?.stanzaId,
        key: {
          remoteJid: from,
          fromMe: isQuotedFromMe,
          id: context?.stanzaId,
          participant: quotedParticipant,
        },
        download: async () => {
          try { const stream = await downloadContentFromMessage(qContent, qt.replace('Message', '')); const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); } catch (err) { console.error('Error downloading quoted media:', err); return null; }
        }
      };
    })();
    const msgObj = new MsgWrapper({ raw: msg, conn, sessionId: this.sessionId, key, from, fromMe, isFromMe, sender, isGroup, pushName, type, body, content, quoted, mentions: msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [] });
    return msgObj;
  }
}