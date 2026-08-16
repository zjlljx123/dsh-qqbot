/**
 * Minimal leveled logger with a built-in rate limiter for repeated messages
 * (used by reconnect loops so the DSH console does not get spammed).
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export class Logger {
  constructor(level = "info") {
    this.level = LEVELS[level] ?? LEVELS.info;
    this._last = new Map();
  }

  _log(level, tag, args) {
    if (level > this.level) return;
    const line = `[dsh-qqbot] ${tag} ${args
      .map((a) => (typeof a === "string" ? a : safeStringify(a)))
      .join(" ")}`;
    const now = Date.now();
    const last = this._last.get(line) ?? 0;
    if (now - last < 10000) return; // rate limit identical lines to once/10s
    this._last.set(line, now);
    if (level <= LEVELS.error) console.error(line);
    else if (level === LEVELS.warn) console.warn(line);
    else console.log(line);
  }

  error(...args) { this._log(LEVELS.error, "[error]", args); }
  warn(...args) { this._log(LEVELS.warn, "[warn]", args); }
  info(...args) { this._log(LEVELS.info, "[info]", args); }
  debug(...args) { this._log(LEVELS.debug, "[debug]", args); }
}

export function safeStringify(v) {
  try {
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  } catch {
    return String(v);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
