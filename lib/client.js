/* dsh-im-bridge —— 客户端半：IM 桥接控制台面板
 * 打包格式：window.__ModuleLoader__.load({ id, factory })。
 * 功能：
 *   - 设置页「IM 桥接控制台」区块：NapCat 启停 / 状态 / 登录二维码 / 重启 DSH
 *   - 右下角悬浮按钮，随时展开同一个面板
 * 数据来自宿主路由 /api/im-bridge/*。
 */
window.__ModuleLoader__.load({
  id: "dsh-im-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useCallback = react.useCallback;

    // ---- 样式 ----
    var COLORS = {
      ok: "var(--dsw-alias-state-success-primary, #16a34a)",
      warn: "var(--dsw-alias-state-warning-primary, #d97706)",
      err: "var(--dsw-alias-state-error-primary, #dc2626)",
      label: "var(--dsw-alias-label-primary, #111)",
      sub: "var(--dsw-alias-label-tertiary, #888)",
      border: "var(--dsw-alias-border-l2, rgba(0,0,0,0.08))",
      bg: "var(--dsw-alias-fill-l2, rgba(0,0,0,0.03))",
    };
    var BTN = {
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "6px 14px", borderRadius: 8, border: "1px solid " + COLORS.border,
      background: "#fff", color: COLORS.label, fontSize: 13, cursor: "pointer",
      fontWeight: 500, fontFamily: "inherit",
    };
    var BTN_PRIMARY = Object.assign({}, BTN, { background: "var(--dsw-alias-state-success-primary, #16a34a)", color: "#fff", borderColor: "transparent" });
    var BTN_DANGER = Object.assign({}, BTN, { background: "var(--dsw-alias-state-error-primary, #dc2626)", color: "#fff", borderColor: "transparent" });
    var BTN_SMALL = Object.assign({}, BTN, { padding: "3px 10px", fontSize: 12 });
    var CARD = { border: "1px solid " + COLORS.border, borderRadius: 12, padding: "12px 14px", background: COLORS.bg };
    var ROW = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, margin: "6px 0", flexWrap: "wrap" };

    function Dot(ok, text) {
      return h("span", { style: { color: ok ? COLORS.ok : COLORS.err, fontWeight: 600, whiteSpace: "nowrap" } }, ok ? "● " : "○ ", text);
    }
    function Row(label, node) {
      return h("div", { style: ROW },
        h("span", { style: { color: COLORS.sub, width: 92, flex: "none" } }, label),
        node
      );
    }

    function Panel(props) {
      var compact = !!props.compact;
      var [st, setSt] = useState(null);
      var [busy, setBusy] = useState("");
      var [err, setErr] = useState("");
      var [tick, setTick] = useState(0);

      var refresh = useCallback(function () {
        fetch("/api/im-bridge/status", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (d) { setSt(d); setErr(""); })
          .catch(function (e) { setErr(String(e)); });
      }, []);

      useEffect(function () {
        refresh();
        var t = setInterval(refresh, 3000);
        return function () { clearInterval(t); };
      }, [refresh]);

      function act(name, url, body) {
        if (busy) return;
        setBusy(name);
        setErr("");
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (!d.ok) setErr(d.error || "操作失败"); setTimeout(refresh, 1500); })
          .catch(function (e) { setErr(String(e)); })
          .finally(function () { setBusy(""); });
      }

      function restartDsh() {
        if (!window.confirm("确定重启 DSH Web 吗？页面会断开约 10 秒，之后自动恢复。")) return;
        act("restart", "/api/im-bridge/restart-dsh");
      }

      var nap = (st && st.napcat) || {};
      var br = (st && st.bridge) || {};
      var notLoggedIn = !nap.loggedIn;

      return h("div", { style: { fontFamily: "inherit" } },
        // ---- 状态 ----
        h("div", { style: CARD },
          h("div", { style: { fontSize: 14, fontWeight: 600, color: COLORS.label, marginBottom: 8 } }, "QQ 机器人（NapCat）"),
          Row("NapCat 进程", nap.running ? Dot(true, "运行中") : Dot(false, "未运行")),
          Row("QQ 客户端", nap.qqRunning ? Dot(true, "运行中") : Dot(false, "未运行")),
          Row("OneBot 端口", nap.port3001 ? Dot(true, "3001 已监听") : Dot(false, "3001 未监听")),
          Row("登录状态", nap.loggedIn
            ? Dot(true, "已登录" + (nap.account ? "（" + nap.account + "）" : ""))
            : Dot(false, "未登录" + (nap.qrcode ? "，请扫码 ↓" : ""))),
          Row("DSH 插件", br.qqConnected ? Dot(true, "QQ 已连接") : Dot(false, "QQ 未连接")),
          br.chatCount ? Row("会话数", h("span", { style: { color: COLORS.label } }, String(br.chatCount))) : null,
          h("div", { style: Object.assign({}, ROW, { marginTop: 10 }) },
            h("button", { style: BTN_PRIMARY, disabled: !!busy || nap.running, onClick: function () { act("start", "/api/im-bridge/napcat/start"); } }, busy === "start" ? "启动中…" : "▶ 启动 NapCat"),
            h("button", { style: BTN_DANGER, disabled: !!busy || !nap.running, onClick: function () { act("stop", "/api/im-bridge/napcat/stop"); } }, busy === "stop" ? "停止中…" : "■ 停止 NapCat"),
            nap.webuiUrl
              ? h("a", { href: nap.webuiUrl, target: "_blank", rel: "noreferrer", style: Object.assign({}, BTN, { textDecoration: "none" }) }, "NapCat 管理面板 ↗")
              : null,
            h("button", { style: BTN, disabled: !!busy, onClick: restartDsh }, busy === "restart" ? "重启中…" : "↻ 重启 DSH"),
          ),
        ),

        // ---- 二维码 ----
        notLoggedIn && nap.qrcode
          ? h("div", { style: Object.assign({}, CARD, { marginTop: 10, textAlign: "center" }) },
              h("div", { style: { fontSize: 13, color: COLORS.label, marginBottom: 8 } },
                "用「机器人小号」的 QQ 扫码登录", nap.loginUrl ? h("span", { style: { color: COLORS.sub } }, "（过期自动刷新）") : null),
              h("img", {
                src: "/api/im-bridge/napcat/qrcode?t=" + Date.now() + Math.floor(Math.random() * 1000),
                style: { width: 180, height: 180, imageRendering: "pixelated", borderRadius: 8, background: "#fff", border: "1px solid " + COLORS.border },
                alt: "登录二维码",
                onClick: function () { setTick(tick + 1); },
                onError: function () { setTimeout(function () { setTick(tick + 1); }, 3000); },
              }),
              nap.loginUrl
                ? h("div", { style: { fontSize: 11, color: COLORS.sub, marginTop: 6, wordBreak: "break-all" } }, nap.loginUrl)
                : null
            )
          : null,

        // ------- 桥接信息 -------
        h("div", { style: Object.assign({}, CARD, { marginTop: 10 }) },
          h("div", { style: { fontSize: 13, fontWeight: 600, color: COLORS.label, marginBottom: 6 } }, "桥接信息"),
          Row("微信通道", br.wechatConnected ? Dot(true, "已连接") : Dot(false, "已关闭/未连接")),
          Row("插件状态", st && st.ok ? Dot(true, "正常") : Dot(false, "未知")),
          st && st.bootLogTail
            ? h("pre", { style: { fontSize: 11, color: COLORS.sub, margin: "6px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 120, overflow: "auto" } }, st.bootLogTail)
            : null,
        ),

        err ? h("div", { style: { fontSize: 12, color: COLORS.err, marginTop: 8 } }, String(err)) : null
      );
    }

    // ---- 悬浮按钮（右下角）----
    function FloatingLauncher() {
      var [open, setOpen] = useState(false);
      return h("div", { style: { position: "fixed", right: 20, bottom: 20, zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 } },
        open
          ? h("div", { style: { width: 340, maxHeight: "70vh", overflow: "auto", background: "#fff", borderRadius: 12, boxShadow: "0 8px 30px rgba(0,0,0,0.18)", border: "1px solid " + COLORS.border, padding: 14 } },
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
                h("span", { style: { fontSize: 14, fontWeight: 600, color: COLORS.label } }, "IM 桥接控制台"),
                h("button", { style: Object.assign({}, BTN_SMALL, { color: COLORS.sub }), onClick: function () { setOpen(false); } }, "✕")),
              h(Panel, { compact: true })
            )
          : null,
        h("button", {
          onClick: function () { setOpen(!open); },
          style: {
            width: 52, height: 52, borderRadius: "50%", cursor: "pointer",
            background: "linear-gradient(135deg,#1f9d5c,#12b886)",
            color: "#fff", border: "none", fontSize: 20, boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
          title: "IM 桥接控制台",
        }, open ? "✕" : "🤖")
      );
    }

    // ---- 设置页区块 ----
    function SettingsSection() {
      return h("div", { style: { maxWidth: 640 } },
        h(Panel, { compact: false }),
        h("div", { style: { fontSize: 12, color: COLORS.sub, marginTop: 10, lineHeight: 1.6 } },
          "提示：控制台可启停 QQ 机器人（NapCat）、查看登录二维码。文件收发与对话功能在对应聊天里直接使用即可。")
      );
    }

    var inject = ["slots"];
    function apply(ctx) {
      var slots = null;
      try { slots = ctx.get("slots"); } catch (e) {}
      if (!slots) return;
      ctx.effect(function () {
        return slots.inject("shell.overlay", function () {
          return slots.register(
            { name: "shell.overlay", id: "dsh-im-bridge-fab", order: 200, label: "IM Bridge" },
            FloatingLauncher
          );
        });
      }, "dsh-im-bridge: shell.overlay");
      ctx.effect(function () {
        return slots.inject("settings.section", function () {
          return slots.register(
            { name: "settings.section", id: "dsh-im-bridge-panel", order: 80, label: () => "IM 桥接控制台" },
            SettingsSection
          );
        });
      }, "dsh-im-bridge: settings.section");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
