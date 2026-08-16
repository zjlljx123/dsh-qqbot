/**
 * dsh-qqbot —— QQ (OneBot v11 / NapCat) 接入 DSH 的聊天机器人插件。
 *
 * Cordis plugin entry. FAIL-SAFE BY DESIGN: nothing here may ever throw into
 * the DSH boot path. All bridge connections are optional, retried in the
 * background, and guarded by try/catch, so `dsh web` always starts even when
 * NapCat is not running yet.
 *
 * ⚠️ 免责声明：通过第三方非官方协议（NapCat）接入 QQ，存在封号风险，请务必使用
 * 小号，仅供学习交流（详见 DISCLAIMER.md）。
 *
 * 同时注册 Web 控制台路由（/api/qqbot/*），让用户在浏览器里启停 NapCat、
 * 查看状态和扫码登录（见 lib/control.js 与 lib/client.js）。
 */
import { ImBridge } from "./bridge.js";
import { registerControlRoutes } from "./control.js";
import { Logger } from "./logger.js";

export const name = "dsh-qqbot";

/** 需要 webServer 就绪后才激活（用于注册控制台路由）。 */
export const inject = ["webServer"];

/** Schema defaults; overridden by the bundle patch / profile cordis.patch.yml. */
export const config = {
  enabled: true,
  logLevel: "info",
  stateDir: "",
  workspaceRoot: "",
  systemHint:
    "你正在通过 QQ 聊天工具与用户对话。回复会直接发送给用户，请用用户的语言、简洁、友好、直接地回复，不要输出 Markdown 围栏、也不要输出内部工具调用细节。如果需要向用户发送文件（例如你生成或修改的文件、图片、压缩包），请在回复中单独一行写：/send <文件的绝对路径>（每行一个文件，路径必须是本机绝对路径）。注意：/send 的路径必须真实存在——不确定时先用文件工具确认，绝对不要编造路径或猜测文件名。如果用户发来了文件，文件路径会在消息中给出，你可以用文件工具读取。",
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
    // 微信端（WeChatFerry）为可选实验功能，默认关闭。开启需自行准备 wcf 并承担更高风险。
    enabled: false,
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
    // Web 控制台（浏览器里启停 NapCat / 扫码）使用的路径配置。
    // 通用默认值留空 = 未配置（聊天功能不受影响，仅控制台不可用）；
    // 请在你的 profile cordis.patch.yml 里填成自己的 NapCat 路径与 QQ 号。
    runDir: "",
    qqExe: "",
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
    log.warn(
      "免责声明：本插件通过第三方非官方协议（NapCat）接入 QQ，存在账号风控/封号风险，" +
        "请务必使用小号，仅供学习交流（详见 DISCLAIMER.md）。"
    );
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
  }, "dsh-qqbot");
}
