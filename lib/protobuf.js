/**
 * Minimal protobuf wire codec + wcf message codecs.
 *
 * The WeChatFerry (wcf) RPC protocol carries nanopb-encoded protobuf messages
 * (see WeChatFerry/rpc/proto/wcf.proto) over NNG pair sockets. Only the
 * message subset the bridge needs is implemented here — encode/decode is
 * hand-rolled so the plugin has zero native / heavy dependencies.
 *
 * Wire format: varint / length-delimited only (fields used here are
 * varint, int32/uint32/uint64/string/message/bool).
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

export class Writer {
  constructor() {
    this.chunks = [];
  }

  varint(value) {
    let v = BigInt(value);
    if (v < 0n) v += 1n << 64n; // treat as unsigned
    const out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    this.chunks.push(Buffer.from(out));
    return this;
  }

  tag(field, wire) {
    return this.varint((BigInt(field) << 3n) | BigInt(wire));
  }

  bool(field, value) {
    if (value === undefined || value === null) return this;
    this.tag(field, WIRE_VARINT);
    this.varint(value ? 1 : 0);
    return this;
  }

  int32(field, value) {
    if (value === undefined || value === null) return this;
    this.tag(field, WIRE_VARINT);
    this.varint(BigInt.asUintN(64, BigInt(value)));
    return this;
  }

  uint64String(field, value) {
    if (value === undefined || value === null || value === "") return this;
    this.tag(field, WIRE_VARINT);
    this.varint(BigInt(value));
    return this;
  }

  string(field, value) {
    if (value === undefined || value === null || value === "") return this;
    const buf = Buffer.from(String(value), "utf8");
    this.tag(field, WIRE_LEN);
    this.varint(buf.length);
    this.chunks.push(buf);
    return this;
  }

  message(field, bytes) {
    if (!bytes || bytes.length === 0) return this;
    this.tag(field, WIRE_LEN);
    this.varint(bytes.length);
    this.chunks.push(bytes);
    return this;
  }

  finish() {
    return Buffer.concat(this.chunks);
  }
}

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

export class Reader {
  constructor(buf) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.pos = 0;
  }

  get eof() {
    return this.pos >= this.buf.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.pos >= this.buf.length) throw new Error("protobuf: truncated varint");
      const byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift > 70n) throw new Error("protobuf: varint too long");
    }
    return result;
  }

  tag() {
    const raw = this.varint();
    return { field: Number(raw >> 3n), wire: Number(raw & 0x7n) };
  }

  lengthDelimited() {
    const len = Number(this.varint());
    if (this.pos + len > this.buf.length) throw new Error("protobuf: truncated length-delimited");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string() {
    return this.lengthDelimited().toString("utf8");
  }

  bytes() {
    return Buffer.from(this.lengthDelimited());
  }

  bool() {
    return this.varint() !== 0n;
  }

  skip(wire) {
    switch (wire) {
      case WIRE_VARINT: this.varint(); break;
      case WIRE_FIXED64: this.pos += 8; break;
      case WIRE_LEN: this.lengthDelimited(); break;
      case WIRE_FIXED32: this.pos += 4; break;
      default: throw new Error(`protobuf: unknown wire type ${wire}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* wcf messages                                                        */
/* ------------------------------------------------------------------ */

export const FUNC = {
  FUNC_IS_LOGIN: 0x01,
  FUNC_GET_SELF_WXID: 0x10,
  FUNC_GET_MSG_TYPES: 0x11,
  FUNC_GET_USER_INFO: 0x15,
  FUNC_SEND_TXT: 0x20,
  FUNC_SEND_IMG: 0x21,
  FUNC_SEND_FILE: 0x22,
  FUNC_ENABLE_RECV_TXT: 0x30,
  FUNC_DISABLE_RECV_TXT: 0x40,
  FUNC_DOWNLOAD_ATTACH: 0x54,
  FUNC_DECRYPT_IMAGE: 0x60,
  FUNC_SHUTDOWN: 0xff,
};

/** Encode wcf.Request. Only the fields the bridge uses are supported. */
export function encodeRequest({ func, str, txt, file, att, flag }) {
  const w = new Writer();
  w.int32(1, func);
  if (str !== undefined && str !== null) w.string(3, str);
  if (txt) {
    const t = new Writer();
    t.string(1, txt.msg);
    t.string(2, txt.receiver);
    t.string(3, txt.aters);
    w.message(4, t.finish());
  }
  if (file) {
    const f = new Writer();
    f.string(1, file.path);
    f.string(2, file.receiver);
    w.message(5, f.finish());
  }
  if (flag !== undefined && flag !== null) w.bool(13, flag);
  if (att) {
    const a = new Writer();
    a.uint64String(1, att.id);
    a.string(2, att.thumb);
    a.string(3, att.extra);
    w.message(14, a.finish());
  }
  return w.finish();
}

/** Decode wcf.Response into a plain object (only used fields). */
export function decodeResponse(buf) {
  const r = new Reader(buf);
  const out = { func: 0, status: undefined, str: undefined, wxmsg: undefined, ui: undefined };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: out.func = Number(r.varint()); break; // func: varint
      case 2: out.status = Number(BigInt.asIntN(32, r.varint())); break; // status: int32
      case 3: out.str = r.string(); break; // str: string
      case 4: out.wxmsg = decodeWxMsg(r.bytes()); break; // wxmsg: message
      case 10: out.ui = decodeUserInfo(r.bytes()); break; // ui: message
      default: r.skip(wire);
    }
  }
  return out;
}

/** Decode wcf.WxMsg (received message). */
export function decodeWxMsg(buf) {
  const r = new Reader(buf);
  const out = {
    is_self: false,
    is_group: false,
    id: undefined,
    type: 0,
    ts: 0,
    roomid: "",
    content: "",
    sender: "",
    sign: "",
    thumb: "",
    extra: "",
    xml: "",
  };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: out.is_self = r.bool(); break;
      case 2: out.is_group = r.bool(); break;
      case 3: out.id = r.varint().toString(); break;
      case 4: out.type = Number(r.varint()); break;
      case 5: out.ts = Number(r.varint()); break;
      case 6: out.roomid = r.string(); break;
      case 7: out.content = r.string(); break;
      case 8: out.sender = r.string(); break;
      case 9: out.sign = r.string(); break;
      case 10: out.thumb = r.string(); break;
      case 11: out.extra = r.string(); break;
      case 12: out.xml = r.string(); break;
      default: r.skip(wire);
    }
  }
  return out;
}

/** Decode wcf.UserInfo (self profile; `home` = WeChat Files parent). */
export function decodeUserInfo(buf) {
  const r = new Reader(buf);
  const out = { wxid: "", name: "", mobile: "", home: "", alias: "" };
  while (!r.eof) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: out.wxid = r.string(); break;
      case 2: out.name = r.string(); break;
      case 3: out.mobile = r.string(); break;
      case 4: out.home = r.string(); break;
      case 5: out.alias = r.string(); break;
      default: r.skip(wire);
    }
  }
  return out;
}
