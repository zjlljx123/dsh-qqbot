import { test } from "node:test";
import assert from "node:assert/strict";
import { ImBridge } from "../lib/bridge.js";
import { Logger } from "../lib/logger.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeLogger() {
  return new Logger("silent");
}

function makeFakeQq(overrides = {}) {
  const calls = { group: [], private: [], groupFile: [], privateFile: [] };
  const qq = {
    connected: true,
    selfId: 10001,
    sendGroup: async (gid, text) => { calls.group.push({ gid, text }); return true; },
    sendPrivate: async (uid, text) => { calls.private.push({ uid, text }); return true; },
    uploadGroupFile: async (gid, file, name) => { calls.groupFile.push({ gid, file, name }); return true; },
    uploadPrivateFile: async (uid, file, name) => { calls.privateFile.push({ uid, file, name }); return true; },
    ...overrides,
  };
  return { qq, calls };
}

function makeFakeDsh(replyEvents) {
  const state = { prompts: [], ensured: [] };
  const dsh = {
    chats: {},
    ensureChat: async (key) => {
      state.ensured.push(key);
      return { sessionId: "session-1", cwd: state.cwd };
    },
    sendPrompt: async (sessionId, text) => {
      state.prompts.push(text);
      return replyEvents;
    },
    resetChat: async () => {},
  };
  return { dsh, state };
}

test("QQ group @ message -> prompt -> reply chunks + /send file upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imb-bridge-"));
  try {
    const file = join(dir, "report.txt");
    writeFileSync(file, "report content");
    const { qq, calls } = makeFakeQq();
    const { dsh, state } = makeFakeDsh({
      events: [
        { type: "assistant/message", seq: 10, data: { message: { content: [{ type: "text", text: `第一段回复\n/send ${file}\n第二段回复` }] } } },
        { type: "turn/end", seq: 11, data: { kind: "complete" } },
      ],
      turnEnd: { type: "turn/end", seq: 11 },
    });
    state.cwd = dir;

    const bridge = new ImBridge(
      { systemHint: "HINT", qq: { requireMention: true, maxMessageChars: 4000 }, wechat: {} },
      makeLogger(),
      dsh
    );
    bridge.qq = qq;

    await bridge.handleQqEvent({
      post_type: "message",
      message_type: "group",
      group_id: 777,
      user_id: 222,
      sender: { nickname: "小明" },
      message: [
        { type: "at", data: { qq: "10001" } },
        { type: "text", data: { text: "帮我生成报告" } },
      ],
    });

    // prompt built from systemHint + text
    assert.equal(state.prompts.length, 1);
    assert.ok(state.prompts[0].includes("HINT"));
    assert.ok(state.prompts[0].includes("帮我生成报告"));

    // reply text chunks (send line removed)
    const sentText = calls.group.map((c) => c.text).join("\n");
    assert.ok(sentText.includes("第一段回复"));
    assert.ok(sentText.includes("第二段回复"));
    assert.ok(!sentText.includes("/send"));

    // file uploaded (NapCat requires the `name` param)
    assert.equal(calls.groupFile.length, 1);
    assert.equal(calls.groupFile[0].gid, "777");
    assert.equal(calls.groupFile[0].file, file);
    assert.equal(calls.groupFile[0].name, "report.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QQ group message without @ is ignored when requireMention", async () => {
  const { qq, calls } = makeFakeQq();
  const { dsh } = makeFakeDsh({ events: [], turnEnd: {} });
  const bridge = new ImBridge(
    { systemHint: "HINT", qq: { requireMention: true }, wechat: {} },
    makeLogger(),
    dsh
  );
  bridge.qq = qq;
  await bridge.handleQqEvent({
    post_type: "message",
    message_type: "group",
    group_id: 777,
    user_id: 222,
    message: [{ type: "text", data: { text: "没人叫我" } }],
  });
  assert.equal(calls.group.length, 0);
});

test("blockedChats are ignored", async () => {
  const { qq, calls } = makeFakeQq();
  const { dsh } = makeFakeDsh({ events: [], turnEnd: {} });
  const bridge = new ImBridge(
    { systemHint: "HINT", qq: { blockedChats: ["222"], requireMention: false }, wechat: {} },
    makeLogger(),
    dsh
  );
  bridge.qq = qq;
  await bridge.handleQqEvent({
    post_type: "message",
    message_type: "private",
    user_id: 222,
    message: [{ type: "text", data: { text: "别理我" } }],
  });
  assert.equal(calls.private.length, 0);
});

test("/status command answers without calling the agent", async () => {
  const { qq, calls } = makeFakeQq();
  const { dsh, state } = makeFakeDsh({ events: [], turnEnd: {} });
  const bridge = new ImBridge(
    { systemHint: "HINT", qq: { requireMention: false }, wechat: {} },
    makeLogger(),
    dsh
  );
  bridge.qq = qq;
  await bridge.handleQqEvent({
    post_type: "message",
    message_type: "private",
    user_id: 222,
    message: [{ type: "text", data: { text: "/status" } }],
  });
  assert.equal(state.prompts.length, 0);
  assert.equal(calls.private.length, 1);
  assert.ok(calls.private[0].text.includes("QQ"));
});

test("WeChat private text -> wcf sendText", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imb-wx-"));
  try {
    const { dsh, state } = makeFakeDsh({
      events: [
        { type: "assistant/message", seq: 4, data: { message: { content: [{ type: "text", text: "微信回复" }] } } },
        { type: "turn/end", seq: 5, data: { kind: "complete" } },
      ],
      turnEnd: { type: "turn/end", seq: 5 },
    });
    state.cwd = dir;
    const sent = [];
    const wcf = {
      connected: true,
      self: { name: "机器人" },
      sendText: async (msg, receiver) => { sent.push({ msg, receiver }); return true; },
      sendFile: async () => true,
      downloadAttach: async () => true,
      decryptImage: async () => "",
    };
    const bridge = new ImBridge(
      { systemHint: "HINT", qq: { enabled: false }, wechat: { maxMessageChars: 2000 } },
      makeLogger(),
      dsh
    );
    bridge.wcf = wcf;
    await bridge.handleWxMsg({
      is_self: false,
      is_group: false,
      type: 1,
      content: "在吗",
      sender: "wxid_friend",
      id: "1",
    });
    assert.equal(state.prompts.length, 1);
    assert.ok(state.prompts[0].includes("在吗"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].receiver, "wxid_friend");
    assert.equal(sent[0].msg, "微信回复");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("turn/end error kind sends an error note", async () => {
  const { qq, calls } = makeFakeQq();
  const { dsh, state } = makeFakeDsh({
    events: [{ type: "turn/end", seq: 3, data: { kind: "error", error: { message: "boom" } } }],
    turnEnd: { type: "turn/end", seq: 3, data: { kind: "error", error: { message: "boom" } } },
  });
  const bridge = new ImBridge(
    { systemHint: "HINT", qq: { requireMention: false }, wechat: {} },
    makeLogger(),
    dsh
  );
  bridge.qq = qq;
  await bridge.handleQqEvent({
    post_type: "message",
    message_type: "private",
    user_id: 222,
    message: [{ type: "text", data: { text: "hi" } }],
  });
  assert.equal(state.prompts.length, 1);
  assert.ok(calls.private[0].text.includes("出错"));
});
