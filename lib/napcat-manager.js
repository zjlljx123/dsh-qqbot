/**
 * NapCat 管理器：从 DSH 进程内启停 NapCat、读取状态与登录二维码。
 *
 * 设计：所有路径来自插件配置（napcat.*）。留空 = 未配置：聊天功能照常工作
 * （插件只连 OneBot WS），仅控制台的启停/二维码不可用。
 * 启停通过 spawn 分离进程实现，输出重定向到 boot.log（用于解析 token/二维码/登录态）。
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, createReadStream, statSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import net from "node:net";

export class NapcatManager {
  constructor(cfg, log) {
    const n = cfg || {};
    this.runDir = (n.runDir || "").trim();
    this.qqExe = (n.qqExe || "").trim();
    this.hookDll = (n.hookDll || "").trim();
    this.wsPort = n.wsPort ?? 3001;
    this.webuiPort = n.webuiPort ?? 6099;
    this.account = n.account || "";
    this.log = log;
    // 未配置时这些路径无效；status/start/qrcode 统一返回 configured:false
    this.bootLog = this.runDir ? join(this.runDir, "boot.log") : "";
    this.qrcodeFile = this.runDir ? join(this.runDir, "cache", "qrcode.png") : "";
  }

  get configured() {
    return !!(this.runDir && this.qqExe);
  }

  /* ---------------- helpers ---------------- */

  _processRunning(name) {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Measure-Object).Count"`,
        { encoding: "utf8", windowsHide: true }
      );
      return parseInt(out.trim(), 10) > 0;
    } catch {
      return false;
    }
  }

  _portOpen(port) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      const done = (ok) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(1200);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
      sock.connect(port, "127.0.0.1");
    });
  }

  async _readBootLog() {
    try {
      return await readFile(this.bootLog, "utf8");
    } catch {
      return "";
    }
  }

  _stripAnsi(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, "");
  }

  _firstMatch(text, re) {
    const m = re.exec(text);
    return m ? m[1] : null;
  }

  /* ---------------- status ---------------- */

  async status() {
    const boot = this._stripAnsi(await this._readBootLog());
    const [qqRunning, bootRunning, port3001, webuiOpen] = await Promise.all([
      Promise.resolve(this._processRunning("QQ")),
      Promise.resolve(this._processRunning("NapCatWinBootMain")),
      this._portOpen(this.wsPort),
      this._portOpen(this.webuiPort),
    ]);

    const token = this._firstMatch(boot, /WebUi Token:\s*(\S+)/);
    const webuiUrl = this._firstMatch(boot, /WebUi User Panel Url:\s*(\S+)/);
    const loginUrl = this._firstMatch(boot, /(https:\/\/txz\.qq\.com\/p\?[^\s]+)/);
    let account = this.account;
    if (!account && this.runDir) {
      // 从 config 目录的 onebot11_<qq>.json 推断
      try {
        const { readdirSync } = await import("node:fs");
        const files = readdirSync(join(this.runDir, "config"));
        const m = files.find((f) => /^onebot11_(\d+)\.json$/.test(f));
        if (m) account = /^onebot11_(\d+)\.json$/.exec(m)[1];
      } catch { /* ignore */ }
    }

    let qrcode = null;
    try {
      if (this.qrcodeFile && existsSync(this.qrcodeFile)) {
        const st = statSync(this.qrcodeFile);
        qrcode = { path: this.qrcodeFile, mtime: st.mtimeMs, size: st.size };
      }
    } catch { /* ignore */ }

    return {
      configured: this.configured,
      napcat: {
        running: bootRunning || qqRunning,
        bootRunning,
        qqRunning,
        port3001,
        webuiOpen,
        loggedIn: port3001, // OneBot 适配器在登录后才会启动 WS 服务
        account: account || null,
        webuiToken: token || null,
        webuiUrl: webuiUrl || null,
        loginUrl: loginUrl || null,
        qrcode,
      },
      bootLogTail: boot.split("\n").slice(-6).join("\n"),
    };
  }

  /* ---------------- start / stop ---------------- */

  async start() {
    if (!this.configured) {
      return { ok: false, error: "napcat.runDir / qqExe 未配置：请在 profile 的 cordis.patch.yml 里填写你的 NapCat 路径" };
    }
    if (this._processRunning("NapCatWinBootMain")) {
      return { ok: true, already: true };
    }
    await this.stop().catch(() => {});
    if (!existsSync(this.qqExe)) return { ok: false, error: `QQ.exe 不存在: ${this.qqExe}` };

    // hookDll / bootMain 缺省时按 runDir 推导
    const hookDll = this.hookDll || join(this.runDir, "NapCatWinBootHook.dll");
    const bootMain = this.bootMain || join(this.runDir, "NapCatWinBootMain.exe");
    if (!existsSync(bootMain)) return { ok: false, error: `NapCatWinBootMain.exe 不存在: ${bootMain}` };
    if (!existsSync(hookDll)) return { ok: false, error: `NapCatWinBootHook.dll 不存在: ${hookDll}` };

    const env = {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: join(this.runDir, "qqnt.json"),
      NAPCAT_LOAD_PATH: join(this.runDir, "loadNapCat.js"),
      NAPCAT_INJECT_PATH: hookDll,
      NAPCAT_LAUNCHER_PATH: bootMain,
      NAPCAT_MAIN_PATH: join(this.runDir, "napcat.mjs"),
    };
    const args = [this.qqExe, hookDll];
    if (this.account) args.push("-q", this.account);

    const outFd = openSync(this.bootLog, "a");
    const errFd = openSync(join(this.runDir, "boot.err"), "a");
    const child = spawn(bootMain, args, {
      cwd: this.runDir,
      env,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.unref();
    this.log.info(`NapCat 启动中 (pid=${child.pid})`);
    return { ok: true, pid: child.pid };
  }

  async stop() {
    const killed = [];
    for (const name of ["NapCatWinBootMain", "QQEX", "QQ"]) {
      try {
        execSync(`powershell -NoProfile -Command "Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Stop-Process -Force"`, { windowsHide: true });
        killed.push(name);
      } catch { /* none */ }
    }
    this.log.info(`NapCat 已停止 (${killed.join(", ") || "无进程"})`);
    return { ok: true, killed };
  }

  qrcodeStream() {
    if (!existsSync(this.qrcodeFile)) return null;
    return createReadStream(this.qrcodeFile);
  }
}
