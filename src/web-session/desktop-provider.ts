import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MARKER = "# Managed by Codex Web Sessions desktop provider v1";
const writes = new Map<string, Promise<void>>();

/** Keep the endpoint stable because an already loaded Desktop task caches its provider. */
export async function readDesktopProviderEndpoint(cwd: string): Promise<{ port: number; key: string } | undefined> {
  const directory = join(cwd, ".codex");
  const folder = await existing(directory);
  if (!folder) return;
  if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error("Desktop provider config directory must not be a symlink");
  const path = join(directory, "config.toml");
  const stat = await existing(path);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid desktop provider config");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!unchanged(stat, await file.stat())) throw new Error("Desktop provider config changed during inspection");
    const contents = await file.readFile("utf8");
    if (!contents.startsWith(`${MARKER}\n`)) throw new Error("Refusing to reuse an unowned desktop provider config");
    const value = (Bun.TOML.parse(contents) as any).model_providers?.codex_web_sessions?.base_url;
    if (typeof value !== "string") throw new Error("Desktop provider endpoint missing");
    providerConfig(value); // Validate the same strict loopback route accepted by the writer.
    const url = new URL(value);
    return { port: Number(url.port), key: url.pathname.split("/")[1]! };
  } finally { await file.close(); }
}

function providerConfig(baseUrl: string): string {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/[a-f0-9]{48}\/v1$/.exec(baseUrl);
  if (!match || match[0] !== baseUrl || Number(match[1]) > 65535) throw new Error("Desktop provider must use the dedicated loopback Responses route");
  return `${MARKER}
# Keep this configuration when the relay stops: an offline relay must fail closed.
model_provider = "codex_web_sessions"
approvals_reviewer = "user"

[model_providers.codex_web_sessions]
name = "ChatGPT Web local tool relay"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;
}

async function existing(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function unchanged(before: Stats | undefined, after: Stats | undefined): boolean {
  return before == null || after == null ? before === after
    : before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function writeConfig(cwd: string, contents: string): Promise<void> {
  const root = await lstat(cwd);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Desktop provider workspace must be a real directory");
  const canonical = await realpath(cwd);
  if (canonical === await realpath(homedir())) throw new Error("Desktop provider cannot modify global Codex configuration");
  const directory = join(canonical, ".codex");
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Desktop provider config directory must not be a symlink");
  const destination = join(directory, "config.toml");
  const previous = await existing(destination);
  if (previous) {
    if (previous.isSymbolicLink() || !previous.isFile()) throw new Error("Desktop provider config must be a regular file, not a symlink");
    const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!unchanged(previous, await file.stat())) throw new Error("Desktop provider config changed during inspection");
      const prefix = Buffer.alloc(Buffer.byteLength(MARKER) + 1);
      const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
      if (bytesRead !== prefix.length || prefix.toString() !== `${MARKER}\n`) throw new Error("Refusing to overwrite a config not owned by the desktop provider");
    } finally { await file.close(); }
  }
  const temporary = join(directory, `.web-provider-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await file.chmod(0o600);
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally { await file.close(); }
    const currentDirectory = await lstat(directory);
    if (currentDirectory.isSymbolicLink() || currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino || !unchanged(previous, await existing(destination))) {
      throw new Error("Desktop provider config changed during write");
    }
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

/** Only the dedicated workspace config is owned here; there is no global setting or cleanup fallback. */
export async function writeDesktopProviderConfig(cwd: string, baseUrl: string): Promise<void> {
  const contents = providerConfig(baseUrl);
  if (!isAbsolute(cwd)) throw new Error("Desktop provider workspace must be an absolute path");
  const path = resolve(cwd);
  const previous = writes.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeConfig(path, contents));
  writes.set(path, pending);
  try { await pending; }
  finally { if (writes.get(path) === pending) writes.delete(path); }
}

const REGISTRY_BEGIN = "# BEGIN Codex Web Sessions provider definition v1";
const REGISTRY_END = "# END Codex Web Sessions provider definition v1";

