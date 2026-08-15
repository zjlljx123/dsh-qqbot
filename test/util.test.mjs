import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, parseCqString, resolveSendPath } from "../lib/util.js";
import { extractReplyText, extractSendCommands, parseAppMsg } from "../lib/bridge.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("chunkText splits long text", () => {
  assert.deepEqual(chunkText("abc", 5), ["abc"]);
  assert.deepEqual(chunkText("abcdef", 3), ["abc", "def"]);
  assert.deepEqual(chunkText("aaaa\nbbbb", 5), ["aaaa", "bbbb"]);
  assert.deepEqual(chunkText("", 5), []);
});

test("parseCqString handles CQ codes", () => {
  const segs = parseCqString("[CQ:image,file=abc.jpg,url=https://x/y.jpg]hi");
  assert.equal(segs.length, 2);
  assert.equal(segs[0].type, "image");
  assert.equal(segs[0].data.file, "abc.jpg");
  assert.equal(segs[0].data.url, "https://x/y.jpg");
  assert.equal(segs[1].type, "text");
  assert.equal(segs[1].data.text, "hi");
});

test("parseCqString plain text stays text", () => {
  const segs = parseCqString("你好世界");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, "text");
  assert.equal(segs[0].data.text, "你好世界");
});

test("resolveSendPath resolves relative, ~, and absolute", () => {
  const dir = mkdtempSync(join(tmpdir(), "imb-test-"));
  try {
    const f = join(dir, "a.txt");
    writeFileSync(f, "x");
    assert.equal(resolveSendPath("a.txt", dir), f);
    assert.equal(resolveSendPath(join(dir, "a.txt"), dir), f);
    assert.equal(resolveSendPath("missing.txt", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractSendCommands pulls /send lines and keeps the rest", () => {
  const { sends, text } = extractSendCommands(
    "你好\n/send C:\\work\\a.txt\n这是内容\n/send /tmp/b.zip"
  );
  assert.deepEqual(sends, ["C:\\work\\a.txt", "/tmp/b.zip"]);
  assert.equal(text, "你好\n这是内容");
});

test("extractReplyText picks the last assistant text before turn end", () => {
  const events = [
    { type: "user/message", seq: 1 },
    { type: "assistant/message", seq: 3, data: { message: { content: [{ type: "text", text: "first" }] } } },
    { type: "tool/call", seq: 4 },
    { type: "assistant/message", seq: 6, data: { message: { content: [{ type: "reasoning", text: "think" }, { type: "text", text: "final answer" }] } } },
    { type: "turn/end", seq: 7, data: { kind: "complete" } },
  ];
  const turnEnd = { type: "turn/end", seq: 7 };
  assert.equal(extractReplyText(events, turnEnd), "final answer");
});

test("extractReplyText returns empty when no assistant text", () => {
  const events = [{ type: "assistant/message", seq: 2, data: { message: { content: [] } } }];
  assert.equal(extractReplyText(events, { seq: 3 }), "");
});

test("parseAppMsg detects files and urls", () => {
  const fileXml = '<msg><appmsg><title>报告.pdf</title><appattach><totallen>123</totallen><attachid>abc</attachid></appattach></appmsg></msg>';
  const linkXml = '<msg><appmsg><title>文章</title><url>https://mp.weixin.qq.com/x</url></appmsg></msg>';
  assert.equal(parseAppMsg(fileXml).isFile, true);
  assert.equal(parseAppMsg(fileXml).title, "报告.pdf");
  assert.equal(parseAppMsg(linkXml).isFile, false);
  assert.equal(parseAppMsg(linkXml).url, "https://mp.weixin.qq.com/x");
});
