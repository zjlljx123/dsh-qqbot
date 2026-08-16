/**
 * QQ client over OneBot v11 WebSocket (NapCat / Lagrange).
 *
 * Reference: https://github.com/constansino/openclaw_qq (OneBot v11 via WS)
 *   - connect to NapCat's WS server (default ws://127.0.0.1:3001)
 *   - events arrive as JSON `post_type` messages
 *   - actions are JSON requests {action, params, echo}
 *
 * Failures are contained + reconnected in the background; this client never
 * crashes DSH.
 */
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { basename } from "node:path";

export class QQClient extends EventEmitter {
  constructor({ wsUrl, accessToken = "", logger, timeoutMs = 8000 }) {
    super();
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.log = logger;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.running = false;
    this.connected = false;
    this.selfId = null;
    this._echo = 1;
    this._pending = new Map();
    this.on("error", () => {}); // tolerate late errors
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this._connectLoop().catch((e) => this.log.warn("qq start loop stopped:", e));
  }

  async _connectLoop() {
    while (this.running) {
      try {
        await this._connectOnce();
        this.emit("status", { platform: "qq", connected: true });
        await new Promise((resolve) => {
          const onClose = () => resolve();
          this.once("ws-close", onClose);
          this.once("dispose", onClose);
        });
        this.emit("status", { platform: "qq", connected: false });
      } catch (e) {
        this.log.warn(`QQ (${this.wsUrl}) 连接失败:`, e.message);
      }
      if (!this.running) break;
      await sleep(5000);
    }
  }

  async _connectOnce() {
    const ws = new WebSocket(this.wsUrl, {
      headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
      handshakeTimeout: 8000,
    });
    this.ws = ws;
    ws.on("message", (data) => this._onMessage(data));
    ws.on("close", () => {
      this.connected = false;
      this._rejectAll(new Error("qq ws closed"));
      this.emit("ws-close");
    });
    ws.on("error", (e) => this.log.debug("qq ws error:", e.message));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("qq ws handshake timeout")), 10000);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    this.connected = true;
    this.log.info(`QQ 已连接 (${this.wsUrl})`);
    // learn self id for group mention detection
    try {
      const info = await this.request("get_login_info", {});
      if (info?.user_id) {
        this.selfId = info.user_id;
        this.log.info(`QQ self_id = ${this.selfId}`);
      }
    } catch (e) {
      this.log.debug("qq get_login_info failed:", e.message);
    }
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.post_type) {
      this.emit("event", msg);
      return;
    }
    // action response
    if (msg.echo !== undefined) {
      const entry = this._pending.get(String(msg.echo));
      if (entry) {
        this._pending.delete(String(msg.echo));
        clearTimeout(entry.timer);
        if (msg.status === "ok" && msg.retcode === 0) {
          entry.resolve(msg.data);
        } else {
          entry.reject(new Error(`OneBot error ${msg.retcode}: ${msg.status} ${msg.message || ""}`));
        }
      }
    }
  }

  _rejectAll(err) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  /** Call one OneBot action. Resolves with action data. */
  request(action, params = {}) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("qq not connected"));
    }
    const echo = String(this._echo++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`qq action timeout: ${action}`));
      }, this.timeoutMs);
      this._pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  /* ------------------------------------------------------------------ */
  /* outbound helpers                                                    */
  /* ------------------------------------------------------------------ */

  async sendPrivate(userId, text) {
    const rsp = await this.request("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "text", data: { text } }],
    });
    return rsp !== undefined;
  }

  async sendGroup(groupId, text) {
    const rsp = await this.request("send_group_msg", {
      group_id: Number(groupId),
      message: [{ type: "text", data: { text } }],
    });
    return rsp !== undefined;
  }

  /**
   * Upload a local file in a private chat. NapCat 要求 `name` 参数（缺失会返回
   * retcode 1400 Schema compilation error）。
   */
  async uploadPrivateFile(userId, filePath, name) {
    const rsp = await this.request("upload_private_file", {
      user_id: Number(userId),
      file: filePath,
      name: name || basename(String(filePath)),
    });
    return rsp !== undefined;
  }

  /** Upload a local file in a group chat. NapCat 同样要求 `name`。 */
  async uploadGroupFile(groupId, filePath, name) {
    const rsp = await this.request("upload_group_file", {
      group_id: Number(groupId),
      file: filePath,
      name: name || basename(String(filePath)),
    });
    return rsp !== undefined;
  }

  /** Fallback: send a `file` message segment (CQ file) to a private chat. */
  async sendPrivateFileSegment(userId, filePath) {
    const rsp = await this.request("send_private_msg", {
      user_id: Number(userId),
      message: [{ type: "file", data: { file: filePath } }],
    });
    return rsp !== undefined;
  }

  /** Fallback: send a `file` message segment to a group chat. */
  async sendGroupFileSegment(groupId, filePath) {
    const rsp = await this.request("send_group_msg", {
      group_id: Number(groupId),
      message: [{ type: "file", data: { file: filePath } }],
    });
    return rsp !== undefined;
  }

  async dispose() {
    this.running = false;
    this.emit("dispose");
    this._rejectAll(new Error("qq disposed"));
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