function parseRegistry(contents: string): Record<string, any> {
  try { return Bun.TOML.parse(contents) as Record<string, any>; }
  catch { throw new Error("Desktop provider registry must be valid TOML"); }
}

function updateRegistry(contents: string, definition: string): string {
  const original = parseRegistry(contents);
  const begins = [...contents.matchAll(/^# BEGIN Codex Web Sessions provider definition v1\r?$/gm)];
  const ends = [...contents.matchAll(/^# END Codex Web Sessions provider definition v1\r?$/gm)];
  if (begins.length !== ends.length || begins.length > 1) throw new Error("Desktop provider registry ownership markers are invalid");
  let before = contents, after = "";
  if (begins.length) {
    if (!original.model_providers?.codex_web_sessions) throw new Error("Desktop provider registry ownership markers are not a provider definition");
    const begin = begins[0]!, end = ends[0]!;
    if (end.index! <= begin.index!) throw new Error("Desktop provider registry ownership markers are invalid");
    const block = contents.slice(begin.index, end.index! + end[0].length);
    const owned = parseRegistry(block);
    if (Object.keys(owned).length !== 1 || Object.keys(owned.model_providers ?? {}).length !== 1 || !owned.model_providers.codex_web_sessions) {
      throw new Error("Desktop provider owned block contains unrelated settings");
    }
    before = contents.slice(0, begin.index);
    after = contents.slice(end.index! + end[0].length);
    // Bare keys after the end marker still belong to the provider's TOML table.
    const following = after.split(/\r?\n/).find(line => line.trim() && !line.trim().startsWith("#"));
    if (following != null && !following.trim().startsWith("[")) throw new Error("Desktop provider has unowned settings after its block");
  }
  const unrelated = parseRegistry(before + after);
  if (Object.prototype.hasOwnProperty.call(unrelated.model_providers ?? {}, "codex_web_sessions")) throw new Error("Refusing to overwrite a user-owned codex_web_sessions provider");
  const block = `${REGISTRY_BEGIN}\n${definition}${REGISTRY_END}`;
  const updated = begins.length ? before + block + after : contents + (contents.endsWith("\n") || !contents ? "" : "\n") + (contents ? "\n" : "") + block + "\n";
  parseRegistry(updated);
  return updated;
}

/** Explicit opt-in registry path only. Adds a named provider; never selects a default provider. */
export async function writeDesktopProviderRegistry(registryPath: string, baseUrl: string): Promise<void> {
  const config = providerConfig(baseUrl);
  const definition = config.slice(config.indexOf("[model_providers.codex_web_sessions]"));
  if (!isAbsolute(registryPath)) throw new Error("Desktop provider registry must be an absolute path");
  const requested = resolve(registryPath), directory = dirname(requested);
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Desktop provider registry directory must not be a symlink");
  const canonical = await realpath(directory), destination = join(canonical, basename(requested));
  const lockPath = join(canonical, `.${basename(requested)}.web-session.lock`);
  let lock;
  try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Desktop provider registry is being updated concurrently"); throw error; }
  const temporary = join(canonical, `.web-provider-${randomUUID()}.tmp`);
  try {
    const previous = await existing(destination);
    let contents = "";
    if (previous) {
      if (previous.isSymbolicLink() || !previous.isFile()) throw new Error("Desktop provider registry must not be a symlink");
      if (previous.size > 4 * 1024 * 1024) throw new Error("Desktop provider registry is too large");
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!unchanged(previous, await file.stat())) throw new Error("Desktop provider registry changed during inspection");
        contents = await file.readFile("utf8");
      } finally { await file.close(); }
    }
    const updated = updateRegistry(contents, definition);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(updated, "utf8"); await file.sync(); }
    finally { await file.close(); }
    const currentDirectory = await lstat(directory);
    if (currentDirectory.isSymbolicLink() || directoryStat.dev !== currentDirectory.dev || directoryStat.ino !== currentDirectory.ino || !unchanged(previous, await existing(destination))) throw new Error("Desktop provider registry changed during write");
    await rename(temporary, destination);
  } finally {
    try { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
