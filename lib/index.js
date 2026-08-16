/**
 * dsh-im-bridge —— QQ (OneBot v11/NapCat) + 个人微信 (WeChatFerry) 接入 DSH。
 *
 * Cordis plugin entry. FAIL-SAFE BY DESIGN: nothing here may ever throw into
 * the DSH boot path. All bridge connections are optional, retried in the
 * background, and guarded by try/catch, so `dsh web` always starts even when
 * NapCat / WeChatFerry are not running yet.
 *
 * 同时注册 Web 控制台路由（/api/im-bridge/*），让用户在浏览器里启停 NapCat、
 * 查看状态和扫码登录（见 lib/control.js 与 lib/client.js）。
 */
import { ImBridge } from "./bridge.js";
import { registerControlRoutes } from "./control.js";
import { Logger } from "./logger.js";

export const name = "dsh-im-bridge";

/** 需要 webServer 就绪后才激活（用于注册控制台路由），与 dsh-usagi-pet 同模式。 */
export const inject = ["webServer"];

/** Schema defaults; overridden by the bundle patch / profile cordis.patch.yml. */
export const config = {
  enabled: true,
  logLevel: "info",
  stateDir: "",
  workspaceRoot: "",
  systemHint:
    "你正在通过 QQ / 微信聊天工具与用户对话。回复会直接发送给用户，请用用户的语言、简洁、友好、直接地回复，不要输出 Markdown 围栏、也不要输出内部工具调用细节。如果需要向用户发送文件（例如你生成或修改的文件、图片、压缩包），请在回复中单独一行写：/send <文件的绝对路径>（每行一个文件，路径必须是本机绝对路径）。如果用户发来了文件，文件路径会在消息中给出，你可以用文件工具读取。",
  qq: {
    enabled: true,
    wsUrl: "ws://127.0.0.1:3001",
    accessToken: "",
    selfId: 0,
    requireMention: true,
    adminOnly: false,
    admins: [],
    allowedChats: [],
    blockedChats: [],
    maxMessageChars: 4000,
  },
  wechat: {
    enabled: true,
    host: "127.0.0.1",
    port: 10086,
    requireMention: false,
    triggerKeyword: "",
    adminOnly: false,
    admins: [],
    allowedChats: [],
    blockedChats: [],
    maxMessageChars: 2000,
    wechatFilesDir: "",
  },
  napcat: {
    runDir: "D:/work/DshWorkspace/NapCat/run",
    qqExe: "D:/work/DshWorkspace/QQNT22/Files/QQ.exe",
    hookDll: "",
    wsPort: 3001,
    webuiPort: 6099,
    account: "",
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...(base || {}) };
  for (const key of Object.keys(over)) {
    const b = base?.[key];
    const o = over[key];
    if (o && typeof o === "object" && !Array.isArray(o) && b && typeof b === "object" && !Array.isArray(b)) {
      out[key] = deepMerge(b, o);
    } else {
      out[key] = o;
    }
  }
  return out;
}

export function apply(ctx, cfg) {
  const merged = deepMerge(config, cfg || {});
  if (merged.enabled === false) return;

  ctx.effect(() => {
    const log = new Logger(merged.logLevel || "info");
    let bridge = null;
    let disposed = false;
    const offRoutes = registerControlRoutes(ctx, merged, log, () => bridge);

    const boot = (async () => {
      try {
        bridge = await ImBridge.create(ctx, merged);
        if (disposed) {
          await bridge.dispose();
          bridge = null;
        }
      } catch (e) {
        log.error("启动失败（DSH 正常运行不受影响）:", e.message || e);
      }
    })();

    return () => {
      disposed = true;
      try { offRoutes(); } catch { /* ignore */ }
      void boot.then(() => bridge?.dispose()).catch(() => {});
    };
  }, "dsh-im-bridge");
}
