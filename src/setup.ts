import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { CodexAppServer } from "./web-session/app-server";
import { NativeHarness } from "./web-session/native-harness";
import { writeDesktopProviderConfig, writeDesktopProviderRegistry } from "./web-session/desktop-provider";
import type { WebSession } from "./web-session/sessions";

export interface DesktopSetup {
  version: 1; workspaceRoot: string; threadId: string; codexBinary: string;
  registryPath: string; title: string;
}
export async function readDesktopSetup(stateDir: string): Promise<DesktopSetup | undefined> {
  const path = join(stateDir, "desktop.json");
  let info;
  try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("Invalid desktop setup file");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: DesktopSetup;
  try { data = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
  if (data.version !== 1 || !isAbsolute(data.workspaceRoot ?? "") || !isAbsolute(data.registryPath ?? "") ||
      !/^[a-f0-9-]{36}$/.test(data.threadId ?? "") || !data.codexBinary || /[\r\n\0]/.test(data.codexBinary) || typeof data.title !== "string") throw new Error("Invalid desktop setup; do not reuse another installation's state");
  return data;
}
async function atomicCreate(path: string, data: unknown) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}

/** Explicit installation only. Creates a saved local task but NEVER starts a turn.
 * The temporary App Server writer is closed before Desktop takes over. */
export async function prepareDesktop(options: {
  workspaceRoot: string; stateDir: string; codexBinary: string; registryPath: string;
}): Promise<DesktopSetup> {
  if (![options.workspaceRoot, options.stateDir, options.registryPath].every(isAbsolute)) throw new Error("Setup paths must be absolute");
  const cwd = await realpath(options.workspaceRoot);
  if (options.stateDir === cwd || options.stateDir.startsWith(cwd + "/")) throw new Error("Keep private runtime state outside the workspace");
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const stateStat = await lstat(options.stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error("State directory must not be a symlink");
  const lockPath = join(options.stateDir, ".setup.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let server: CodexAppServer | undefined, harness: NativeHarness | undefined;
  let threadId: string | undefined, saved = false;
  try {
    if ((await readdir(options.stateDir)).some(name => name !== ".setup.lock")) throw new Error("Setup needs a fresh state directory; existing runtimes are never overwritten");
    try { await lstat(join(cwd, ".codex", "config.toml")); throw new Error("Use a dedicated workspace without an existing .codex/config.toml"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // A fresh instance must not replace an already registered provider from a
    // different live bridge, even when its ownership marker looks familiar.
    try {
      const registryStat = await lstat(options.registryPath);
      if (!registryStat.isFile() || registryStat.isSymbolicLink() || registryStat.size > 4 * 1024 * 1024) throw new Error("Invalid provider registry");
      const registry = await open(options.registryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const parsed = Bun.TOML.parse(await registry.readFile("utf8")) as Record<string, any>;
        if (Object.prototype.hasOwnProperty.call(parsed.model_providers ?? {}, "codex_web_sessions")) throw new Error("codex_web_sessions is already registered; refusing to replace an existing host. Use a separate native profile or plan an explicit migration.");
      } finally { await registry.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    server = new CodexAppServer({ binary: options.codexBinary, cwd });
    harness = new NativeHarness(server);
    const prepared = await harness.prepare(cwd);
    const base = prepared.params.config["model_providers.codex_web_sessions"].base_url;
    await writeDesktopProviderConfig(cwd, base);
    await writeDesktopProviderRegistry(options.registryPath, base);
    const created = await server.request<any>("thread/start", { cwd, sandbox: "workspace-write", ephemeral: false, ...prepared.params });
    threadId = created.thread?.id;
    if (!threadId || created.thread?.modelProvider !== "codex_web_sessions") throw new Error("Dedicated local provider was not accepted; no model turn was started");
    const title = "Codex Tools Bridge · local tool host";
    await server.request("thread/inject_items", { threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Dedicated Codex Tools Bridge tool host. Keep the codex_web_sessions local provider. Wait for ChatGPT Web tool requests; do not use another model provider." }] }] });
    await server.request("thread/name/set", { threadId, name: title });
    const session: WebSession = { sessionId: randomUUID(), threadId, cwd, title, createdAt: new Date().toISOString(), requestKey: "internal-discovery-seed", preparedDesktopSlot: true };
    const setup: DesktopSetup = { version: 1, workspaceRoot: cwd, threadId, codexBinary: options.codexBinary, registryPath: options.registryPath, title };
    await atomicCreate(join(options.stateDir, "sessions.json"), [session]);
    await atomicCreate(join(options.stateDir, "desktop.json"), setup);
    saved = true;
    return setup;
  } finally {
    if (threadId && !saved) await server?.request("thread/archive", { threadId }).catch(() => {});
    await harness?.close();
    await server?.close();
    await lock.close();
    await unlink(lockPath);
    // Owned provider configuration deliberately remains fail-closed after errors.
    // No rollback may silently select a remote model or change global defaults.
  }
}
