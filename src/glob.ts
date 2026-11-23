import { readdir } from "node:fs/promises";
import path from "node:path";

const SKIPPED = new Set(["node_modules", ".git"]);

export function hasMagic(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
}

/** `**` crosses folders, `*` and `?` stay inside one, `{a,b}` and `[abc]` choose; paths use forward slashes. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      out += slash ? "(?:[^/]+/)*" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const close = p.indexOf("}", i);
      if (close < 0) out += "\\{";
      else {
        out += `(?:${p.slice(i + 1, close).split(",").map((s) => s.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = close;
      }
    } else if (ch === "[") {
      const close = p.indexOf("]", i);
      if (close < 0) out += "\\[";
      else {
        out += `[${p.slice(i + 1, close).replace(/^!/, "^")}]`;
        i = close;
      }
    } else out += ch.replace(/[.+^$()|\\\]}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, root, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

export async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
  const normal = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normal.split("/");
  const fixed: string[] = [];
  for (const segment of segments) {
    if (hasMagic(segment)) break;
    fixed.push(segment);
  }
  const base = path.resolve(cwd, ...fixed);
  const files: string[] = [];
  await walk(base, path.resolve(cwd), files);
  const matcher = globToRegExp(path.isAbsolute(normal) ? path.relative(cwd, normal).split(path.sep).join("/") : normal);
  return files.filter((file) => matcher.test(file)).sort();
}
