/**
 * DSH session manager: drives real DSH sessions through the in-process API
 * gateway (`ctx.apiProxy`) — the same RPC surface the web UI uses.
 *
 *   - ensureChat(): one persistent DSH session (with its own cwd/workspace)
 *     per IM chat, mapping persisted to a JSON file so conversations survive
 *     DSH restarts.
 *   - sendPrompt(): queue a user message and await the turn's final
 *     assistant text, correlating via the aggregated mux event stream.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { sleep } from "./logger.js";

const REPLY_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const MAX_BUFFER = 1000;

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function resolveRootDir(cfgValue, fallbackName) {
  if (cfgValue && typeof cfgValue === "string" && cfgValue.trim() !== "") {
    return cfgValue.trim();
  }
  return join(dshHome(), fallbackName);
}

async function waitForService(ctx, name, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const svc = ctx.get(name);
    if (svc) return svc;
    await sleep(200);
  }
  return undefined;
}

export class DshSessionManager {
  constructor(ctx, cfg, log) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = log;
    this.api = null;
    this.stateDir = resolveRootDir(cfg.stateDir, "im-bridge/state");
    this.workspaceRoot = resolveRootDir(cfg.workspaceRoot, "im-bridge/workspaces");
    this.chats = {}; // chatKey -> { sessionId, cwd }
    this.sessions = new Map(); // sessionId -> { lastSeq, buffer: [], waiters: [] }
    this.muxAbort = null;
    this.disposed = false;
  }

  async init() {
    await mkdir(this.stateDir, { recursive: true });
    await mkdir(this.workspaceRoot, { recursive: true });
    await this._loadChats();
    this.api = await waitForService(this.ctx, "apiProxy", 60000);
    if (!this.api) {
      throw new Error("apiProxy 服务不可用（dsh-im-bridge 需要 web profile）");
    }
    this._startMux();
    this.log.info(
      `DSH 会话管理器就绪 (workspaces=${this.workspaceRoot}, state=${this.stateDir})`
    );
  }

  /* ---------------- mux event tracking ---------------- */

  _startMux() {
    this.muxAbort = new AbortController();
    const run = async () => {
      try {
        for await (const frame of this.api.events.mux(
          { rpcId: randomUUID(), payload: {} },
          this.muxAbort.signal
        )) {
          if (this.disposed) break;
          this._onMuxFrame(frame.payload);
        }
      } catch (e) {
        if (!this.muxAbort.signal.aborted) {
          this.log.warn("DSH mux 事件流中断:", e.message);
        }
      }
    };
    run().catch((e) => this.log.warn("mux loop error:", e.message));
  }

  _entry(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { lastSeq: 0, buffer: [], waiters: [] };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  _onMuxFrame(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "session/subscribed") {
      const s = this._entry(payload.sessionId);
      s.lastSeq = Math.max(s.lastSeq, payload.lastSeq || 0);
      return;
    }
    if (payload.type === "session/event") {
      const ev = payload.event;
      if (!ev || typeof ev.seq !== "number") return;
      const s = this._entry(payload.sessionId);
      s.lastSeq = Math.max(s.lastSeq, ev.seq);
      s.buffer.push(ev);
      if (s.buffer.length > MAX_BUFFER) s.buffer.splice(0, s.buffer.length - MAX_BUFFER);
      if (ev.type === "turn/end") this._settleTurn(payload.sessionId, ev);
    }
  }

  _settleTurn(sessionId, turnEndEvent) {
    const s = this.sessions.get(sessionId);
    if (!s || s.waiters.length === 0) return;
    const endSeq = turnEndEvent.seq;
    for (const w of [...s.waiters]) {
      if (endSeq > w.afterSeq) {
        clearTimeout(w.timer);
        s.waiters.splice(s.waiters.indexOf(w), 1);
        try {
          w.resolve({ endSeq, turnEnd: turnEndEvent, events: s.buffer.slice() });
        } catch { /* ignore */ }
      }
    }
  }

  /* ---------------- chat <-> session mapping ---------------- */

  async _loadChats() {
    try {
      const raw = await readFile(join(this.stateDir, "chats.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.chats = parsed;
    } catch { /* first run */ }
  }

  async _saveChats() {
    try {
      await writeFile(join(this.stateDir, "chats.json"), JSON.stringify(this.chats, null, 2), "utf8");
    } catch (e) {
      this.log.warn("保存 chats.json 失败:", e.message);
    }
  }

  /** Absolute workspace dir for one chat key. */
  cwdFor(chatKey) {
    return join(this.workspaceRoot, sanitizeKey(chatKey));
  }

  /** Get or create the DSH session bound to one chat. */
  async ensureChat(chatKey, { cwd } = {}) {
    let m = this.chats[chatKey];
    if (m && m.sessionId) return m;
    const target = cwd || this.cwdFor(chatKey);
    await mkdir(target, { recursive: true });
    const rsp = await this.api.sessions.create({
      rpcId: randomUUID(),
      payload: { cwd: target },
    });
    if (!rsp.result.ok) {
      throw new Error(`session.create 失败: ${rsp.result.error?.message || "unknown"}`);
    }
    m = { sessionId: rsp.result.value.sessionId, cwd: target };
    this.chats[chatKey] = m;
    await this._saveChats();
    this.log.info(`新会话 ${m.sessionId} 绑定到 ${chatKey} (cwd=${target})`);
    return m;
  }

  /** Delete the chat<->session mapping (next message starts a fresh session). */
  async resetChat(chatKey) {
    if (this.chats[chatKey]) {
      delete this.chats[chatKey];
      await this._saveChats();
    }
  }

  /** Snapshot the current last seq for a session. */
  lastSeqOf(sessionId) {
    return this._entry(sessionId).lastSeq;
  }

  /**
   * Queue a user message and resolve with the turn result:
   *   { text, turnEnd, events }
   */
  sendPrompt(sessionId, text, { timeoutMs = REPLY_TIMEOUT_MS } = {}) {
    const s = this._entry(sessionId);
    const afterSeq = s.lastSeq;
    return this._promptAndWait(sessionId, text, afterSeq, timeoutMs);
  }

  async _promptAndWait(sessionId, text, afterSeq, timeoutMs) {
    const rsp = await this.api.sessions.prompt({
      rpcId: randomUUID(),
      payload: { sessionId, mode: "queue", content: [{ type: "text", text }] },
    });
    if (!rsp.result.ok) {
      throw new Error(`session.prompt 失败: ${rsp.result.error?.message || "unknown"}`);
    }
    const s = this._entry(sessionId);
    return new Promise((resolve, reject) => {
      const w = {
        afterSeq,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = s.waiters.indexOf(w);
          if (idx >= 0) s.waiters.splice(idx, 1);
          reject(new Error("等待 agent 回复超时"));
        }, timeoutMs),
      };
      s.waiters.push(w);
    });
  }

  async dispose() {
    this.disposed = true;
    if (this.muxAbort) {
      try { this.muxAbort.abort(); } catch { /* ignore */ }
    }
    for (const s of this.sessions.values()) {
      for (const w of s.waiters) {
        clearTimeout(w.timer);
        try { w.reject(new Error("bridge disposed")); } catch { /* ignore */ }
      }
      s.waiters.length = 0;
    }
  }
}

/** chatKey -> safe directory name */
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, "_");
}
