/**
 * Small shared helpers: text chunking, path resolution for /send, inbound
 * file download/copy, OneBot CQ-string parsing.
 */
import { existsSync, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { basename, join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

/** Split text into chunks of at most maxChars, preferring line breaks. */
export function chunkText(text, maxChars) {
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    if (line.length > maxChars) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Resolve a raw /send path to an absolute path. Returns null when invalid. */
export function resolveSendPath(raw, cwd) {
  if (!raw || typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p) return null;
  // strip surrounding quotes
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  if (p.startsWith("file://")) p = p.slice("file://".length);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = join(homedir(), p.slice(2));
  }
  if (!isAbsolute(p)) {
    p = resolve(cwd || process.cwd(), p);
  }
  if (!existsSync(p)) return null;
  return p;
}

/**
 * Materialize an inbound file into `dir`: copy a local path, or download an
 * http(s) URL. Returns the saved absolute path or null.
 */
export async function materializeFile({ url, localPath, name, dir }) {
  try {
    await mkdir(dir, { recursive: true });
    const safeName = safeBasename(name || url || "file");
    if (url && /^https?:\/\//i.test(url)) {
      const target = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
      const ok = await downloadUrl(url, target);
      return ok ? target : null;
    }
    if (localPath) {
      let src = localPath;
      if (src.startsWith("file://")) src = src.slice("file://".length);
      if (!isAbsolute(src)) src = resolve(src);
      if (!existsSync(src)) return null;
      const target = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
      try {
        await copyFile(src, target);
        return target;
      } catch (e) {
        // same-volume fallback (copy can fail on some edge cases)
        try { await rename(src, target); return target; } catch { return null; }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Download a URL to a file. Returns true on success. */
export async function downloadUrl(url, target) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) return false;
    const file = createWriteStream(target);
    await new Promise((resolve, reject) => {
      res.body.pipe(file);
      res.body.on("error", reject);
      file.on("finish", resolve);
      file.on("error", reject);
    });
    return true;
  } catch {
    return false;
  }
}

function safeBasename(name) {
  const base = basename(String(name || "file")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
  return base || "file";
}

/** OneBot CQ string -> array of segments (minimal parser). */
export function parseCqString(text) {
  const segments = [];
  const re = /\[CQ:([a-zA-Z]+)((?:,[^\[\]]*?)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", data: { text: text.slice(last, m.index) } });
    }
    const data = {};
    const params = m[2];
    if (params) {
      const paramRe = /,([a-zA-Z0-9_]+)=([^,\[\]]*)/g;
      let pm;
      while ((pm = paramRe.exec(params)) !== null) {
        data[pm[1]] = decodeURIComponent(pm[2]);
      }
    }
    segments.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", data: { text: text.slice(last) } });
  }
  return segments;
}

/** Simple stat wrapper. */
export async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}
