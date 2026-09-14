import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop, readDesktopSetup } from "../src/setup";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "bridge-setup-test-")); roots.push(root); return root; }
test("missing setup is standalone, not guessed from personal config", async () => { expect(await readDesktopSetup(await fixture())).toBeUndefined(); });
test("rejects symlinked setup", async () => {
  const root = await fixture(); await writeFile(join(root, "secret.txt"), "{}"); await symlink(join(root, "secret.txt"), join(root, "desktop.json"));
  await expect(readDesktopSetup(root)).rejects.toThrow("Invalid desktop setup");
});
test("rejects malformed setup", async () => {
  const root = await fixture(); await writeFile(join(root, "desktop.json"), JSON.stringify({ version: 1, workspaceRoot: "relative" }));
  await expect(readDesktopSetup(root)).rejects.toThrow();
});
test("existing runtime is never overwritten or started", async () => {
  const root = await fixture(); const workspace = join(root, "workspace"), state = join(root, "state");
  await mkdir(workspace); await mkdir(state); await writeFile(join(state, "sessions.json"), "do-not-change");
  await expect(prepareDesktop({ workspaceRoot: workspace, stateDir: state, registryPath: join(root, "registry.toml"), codexBinary: "/not/a/real/binary" })).rejects.toThrow("fresh state");
  expect(await readFile(join(state, "sessions.json"), "utf8")).toBe("do-not-change");
});
test("existing project configuration is never overwritten", async () => {
  const root = await fixture(); const workspace = join(root, "workspace"); await mkdir(join(workspace, ".codex"), { recursive: true });
  await writeFile(join(workspace, ".codex/config.toml"), "# user owned\n");
  await expect(prepareDesktop({ workspaceRoot: workspace, stateDir: join(root, "state"), registryPath: join(root, "registry.toml"), codexBinary: "/not/a/real/binary" })).rejects.toThrow("dedicated workspace");
  expect(await readFile(join(workspace, ".codex/config.toml"), "utf8")).toBe("# user owned\n");
});

test("fresh installation refuses an existing named provider before altering workspace config", async () => {
  const root = await fixture(), workspace = join(root, "workspace"), registryPath = join(root, "registry.toml");
  await mkdir(workspace);
  const original = '[model_providers.codex_web_sessions]\nbase_url = "http://127.0.0.1:12345/existing/v1"\n';
  await writeFile(registryPath, original);
  await expect(prepareDesktop({ workspaceRoot: workspace, stateDir: join(root, "state"), registryPath, codexBinary: "/not/a/real/binary" })).rejects.toThrow("already registered");
  expect(await readFile(registryPath, "utf8")).toBe(original);
  expect(await Bun.file(join(workspace, ".codex/config.toml")).exists()).toBe(false);
});

test("fresh setup persists a local-only seed and never starts a model turn (fake native process)", async () => {
  const root = await fixture(), workspace = join(root, "workspace"), state = join(root, "state"), registryPath = join(root, "registry.toml");
  await mkdir(workspace);
  const binary = join(root, "fake-codex"), transcript = join(root, "rpc-transcript.txt");
  const fake = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = ${JSON.stringify(transcript)};
const thread = { id: '11111111-1111-4111-8111-111111111111', modelProvider: 'codex_web_sessions' };
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify(request) + '\\n');
  if (request.id == null) continue;
  const result = request.method === 'thread/start' ? { thread } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`;
  await writeFile(binary, fake); await chmod(binary, 0o700);
  const setup = await prepareDesktop({ workspaceRoot: workspace, stateDir: state, registryPath, codexBinary: binary });
  expect(await readDesktopSetup(state)).toEqual(setup);
  const sessions = JSON.parse(await readFile(join(state, "sessions.json"), "utf8"));
  expect(sessions).toHaveLength(1);
  expect(sessions[0].requestKey).toBe("internal-discovery-seed");
  const requests = (await readFile(transcript, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(requests.some(r => r.method === "turn/start")).toBe(false);
  const start = requests.find(r => r.method === "thread/start");
  expect(start.params.modelProvider).toBe("codex_web_sessions");
  expect(start.params.approvalPolicy).toBe("on-request");
  expect(start.params.sandbox).toBe("workspace-write");
  expect(start.params.config["model_providers.codex_web_sessions"].base_url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const registry = Bun.TOML.parse(await readFile(registryPath, "utf8")) as Record<string, any>;
  expect(registry.model_provider).toBeUndefined();
  expect(registry.model_providers.codex_web_sessions).toBeDefined();
}, 10000);
