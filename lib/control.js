/**
 * dsh-im-bridge 控制台：通过 DSH Web 服务的 HTTP 路由暴露 NapCat 启停 / 状态 / 二维码，
 * 供浏览器端控制面板调用。
 *
 * 路由：
 *   GET  /api/im-bridge/status          状态（NapCat 进程/端口/登录态/二维码/桥接连接）
 *   POST /api/im-bridge/napcat/start    启动 NapCat（后台分离进程）
 *   POST /api/im-bridge/napcat/stop     停止 NapCat
 *   GET  /api/im-bridge/napcat/qrcode   返回当前登录二维码 PNG
 *   POST /api/im-bridge/restart-dsh     重启 DSH Web（延迟 3 秒，实验性）
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NapcatManager } from "./napcat-manager.js";

export function registerControlRoutes(ctx, cfg, log, getBridge) {
  const manager = new NapcatManager(cfg.napcat || {}, log);
  const webServer = ctx.get("webServer");
  if (!webServer) {
    log.warn("webServer 服务不可用，控制台路由未注册");
    return () => {};
  }

  const offs = [];
  const register = (opts) => {
    try { offs.push(webServer.register(opts)); } catch (e) { log.warn("控制台路由注册失败:", e.message); }
  };

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  };

  register({
    kind: "exact",
    path: "/api/im-bridge/status",
    handler: async (_req, res) => {
      try {
        const s = await manager.status();
        let bridge = null;
        try { bridge = getBridge(); } catch { /* not ready yet */ }
        sendJson(res, 200, {
          ok: true,
          ...s,
          bridge: {
            enabled: cfg.enabled !== false,
            qqConnected: !!(bridge && bridge.qq && bridge.qq.connected),
            wechatConnected: !!(bridge && bridge.wcf && bridge.wcf.connected),
            chatCount: bridge ? Object.keys(bridge.dsh.chats).length : 0,
          },
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    },
  });

  register({
    kind: "exact",
    path: "/api/im-bridge/napcat/start",
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await manager.start());
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    },
  });

  register({
    kind: "exact",
    path: "/api/im-bridge/napcat/stop",
    handler: async (_req, res) => {
      try {
        sendJson(res, 200, await manager.stop());
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    },
  });

  register({
    kind: "exact",
    path: "/api/im-bridge/napcat/qrcode",
    handler: (_req, res) => {
      const stream = manager.qrcodeStream();
      if (!stream) {
        sendJson(res, 404, { ok: false, error: "暂无二维码，请先启动 NapCat" });
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      stream.pipe(res);
    },
  });

  register({
    kind: "exact",
    path: "/api/im-bridge/restart-dsh",
    handler: (_req, res) => {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        const script = join(here, "..", "scripts", "restart-dsh.ps1");
        const child = spawn(
          "powershell",
          ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script, "-Delay", "3"],
          { detached: true, stdio: "ignore", windowsHide: true }
        );
        child.unref();
        sendJson(res, 200, { ok: true, message: "DSH 将在 3 秒后重启，页面会短暂断开，请稍后刷新" });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    },
  });

  return () => {
    for (const f of offs) { try { f(); } catch { /* ignore */ } }
  };
}
