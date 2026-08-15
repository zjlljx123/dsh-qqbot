/**
 * WeChatFerry (wcf) RPC client over NNG pair1 sockets.
 *
 * Protocol reference: https://github.com/lich0821/WeChatFerry
 *   - command socket: tcp://host:port  (default 127.0.0.1:10086)
 *   - message socket: tcp://host:port+1 (pushed WxMsg frames after
 *     FUNC_ENABLE_RECV_TXT succeeds)
 * Request/Response are protobuf messages (see lib/protobuf.js).
 *
 * All failures are contained: methods return false / throw-bounded and the
 * bridge keeps retrying in the background. This class NEVER crashes DSH.
 */
import { EventEmitter } from "node:events";
import { NngConnection } from "./nng-socket.js";
import { FUNC, encodeRequest, decodeResponse } from "./protobuf.js";

const CMD_TIMEOUT_MS = 8000;

export class WcfClient extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 10086, logger }) {
    super();
    this.host = host;
    this.port = port;
    this.log = logger;
    this.cmd = null;
    this.msg = null;
    this.running = false;
    this.queue = Promise.resolve();
    this.self = { wxid: "", name: "", home: "" };
    this.on("error", () => {}); // tolerate late errors; state flows via 'status'
  }

  get connected() {
    return !!(this.cmd && this.cmd.connected);
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start() {
    if (this.running) return;
    this.running = true;
    this._connectLoop().catch((e) => this.log.warn("wcf start loop stopped:", e));
  }

  async _connectLoop() {
    while (this.running) {
      try {
        const ok = await this._connectOnce();
        if (!ok) {
          await sleep(5000);
          continue;
        }
        this.emit("status", { platform: "wechat", connected: true });
        // keep the loop alive only to observe disconnection
        await new Promise((resolve) => {
          const onClose = () => resolve();
          this.once("cmd-close", onClose);
          this.once("dispose", onClose);
        });
        this.emit("status", { platform: "wechat", connected: false });
      } catch (e) {
        this.log.warn(`wcf connection failed (${this.host}:${this.port}):`, e.message);
      }
      if (!this.running) break;
      await sleep(5000);
    }
  }

  async _connectOnce() {
    try {
      this.cmd = new NngConnection({ host: this.host, port: this.port });
      this.cmd.on("close", () => this.emit("cmd-close"));
      this.cmd.on("error", (e) => this.log.debug("wcf cmd socket error:", e.message));
      await this.cmd.connect();

      // sanity: is WeChat logged in?
      const login = await this._request(FUNC.FUNC_IS_LOGIN);
      if (login.status !== 1) {
        this.log.warn("WeChatFerry 已连接但微信未登录，等待登录中…");
      }

      const selfStr = await this._request(FUNC.FUNC_GET_SELF_WXID);
      const ui = await this._request(FUNC.FUNC_GET_USER_INFO);
      this.self.wxid = selfStr.str || ui?.ui?.wxid || "";
      this.self.name = ui?.ui?.name || "";
      this.self.home = ui?.ui?.home || "";
      this.log.info(`WeChat 已连接 (wxid=${this.self.wxid || "?"} name=${this.self.name || "?"})`);

      // enable message receiving, then open the push socket
      const en = await this._request(FUNC.FUNC_ENABLE_RECV_TXT, { flag: false });
      if (en.status !== 0) {
        this.log.warn(`wcf enable recv failed (status=${en.status})`);
        return false;
      }
      this.msg = new NngConnection({ host: this.host, port: this.port + 1 });
      this.msg.on("error", (e) => this.log.debug("wcf msg socket error:", e.message));
      this.msg.on("frame", (payload) => {
        try {
          const rsp = decodeResponse(payload);
          if (rsp.wxmsg) this.emit("message", rsp.wxmsg);
        } catch (e) {
          this.log.debug("wcf msg parse error:", e.message);
        }
      });
      await this.msg.connect();
      return true;
    } catch (e) {
      this.log.warn(`wcf (${this.host}:${this.port}) 不可达:`, e.message);
      this._teardown();
      return false;
    }
  }

  _teardown() {
    try { this.cmd?.close(); } catch { /* ignore */ }
    try { this.msg?.close(); } catch { /* ignore */ }
    this.cmd = null;
    this.msg = null;
  }

  async dispose() {
    this.running = false;
    this.emit("dispose");
    try {
      if (this.cmd?.connected) {
        await this._request(FUNC.FUNC_DISABLE_RECV_TXT).catch(() => undefined);
      }
    } catch { /* ignore */ }
    this._teardown();
  }

  /* ------------------------------------------------------------------ */
  /* low-level request (serialized, retried once)                        */
  /* ------------------------------------------------------------------ */

  _request(func, body) {
    const task = this.queue.then(() => this._doRequest(func, body));
    // Keep the serialization chain alive even when a task fails.
    this.queue = task.catch(() => {});
    return task;
  }

  async _doRequest(func, body) {
    try {
      return await this._sendOnce(func, body);
    } catch (e) {
      // one retry after a (re)connect
      try {
        if (this.running && this.cmd) {
          await this.cmd.connect().catch(() => undefined);
        }
        return await this._sendOnce(func, body);
      } catch (e2) {
        throw e2;
      }
    }
  }

  _sendOnce(func, body) {
    if (!this.cmd || !this.cmd.connected) {
      throw new Error("wcf not connected");
    }
    return new Promise((resolve, reject) => {
      const payload = encodeRequest({ func, ...body });
      const timer = setTimeout(() => reject(new Error("wcf command timeout")), CMD_TIMEOUT_MS);
      const onFrame = (buf) => {
        clearTimeout(timer);
        this.cmd.removeListener("frame", onFrame);
        resolve(decodeResponse(buf));
      };
      this.cmd.on("frame", onFrame);
      try {
        this.cmd.send(payload);
      } catch (e) {
        clearTimeout(timer);
        this.cmd.removeListener("frame", onFrame);
        reject(e);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                          */
  /* ------------------------------------------------------------------ */

  /** Send a text message. Returns true on success (wcf status 0). */
  async sendText(msg, receiver, aters = "") {
    try {
      const rsp = await this._request(FUNC.FUNC_SEND_TXT, { txt: { msg, receiver, aters } });
      return rsp.status === 0;
    } catch (e) {
      this.log.warn("wcf sendText failed:", e.message);
      return false;
    }
  }

  /** Send a local file. Returns true on success (wcf status 0). */
  async sendFile(path, receiver) {
    try {
      const rsp = await this._request(FUNC.FUNC_SEND_FILE, { file: { path, receiver } });
      return rsp.status === 0;
    } catch (e) {
      this.log.warn("wcf sendFile failed:", e.message);
      return false;
    }
  }

  /** Send a local image. Returns true on success (wcf status 0). */
  async sendImage(path, receiver) {
    try {
      const rsp = await this._request(FUNC.FUNC_SEND_IMG, { file: { path, receiver } });
      return rsp.status === 0;
    } catch (e) {
      this.log.warn("wcf sendImage failed:", e.message);
      return false;
    }
  }

  /** Download a received attachment (image/video/file). Returns true on success. */
  async downloadAttach(id, thumb = "", extra = "") {
    try {
      const rsp = await this._request(FUNC.FUNC_DOWNLOAD_ATTACH, { att: { id, thumb, extra } });
      return rsp.status === 0;
    } catch (e) {
      this.log.warn("wcf downloadAttach failed:", e.message);
      return false;
    }
  }

  /** Decrypt a downloaded image into `dir`; returns the saved path or "". */
  async decryptImage(src, dir) {
    try {
      const rsp = await this._request(FUNC.FUNC_DECRYPT_IMAGE, { dec: { src, dst: dir } });
      return rsp.str || "";
    } catch (e) {
      this.log.warn("wcf decryptImage failed:", e.message);
      return "";
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
