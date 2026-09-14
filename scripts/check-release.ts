import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const skip = new Set([".git", "node_modules", "dist", "coverage"]);
const files: string[] = [];
async function walk(directory: string) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (skip.has(item.name)) continue;
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("Release contains a symlink: " + relative(root, path));
    if (item.isDirectory()) await walk(path); else files.push(path);
  }
}
await walk(root);
const failures: string[] = [];
const secrets = [
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{25,}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /chatgpt\.com\/c\/[a-f0-9-]{30,}/i,
  /\b[A-Za-z0-9._%+-]+@(?:qq|163)\.com\b/i,
];
const forbidden = /(?:^|\/)(?:\.env(?:\..*)?|\.codex|state|\.state|tunnel-profiles|sessions\.json|desktop\.json|connection\.json|jobs\.json|auth\.json)(?:\/|$)|\.(?:log|jsonl|pem|key|sqlite|db|png|jpg|zip)$/i;
for (const path of files) {
  const name = relative(root, path);
  if (forbidden.test(name)) failures.push(name + ": private/runtime or unreviewed binary artifact");
  const size = (await lstat(path)).size;
  if (size > 1024 * 1024) { failures.push(name + ": oversized release file"); continue; }
  const text = await readFile(path, "utf8");
  if (secrets.some(pattern => pattern.test(text))) failures.push(name + ": possible credential/private identifier (value withheld)");
  if (name.endsWith(".md")) for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]!;
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const url = new URL(target.split("#")[0]!, "file://" + path);
    try { await lstat(fileURLToPath(url)); } catch { failures.push(name + ": broken local link " + target); }
  }
}
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (Object.keys(pkg.dependencies).sort().join(",") !== "@modelcontextprotocol/sdk,zod") failures.push("Review new direct runtime dependencies before release");
for (const required of ["LICENSE", "LICENSES/upstream-MIT.txt", "NOTICE.md", "UPSTREAM.json", "README.md", "README.zh-CN.md", "SECURITY.md", "bun.lock"]) {
  if (!files.includes(join(root, required))) failures.push("Missing " + required);
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Release hygiene passed for ${files.length} files. This is a heuristic check, not a security audit.`);
