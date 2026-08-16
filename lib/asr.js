/**
 * dsh-qqbot ASR: 常驻 Python 服务（模型只加载一次，识别秒回）。
 *
 * 协议: 每行一个 JSON 请求 {"path":..., "lang":...}，
 *       每行一个 JSON 响应 {"ok":true,"text":...} / {"ok":false,"error":...}
 *
 * 依赖:
 *   - Python (py -3) + faster-whisper + pilk（见 lib/asr_server.py）
 *   - 首次启动自动下载 whisper 模型（small 约 460MB，可用 ASR_MODEL_DIR 指定目录）
 */
import { spawn } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PY = join(__dirname, "asr_server.py");
const DBG_LOG = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE || "C:/Users/ZJL", ".dsh"),
  "im-bridge",
  "state",
  "debug.log"
);

let server = null; // { proc, queue, buffer }
let booting = null;
let LAST_OPTS = {}; // 最近一次启动参数，用于崩溃后自动重启

function spawnServer({ python, model }) {
  const proc = spawn(python, ["-3", SERVER_PY, "--model", model || "small"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { proc, queue: [], buffer: "" };
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    state.buffer += chunk;
    let idx;
    while ((idx = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, idx).trim();
      state.buffer = state.buffer.slice(idx + 1);
      if (!line) continue;
      const waiter = state.queue.shift();
      if (!waiter) continue;
      try {
        const msg = JSON.parse(line);
        waiter.resolve(msg);
      } catch {
        waiter.resolve({ ok: false, error: "bad response" });
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    try { appendFileSync(DBG_LOG, `[asr-server] ${String(chunk).trim()}\n`, "utf8"); } catch { /* ignore */ }
  });
  proc.on("exit", (code, signal) => {
    // 通知所有等待者失败
    for (const w of state.queue) w.resolve({ ok: false, error: "server exited" });
    state.queue.length = 0;
    const wasActive = server === state;
    if (server === state) server = null;
    console.warn(`[dsh-qqbot] ASR server exited code=${code} signal=${signal} wasActive=${wasActive}`);
    // 崩溃后自动重启保持常驻（避免下条语音重新等模型加载）
    if (wasActive && !booting) {
      setTimeout(() => {
        getServer(LAST_OPTS).catch(() => {});
      }, 1500);
    }
  });
  return state;
}

function getServer(opts) {
  LAST_OPTS = { ...(opts || {}) };
  if (server && server.proc.exitCode === null) return Promise.resolve(server);
  if (booting) return booting;
  booting = new Promise((resolve, reject) => {
    const s = spawnServer(opts);
    // 等待就绪信号
    const onReady = () => {
      booting = null;
      server = s;
      resolve(s);
    };
    // 复用 queue 机制等待 ready
    s.queue.push({ resolve: onReady });
    // 启动失败保护
    s.proc.once("error", (e) => {
      booting = null;
      reject(e);
    });
  });
  return booting;
}

/** 把音频文件转成文字。失败返回 ""（不影响主流程）。 */
export async function transcribeAudio(audioPath, opts = {}) {
  const { python = "py", model, lang = "zh", timeoutMs = 180000 } = opts;
  if (!audioPath || !existsSync(audioPath)) return "";
  try {
    const s = await getServer({ python, model });
    const result = await new Promise((resolve) => {
      let waiter = null;
      const timer = setTimeout(() => {
        if (waiter) {
          const i = s.queue.indexOf(waiter);
          if (i >= 0) s.queue.splice(i, 1);
        }
        resolve({ ok: false, error: "asr timeout" });
      }, timeoutMs);
      waiter = {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      };
      s.queue.push(waiter);
      s.proc.stdin.write(JSON.stringify({ path: audioPath, lang }) + "\n");
    });
    if (result && result.ok) return String(result.text || "").trim();
    console.warn("[dsh-qqbot] 语音识别失败:", result?.error || "unknown");
    return "";
  } catch (e) {
    console.warn("[dsh-qqbot] 语音识别异常:", e.message);
    return "";
  }
}

/** 预热：启动常驻服务并加载模型（不处理任务）。返回是否就绪。 */
export async function warmupAsr(opts = {}) {
  const { python = "py", model } = opts;
  try {
    const s = await getServer({ python, model });
    return !!(s && s.proc.exitCode === null);
  } catch {
    return false;
  }
}

/** 判断一个本地路径是不是 QQ 语音(silk)文件。 */
export function isSilkFile(p) {
  return /\.silk$/i.test(String(p || ""));
}
