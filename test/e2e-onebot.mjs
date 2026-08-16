/**
 * End-to-end smoke test: boot a DSH web profile with dsh-qqbot, feed one
 * QQ private message through a mock OneBot v11 WebSocket server, and verify
 * the agent's reply is delivered back to the mock server.
 *
 * Usage:
 *   node test/e2e-onebot.mjs <dshBin> <profile> <port> <mockWsPort> [timeoutMs]
 *
 * Prereqs: the profile must have dsh-qqbot installed and its profile
 * cordis.patch.yml must point qq.wsUrl at ws://127.0.0.1:<mockWsPort>.
 */
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const [dshBin, profile, port, mockPort, timeoutArg] = process.argv.slice(2);
const timeoutMs = Number(timeoutArg || 150000);
const mockUrl = `ws://127.0.0.1:${mockPort}`;

let resolved = false;
const replies = [];

const wss = new WebSocketServer({ port: Number(mockPort) });
console.log(`[mock] OneBot WS listening on ${mockUrl}`);

wss.on("connection", (ws) => {
  console.log("[mock] plugin connected");
  ws.on("message", (data) => {
    let req;
    try { req = JSON.parse(data.toString("utf8")); } catch { return; }
    if (req.action === "get_login_info") {
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 10001, nickname: "mock-bot" }, echo: req.echo }));
      return;
    }
    if (req.action === "send_private_msg") {
      const text = (req.params?.message || [])
        .map((s) => (s?.type === "text" ? s.data?.text || "" : s?.data?.text || ""))
        .join("");
      console.log(`[mock] REPLY: ${text}`);
      replies.push(text);
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 9 }, echo: req.echo }));
      resolved = true;
      return;
    }
    if (req.action === "upload_private_file") {
      console.log(`[mock] FILE_UPLOAD: ${req.params?.file}`);
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { file_id: "f1" }, echo: req.echo }));
      return;
    }
    ws.send(JSON.stringify({ status: "ok", retcode: 0, data: {}, echo: req.echo }));
  });

  // simulate a private chat message once the plugin is connected
  setTimeout(() => {
    if (resolved) return;
    const text = process.env.MOCK_MESSAGE || "请只回复这一句：端到端测试成功";
    console.log(`[mock] sending simulated private message: ${text}`);
    ws.send(JSON.stringify({
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: 1,
      user_id: 222,
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      sender: { user_id: 222, nickname: "测试用户" },
      message: [{ type: "text", data: { text } }],
      raw_message: text,
    }));
  }, 1500);
});

// boot DSH
const child = spawn(process.execPath, [dshBin, "--profile", profile, "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (d) => { bootLog += d; process.stdout.write(d); });
child.stderr.on("data", (d) => { bootLog += d; process.stderr.write(d); });

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline && !resolved) {
  await delay(1000);
}

if (resolved) {
  console.log("\n=== E2E PASS ===");
  console.log(replies.join("\n"));
  child.kill();
  wss.close();
  process.exit(0);
} else {
  console.error("\n=== E2E FAIL: no reply within timeout ===");
  console.error("boot log tail:\n" + bootLog.split("\n").slice(-40).join("\n"));
  child.kill();
  wss.close();
  process.exit(1);
}
