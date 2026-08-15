import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Writer, Reader, FUNC, encodeRequest, decodeResponse, decodeWxMsg, decodeUserInfo,
} from "../lib/protobuf.js";

test("writer/reader varint round-trip", () => {
  for (const v of [0, 1, 127, 128, 300, 16384, 2 ** 31 - 1, 2n ** 40n]) {
    const w = new Writer();
    w.varint(v);
    const r = new Reader(w.finish());
    assert.equal(r.varint(), BigInt(v));
  }
});

test("encodeRequest FUNC_IS_LOGIN", () => {
  assert.deepEqual(encodeRequest({ func: FUNC.FUNC_IS_LOGIN }), Buffer.from([0x08, 0x01]));
});

test("encodeRequest FUNC_SEND_FILE with PathMsg", () => {
  const buf = encodeRequest({
    func: FUNC.FUNC_SEND_FILE,
    file: { path: "C:\\x.txt", receiver: "u" },
  });
  assert.deepEqual(
    buf,
    Buffer.from([0x08, 0x22, 0x2a, 0x0d, 0x0a, 0x08, 0x43, 0x3a, 0x5c, 0x78, 0x2e, 0x74, 0x78, 0x74, 0x12, 0x01, 0x75])
  );
});

test("encodeRequest FUNC_SEND_TXT with TextMsg", () => {
  const buf = encodeRequest({
    func: FUNC.FUNC_SEND_TXT,
    txt: { msg: "hi", receiver: "wxid_x", aters: "" },
  });
  assert.deepEqual(
    buf,
    Buffer.from([0x08, 0x20, 0x22, 0x0c, 0x0a, 0x02, 0x68, 0x69, 0x12, 0x06, 0x77, 0x78, 0x69, 0x64, 0x5f, 0x78])
  );
});

test("decodeResponse status + str", () => {
  // Response{func: FUNC_GET_SELF_WXID, str: "wxid_abc"}
  const rsp = decodeResponse(Buffer.from([0x08, 0x10, 0x1a, 0x08, 0x77, 0x78, 0x69, 0x64, 0x5f, 0x61, 0x62, 0x63]));
  assert.equal(rsp.func, 0x10);
  assert.equal(rsp.str, "wxid_abc");
});

test("decodeResponse with WxMsg", () => {
  // WxMsg{is_self:false, is_group:true, type:1, content:"hello", roomid:"r@chatroom", sender:"wxid_a"}
  const wx = Buffer.concat([
    Buffer.from([0x10, 0x01]),                 // is_group = true
    Buffer.from([0x20, 0x01]),                 // type = 1
    Buffer.from([0x32, 0x0a]), Buffer.from("r@chatroom"), // roomid
    Buffer.from([0x3a, 0x05]), Buffer.from("hello"),      // content
    Buffer.from([0x42, 0x06]), Buffer.from("wxid_a"),     // sender
  ]);
  const rsp = decodeResponse(Buffer.concat([
    Buffer.from([0x08, 0x30]),                 // func = FUNC_ENABLE_RECV_TXT
    Buffer.from([0x22, wx.length]), wx,        // wxmsg = WxMsg
  ]));
  assert.equal(rsp.func, 0x30);
  assert.equal(rsp.wxmsg.is_group, true);
  assert.equal(rsp.wxmsg.type, 1);
  assert.equal(rsp.wxmsg.content, "hello");
  assert.equal(rsp.wxmsg.roomid, "r@chatroom");
  assert.equal(rsp.wxmsg.sender, "wxid_a");
  assert.equal(rsp.wxmsg.is_self, false);
});

test("decodeResponse unknown fields are skipped", () => {
  // Response{func: 1, status: 1, garbage fixed64 field 99, str: "x"}
  const buf = Buffer.concat([
    Buffer.from([0x08, 0x01]),
    Buffer.from([0x10, 0x01]),
    Buffer.from([0x99, 0x06, 1, 2, 3, 4, 5, 6, 7, 8]), // field 99 wire 1 (fixed64)
    Buffer.from([0x1a, 0x01, 0x78]),
  ]);
  const rsp = decodeResponse(buf);
  assert.equal(rsp.status, 1);
  assert.equal(rsp.str, "x");
});

test("decodeUserInfo home path", () => {
  // UserInfo{wxid:"wxid_me", name:"me", home:"C:\\WeChat Files"}
  const home = "C:\\WeChat Files";
  const ui = Buffer.concat([
    Buffer.from([0x0a, 0x07]), Buffer.from("wxid_me"),
    Buffer.from([0x12, 0x02]), Buffer.from("me"),
    Buffer.from([0x22, home.length]), Buffer.from(home),
  ]);
  const rsp = decodeResponse(Buffer.concat([Buffer.from([0x08, 0x15]), Buffer.from([0x52, ui.length]), ui]));
  assert.equal(rsp.ui.wxid, "wxid_me");
  assert.equal(rsp.ui.home, "C:\\WeChat Files");
});

test("uint64 id survives as string", () => {
  const wx = Buffer.concat([Buffer.from([0x18, 0xac, 0x02])]); // id = 300
  const msg = decodeWxMsg(wx);
  assert.equal(msg.id, "300");
});
