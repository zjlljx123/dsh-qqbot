/**
 * NNG pair1 (tcp://) wire client, implemented in pure Node.
 *
 * WeChatFerry's RPC server exposes two NNG pair1 endpoints over TCP:
 *   - command socket  tcp://<host>:<port>        (client sends Request, gets Response)
 *   - message socket  tcp://<host>:<port+1>      (server pushes Response{wxmsg})
 *
 * NNG TCP framing (see nng src/sp/transport/tcp/tcp.c):
 *   1. On connect, BOTH sides send an 8-byte handshake:
 *        [0x00][0x53 'S'][0x50 'P'][0x00][proto: 2 bytes BE][0x00][0x00]
 *      pair1 protocol id = 0x11.
 *   2. Afterwards each message is framed as:
 *        [8-byte big-endian uint64 length][payload bytes]
 *      (wcf messages carry no NNG message header, so payload = protobuf bytes).
 */
import net from "node:net";
import { EventEmitter } from "node:events";

export const PAIR1_PROTO = 0x11;
export const HANDSHAKE = Buffer.from([0x00, 0x53, 0x50, 0x00, 0x00, PAIR1_PROTO, 0x00, 0x00]);

/** Encode one frame: 8-byte big-endian length + payload. */
export function frameEncode(payload) {
  const len = Buffer.allocUnsafe(8);
  len.writeBigUInt64BE(BigInt(payload.length), 0);
  return Buffer.concat([len, payload]);
}

/**
 * Incremental stream decoder for the NNG TCP transport.
 * Feeds raw chunks; emits whole payload Buffers through the callback.
 * Validates the initial 8-byte handshake.
 */
export class NngStreamDecoder {
  constructor(onFrame, onHandshake) {
    this.onFrame = onFrame;
    this.onHandshake = onHandshake;
    this.buf = Buffer.alloc(0);
    this.handshaken = false;
  }

  push(chunk) {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    while (true) {
      if (!this.handshaken) {
        if (this.buf.length < 8) return;
        const h = this.buf.subarray(0, 8);
        if (
          h[0] !== 0x00 || h[1] !== 0x53 || h[2] !== 0x50 || h[3] !== 0x00 ||
          h[6] !== 0x00 || h[7] !== 0x00
        ) {
          throw new Error(`NNG: invalid handshake ${h.toString("hex")}`);
        }
        this.handshaken = true;
        this.buf = this.buf.subarray(8);
        try { this.onHandshake?.(h.readUInt16BE(4)); } catch { /* ignore */ }
        continue;
      }
      if (this.buf.length < 8) return;
      const len = Number(this.buf.readBigUInt64BE(0));
      if (len < 0 || len > 64 * 1024 * 1024) {
        throw new Error(`NNG: implausible frame length ${len}`);
      }
      if (this.buf.length < 8 + len) return;
      const payload = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      try { this.onFrame(Buffer.from(payload)); } catch { /* contained by caller */ }
    }
  }

  get pending() {
    return this.buf.length;
  }
}

/**
 * One NNG pair1 TCP connection. Manages connect + handshake + frame stream.
 * Emits: 'open' (after handshake), 'frame' (payload Buffer), 'close', 'error'.
 */
export class NngConnection extends EventEmitter {
  constructor({ host, port, timeoutMs = 8000 }) {
    super();
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.decoder = null;
    this.connected = false;
    this.closed = false;
    this._buf = null;
  }

  /** Connect and complete the handshake. Resolves on 'open'. Rejects on failure. */
  connect() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      this.decoder = new NngStreamDecoder(
        (payload) => this.emit("frame", payload),
        () => {}
      );
      let opened = false;
      const onError = (err) => {
        if (!opened) reject(err);
        this.emit("error", err);
      };
      socket.once("error", onError);
      socket.on("connect", () => {
        socket.write(HANDSHAKE);
      });
      socket.on("data", (chunk) => {
        try {
          this.decoder.push(chunk);
        } catch (err) {
          socket.destroy(err);
          return;
        }
        if (!opened && this.decoder.handshaken) {
          opened = true;
          this.connected = true;
          this.emit("open");
          resolve();
        }
      });
      socket.on("close", () => {
        this.connected = false;
        this.closed = true;
        this.emit("close");
      });
    });
  }

  /** Send one raw frame. */
  send(payload) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new Error("NNG: not connected");
    }
    this.socket.write(frameEncode(payload));
  }

  close() {
    this.closed = true;
    this.connected = false;
    if (this.socket) {
      this.socket.removeAllListeners("error");
      this.socket.destroy();
      this.socket = null;
    }
  }
}
