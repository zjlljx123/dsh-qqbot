/**
 * IM bridge orchestrator: routes QQ / WeChat messages into per-chat DSH
 * sessions, feeds replies back, and handles file send (/send) + file receive.
 *
 * Every entry point is wrapped so a bridge failure never crashes DSH.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { DshSessionManager } from "./dsh-session.js";
import { QQClient } from "./qq-client.js";
import { WcfClient } from "./wcf-client.js";
import { Logger } from "./logger.js";
import { chunkText, materializeFile, parseCqString, resolveSendPath } from "./util.js";

export class ImBridge {
  static async create(ctx, cfg) {
    const log = new Logger(cfg.logLevel || "info");
    const dsh = new DshSessionManager(ctx, cfg, log);
    const bridge = new ImBridge(cfg, log, dsh);
    await dsh.init().catch((e) => {
      log.error("DSH 会话管理器初始化失败，IM 桥接停用：", e.message);
      throw e;
    });
    await bridge._startPlatforms();
    return bridge;
  }

  constructor(cfg, log, dsh) {
    this.cfg = cfg;
    this.log = log;
    this.dsh = dsh;
    this.qq = null;
    this.wcf = null;
    this._busy = new Map(); // chatKey -> boolean
    this._queues = new Map(); // chatKey -> pending inbound chats
  }

  async _startPlatforms() {
    const qqCfg = this.cfg.qq || {};
    if (this.cfg.qq?.enabled !== false && qqCfg.enabled !== false) {
      this.qq = new QQClient({
        wsUrl: qqCfg.wsUrl || "ws://127.0.0.1:3001",
        accessToken: qqCfg.accessToken || "",
        logger: this.log,
      });
      this.qq.on("event", (ev) => this._safe("qq event", () => this.handleQqEvent(ev)));
      this.qq.on("status", (s) => this.log.info(`QQ 状态: ${s.connected ? "已连接" : "已断开"}`));
      this.qq.start().catch((e) => this.log.warn("QQ 客户端启动失败:", e.message));
    } else {
      this.log.info("QQ 桥接已禁用");
    }

    const wxCfg = this.cfg.wechat || {};
    if (this.cfg.wechat?.enabled !== false && wxCfg.enabled !== false) {
      this.wcf = new WcfClient({
        host: wxCfg.host || "127.0.0.1",
        port: wxCfg.port || 10086,
        logger: this.log,
      });
      this.wcf.on("message", (m) => this._safe("wechat message", () => this.handleWxMsg(m)));
      this.wcf.on("status", (s) => this.log.info(`微信状态: ${s.connected ? "已连接" : "已断开"}`));
      this.wcf.start().catch((e) => this.log.warn("微信客户端启动失败:", e.message));
    } else {
      this.log.info("微信桥接已禁用");
    }
  }

  _safe(label, fn) {
    try {
      const ret = fn();
      if (ret && typeof ret.catch === "function") {
        ret.catch((e) => this.log.error(`${label} 失败:`, e.message || e));
      }
    } catch (e) {
      this.log.error(`${label} 失败:`, e.message || e);
    }
  }

  /* ================================================================== */
  /* QQ (OneBot v11)                                                     */
  /* ================================================================== */

  async handleQqEvent(ev) {
    if (ev.post_type !== "message") return;
    const cfg = this.cfg.qq || {};
    const isGroup = ev.message_type === "group";
    const chatId = isGroup ? String(ev.group_id) : String(ev.user_id);
    const senderId = String(ev.user_id);
    const chatKey = isGroup ? `qq:group:${chatId}` : `qq:private:${chatId}`;
    const segments = Array.isArray(ev.message)
      ? ev.message
      : typeof ev.message === "string"
        ? parseCqString(ev.message)
        : [];

    // mention detection for groups
    let mentioned = false;
    if (isGroup) {
      const selfId = cfg.selfId || this.qq?.selfId;
      mentioned = segments.some(
        (s) => s.type === "at" && String(s.data?.qq) === String(selfId)
      );
    }

    const parts = [];
    const inbound = []; // {kind:'file'|'image', url?, localPath?, name?}
    for (const s of segments) {
      switch (s.type) {
        case "text":
          if (s.data?.text) parts.push(s.data.text);
          break;
        case "at":
          if (String(s.data?.qq) !== String(cfg.selfId || this.qq?.selfId)) {
            parts.push(`@${s.data?.name || s.data?.qq || ""}`);
          }
          break;
        case "image":
          parts.push("[图片]");
          inbound.push({ kind: "image", url: s.data?.url, localPath: s.data?.file, name: s.data?.file || "image" });
          break;
        case "file":
          parts.push(`[文件${s.data?.name ? `:${s.data.name}` : ""}]`);
          inbound.push({ kind: "file", url: s.data?.url, localPath: s.data?.file, name: s.data?.name || "file" });
          break;
        case "face":
          parts.push("[表情]");
          break;
        case "reply":
          parts.push("[引用消息]");
          break;
        default:
          // record/at-all/video/voice etc. -> keep a marker only
          if (s.type && s.type !== "text") parts.push(`[${s.type}]`);
      }
    }
    const text = parts.join("").trim();
    if (!text && inbound.length === 0) return;

    const chat = {
      platform: "qq",
      chatKey,
      chatId,
      isGroup,
      senderId,
      senderName: ev.sender?.card || ev.sender?.nickname || senderId,
      text,
      inbound,
      mentioned,
      raw: ev,
    };
    await this._handleInbound(chat);
  }

  /* ================================================================== */
  /* WeChat (WeChatFerry)                                                */
  /* ================================================================== */

  async handleWxMsg(msg) {
    if (!msg || msg.is_self) return;
    const cfg = this.cfg.wechat || {};
    const isGroup = msg.is_group;
    const chatId = isGroup ? msg.roomid : msg.sender;
    if (!chatId) return;
    const chatKey = isGroup ? `wx:room:${chatId}` : `wx:private:${chatId}`;

    const inbound = [];
    let text = "";
    switch (msg.type) {
      case 1: // text
        text = msg.content || "";
        break;
      case 3: { // image
        text = "[图片]";
        inbound.push({ kind: "image", msg });
        break;
      }
      case 34:
        text = "[语音]";
        break;
      case 43:
        text = "[视频]";
        break;
      case 49: { // app message: file / link / card
        const meta = parseAppMsg(msg.xml || "");
        if (meta.isFile) {
          text = `[文件${meta.title ? `:${meta.title}` : ""}]`;
          inbound.push({ kind: "file", msg, title: meta.title });
        } else if (meta.url) {
          text = `[链接: ${meta.title || ""} ${meta.url}]`.trim();
        } else {
          text = msg.content || "[应用消息]";
        }
        break;
      }
      default:
        return; // system / friend requests / transfer etc. -> ignore
    }

    if (!text && inbound.length === 0) return;

    // mention detection for rooms: keyword, or "@ + bot name"
    let mentioned = false;
    if (isGroup && cfg.requireMention) {
      const content = msg.content || "";
      if (cfg.triggerKeyword) {
        mentioned = content.includes(cfg.triggerKeyword);
      } else {
        mentioned = content.includes("@") && content.includes(this.wcf?.self?.name || "@");
      }
    }

    const chat = {
      platform: "wechat",
      chatKey,
      chatId,
      isGroup,
      senderId: msg.sender,
      senderName: msg.sender,
      text,
      inbound,
      mentioned,
      raw: msg,
    };
    await this._handleInbound(chat);
  }

  /* ================================================================== */
  /* inbound pipeline                                                    */
  /* ================================================================== */

  async _handleInbound(chat) {
    const pcfg = chat.platform === "qq" ? this.cfg.qq || {} : this.cfg.wechat || {};
    try {
      // 1. access control
      if (!this._isAllowed(chat, pcfg)) return;

      // 2. group mention/trigger policy
      if (chat.isGroup && pcfg.requireMention && !chat.mentioned) return;

      // 3. per-chat serialization: queue while a turn is running
      if (this._busy.get(chat.chatKey)) {
        const q = this._queues.get(chat.chatKey) || [];
        if (q.length < 20) q.push(chat);
        this._queues.set(chat.chatKey, q);
        return;
      }
      this._busy.set(chat.chatKey, true);
      try {
        await this._processChat(chat, pcfg);
      } catch (e) {
        this.log.error(`处理 ${chat.chatKey} 消息失败:`, e.message || e);
        await this._sendText(chat, "（处理消息时出错，请稍后再试）").catch(() => {});
      } finally {
        this._busy.delete(chat.chatKey);
        const q = this._queues.get(chat.chatKey);
        if (q && q.length > 0) {
          const next = q.shift();
          this._queues.set(chat.chatKey, q);
          this._safe("queued message", () => this._handleInbound(next));
        }
      }
    } catch (e) {
      this.log.error(`处理 ${chat.chatKey} 消息失败:`, e.message || e);
      await this._sendText(chat, "（处理消息时出错，请稍后再试）").catch(() => {});
    }
  }

  _isAllowed(chat, pcfg) {
    const admins = pcfg.admins || [];
    const allowed = pcfg.allowedChats || [];
    const blocked = pcfg.blockedChats || [];
    if (blocked.includes(chat.chatId)) return false;
    if (allowed.length > 0 && !allowed.includes(chat.chatId)) return false;
    if (pcfg.adminOnly && !admins.includes(chat.senderId)) return false;
    return true;
  }

  async _processChat(chat, pcfg) {
    // chat commands
    const cmd = chat.text.match(/^\/(help|status|reset)\b/);
    if (cmd) {
      await this._runCommand(chat, pcfg, cmd[1]);
      return;
    }

    // ensure DSH session
    const mapping = await this.dsh.ensureChat(chat.chatKey);

    // materialize inbound files into the chat workspace inbox
    const files = [];
    for (const f of chat.inbound || []) {
      const saved = await this._materializeInbound(chat, mapping, f);
      if (saved) files.push(saved);
    }

    // build the prompt
    const lines = [];
    if (this.cfg.systemHint) lines.push(this.cfg.systemHint);
    if (files.length > 0) {
      lines.push("用户发来了文件：");
      for (const f of files) lines.push(`- ${f.path}（${f.name}）`);
    }
    if (chat.text) lines.push(chat.text);
    const promptText = lines.join("\n").trim();

    this.log.info(`[${chat.platform}] ${chat.chatKey} -> agent (${mapping.sessionId})`);

    const result = await this.dsh.sendPrompt(mapping.sessionId, promptText);
    const replyText = extractReplyText(result.events, result.turnEnd);
    const turnEnd = result.turnEnd?.data || {};

    // error / aborted turns
    if (turnEnd.kind === "error") {
      const msg = `（处理出错：${truncate(turnEnd.error?.message || "未知错误", 300)}）`;
      await this._sendText(chat, msg);
      return;
    }
    if (turnEnd.kind === "aborted") {
      await this._sendText(chat, "（处理被中断）");
      return;
    }

    // split out /send file commands
    const { sends, text } = extractSendCommands(replyText);

    // send text (chunked)
    if (text) {
      for (const chunk of chunkText(text, pcfg.maxMessageChars || 2000)) {
        const ok = await this._sendText(chat, chunk);
        if (!ok) {
          this.log.warn(`发送文本失败 ${chat.chatKey} (${chunk.slice(0, 40)}…)`);
          break;
        }
      }
    }

    // send files
    const failed = [];
    for (const raw of sends) {
      const abs = resolveSendPath(raw, mapping.cwd);
      if (!abs) {
        failed.push(`${raw}（文件不存在）`);
        continue;
      }
      const ok = await this._sendFile(chat, abs);
      if (!ok) failed.push(`${raw}（发送失败）`);
      else this.log.info(`[${chat.platform}] 已发送文件 ${abs}`);
    }
    if (failed.length > 0) {
      await this._sendText(chat, `文件发送失败：${failed.join("；")}`).catch(() => {});
    }
  }

  async _runCommand(chat, pcfg, name) {
    const admins = pcfg.admins || [];
    const isAdmin = admins.includes(chat.senderId) || admins.length === 0;
    switch (name) {
      case "help":
        await this._sendText(chat, "可用命令：/help 帮助；/status 状态；/reset 重置本会话（仅管理员）。\n让 agent 发文件：在回复中写 /send <绝对路径>。");
        break;
      case "status": {
        let s = `平台: ${chat.platform}\n会话: ${chat.chatKey}\n`;
        if (chat.platform === "qq") s += `QQ 连接: ${this.qq?.connected ? "已连接" : "未连接"}\n`;
        else s += `微信连接: ${this.wcf?.connected ? "已连接" : "未连接"}\n`;
        const m = this.dsh.chats[chat.chatKey];
        s += m ? `DSH 会话: ${m.sessionId}\n工作目录: ${m.cwd}` : "DSH 会话: （尚未创建）";
        await this._sendText(chat, s);
        break;
      }
      case "reset":
        if (!isAdmin) {
          await this._sendText(chat, "仅管理员可重置会话");
          return;
        }
        await this.dsh.resetChat(chat.chatKey);
        await this._sendText(chat, "本会话已重置，下一条消息将开启全新会话。");
        break;
    }
  }

  /* ---------------- inbound file materialization ---------------- */

  async _materializeInbound(chat, mapping, f) {
    const inboxDir = join(mapping.cwd, "inbox");
    if (chat.platform === "qq") {
      const saved = await materializeFile({
        url: f.url,
        localPath: f.localPath,
        name: f.name,
        dir: inboxDir,
      });
      if (saved) return { path: saved, name: f.name || "file" };
      this.log.warn(`QQ 入站文件落盘失败 (${f.name || f.url || f.localPath})`);
      return null;
    }
    // wechat
    try {
      const msg = f.msg;
      if (!msg) return null;
      await mkdir(inboxDir, { recursive: true });
      if (f.kind === "image") {
        const ok = await this.wcf.downloadAttach(msg.id, msg.thumb || "", msg.extra || "");
        if (!ok) return null;
        const decrypted = await this.wcf.decryptImage(msg.extra || "", inboxDir);
        if (decrypted) return { path: decrypted, name: `${msg.id}.image` };
        return null;
      }
      // file (type 49)
      const home = this.wcf.self.home;
      const ok = await this.wcf.downloadAttach(msg.id, msg.thumb || "", msg.extra || "");
      if (!ok) return null;
      // the file usually lands at <home>/<extra> (extra = relative path)
      const candidates = [];
      if (msg.extra && home) candidates.push(join(home, msg.extra));
      if (home) candidates.push(join(home, "FileStorage", "File"));
      for (const c of candidates) {
        const hit = await findFile(c, f.title || "", msg.extra || "");
        if (hit) {
          const target = join(inboxDir, `${Date.now()}-${safeBase(hit)}`);
          await copyOrRename(hit, target);
          return { path: target, name: safeBase(hit) };
        }
      }
      this.log.warn(`微信入站文件定位失败 (id=${msg.id} title=${f.title})`);
      return null;
    } catch (e) {
      this.log.warn("微信入站文件处理失败:", e.message);
      return null;
    }
  }

  /* ---------------- outbound ---------------- */

  async _sendText(chat, text) {
    if (!text) return true;
    if (chat.platform === "qq") {
      if (chat.isGroup) return this.qq.sendGroup(chat.chatId, text);
      return this.qq.sendPrivate(chat.chatId, text);
    }
    return this.wcf.sendText(text, chat.chatId);
  }

  async _sendFile(chat, absPath) {
    if (chat.platform === "qq") {
      try {
        if (chat.isGroup) {
          return (await this.qq.uploadGroupFile(chat.chatId, absPath)) ||
            (await this.qq.sendGroupFileSegment(chat.chatId, absPath));
        }
        return (await this.qq.uploadPrivateFile(chat.chatId, absPath)) ||
          (await this.qq.sendPrivateFileSegment(chat.chatId, absPath));
      } catch (e) {
        this.log.warn("QQ 发送文件失败:", e.message);
        return false;
      }
    }
    return this.wcf.sendFile(absPath, chat.chatId);
  }

  async dispose() {
    try { await this.qq?.dispose(); } catch { /* ignore */ }
    try { await this.wcf?.dispose(); } catch { /* ignore */ }
    try { await this.dsh?.dispose(); } catch { /* ignore */ }
  }
}

