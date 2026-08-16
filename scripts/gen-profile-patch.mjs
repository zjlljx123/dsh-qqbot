// Generate the profile-level cordis.patch.yml for dsh-qqbot:
// row-patch (not insert) restating the plugin's config with wechat disabled.
import { readFileSync, writeFileSync } from "node:fs";

const prof = process.argv[2] || "C:/Users/ZJL/.dsh/profiles/web";
const src = readFileSync(`${prof}/dsh-qqbot/cordis.patch.yml`, "utf8");
const lines = src.split(/\r?\n/);
const idx = lines.findIndex((l) => /^\s+config:\s*$/.test(l));
if (idx < 0) throw new Error("config block not found");
const cfg = lines.slice(idx + 1).map((l) => (l.startsWith("    ") ? l.slice(4) : l));
let out = ["- id: dsh-qqbot", "  config:", ...cfg].join("\n");
// wechat.enabled: true -> false
out = out.replace(
  /(\n\s*wechat:\n)(\s*)(enabled: true)/,
  (m, head, indent) => `${head}${indent}enabled: false`
);
writeFileSync(`${prof}/cordis.patch.yml`, out, "utf8");
const check = readFileSync(`${prof}/cordis.patch.yml`, "utf8");
console.log("qq.enabled:", /qq:\r?\n\s+enabled: (\w+)/.exec(check)?.[1]);
console.log("wechat.enabled:", /wechat:\r?\n\s+enabled: (\w+)/.exec(check)?.[1]);
console.log("systemHint ok:", check.includes("你正在通过"));