/* ================================================================== */
/* helpers                                                             */
/* ================================================================== */

/** Extract the final assistant text from events up to the turn end. */
export function extractReplyText(events, turnEnd) {
  const endSeq = turnEnd?.seq ?? Infinity;
  let lastAssistant = null;
  for (const ev of events || []) {
    if (typeof ev.seq !== "number" || ev.seq > endSeq) continue;
    if (ev.type === "assistant/message") lastAssistant = ev;
  }
  if (!lastAssistant) return "";
  const content = lastAssistant.data?.message?.content ?? lastAssistant.data?.content ?? [];
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Pull /send <path> lines out of an assistant reply. */
export function extractSendCommands(text) {
  const sends = [];
  const rest = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*\/send\s+(\S.*?)\s*$/.exec(line);
    if (m) sends.push(m[1].trim());
    else rest.push(line);
  }
  return { sends, text: rest.join("\n").trim() };
}

/** Parse a WeChat app message (type 49) XML for file / url info. */
export function parseAppMsg(xml) {
  const out = { title: "", url: "", isFile: false };
  if (!xml) return out;
  const title = /<title>([^<]*)<\/title>/.exec(xml);
  if (title) out.title = decodeXml(title[1]);
  const url = /<url>([^<]*)<\/url>/.exec(xml);
  if (url) out.url = decodeXml(url[1]);
  const attachid = /<attachid>([^<]*)<\/attachid>/.exec(xml);
  const totallen = /<totallen>([^<]*)<\/totallen>/.exec(xml);
  if (attachid || (totallen && Number(totallen[1]) > 0)) out.isFile = true;
  return out;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function safeBase(p) {
  const base = String(p).split(/[\\/]/).pop() || "file";
  return base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
}

/** Find a file: exact `extra` path, or by title in a dir (bounded walk). */
async function findFile(startDir, title, extra) {
  const { readdir } = await import("node:fs/promises");
  const { stat } = await import("node:fs/promises");
  if (extra) {
    try { const st = await stat(extra); if (st.isFile()) return extra; } catch { /* ignore */ }
    try { const st = await stat(startDir); if (st.isFile()) return startDir; } catch { /* ignore */ }
  }
  if (!title) return null;
  const wanted = safeBase(title).toLowerCase();
  const stack = [startDir];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const en of entries) {
      visited++;
      if (en.isDirectory()) {
        stack.push(join(dir, en.name));
      } else if (en.name.toLowerCase() === wanted) {
        return join(dir, en.name);
      }
    }
  }
  return null;
}

async function copyOrRename(src, dst) {
  const { copyFile } = await import("node:fs/promises");
  try { await copyFile(src, dst); } catch { /* ignore */ }
}
