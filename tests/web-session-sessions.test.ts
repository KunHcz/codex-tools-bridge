import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSessionRuntime } from "../src/web-session/sessions";

class FakeServer {
  completeOnTerminate = true;
  calls: { method: string; params: any }[] = [];
  notify?: (event: { method: string; params: unknown }) => void;
  pending = new Map<string, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  threads = new Set<string>();
  durable = new Set<string>();
  async start() {}
  onNotification(callback: (event: { method: string; params: unknown }) => void) { this.notify = callback; return () => { this.notify = undefined; }; }
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/start") { const id = crypto.randomUUID(); this.threads.add(id); return { thread: { id } } as T; }
    if (method === "thread/inject_items") { this.durable.add(params.threadId); return {} as T; }
    if (method === "thread/resume" && !this.durable.has(params.threadId)) throw new Error("no rollout found");
    if (method === "command/exec") return new Promise<T>((resolve, reject) => this.pending.set(params.processId, { resolve, reject }));
    if (method === "command/exec/terminate" && this.completeOnTerminate) this.pending.get(params.processId)?.resolve({ exitCode: 137 });
    return {} as T;
  }
  output(id: string, text: string, stream = "stdout") { this.notify?.({ method: "command/exec/outputDelta", params: { processId: id, stream, deltaBase64: Buffer.from(text).toString("base64") } }); }
  async close() { for (const job of this.pending.values()) job.reject(new Error("closed")); }
}
const roots: string[] = [];
const runtimes: WebSessionRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "web-session-runtime-")); roots.push(root);
  const workspaceRoot = join(root, "workspace"); await mkdir(workspaceRoot);
  const stateDir = join(root, "state");
  const appServer = new FakeServer();
  const runtime = new WebSessionRuntime({ stateDir, workspaceRoot, appServer }); runtimes.push(runtime);
  return { root, workspaceRoot, stateDir, appServer, runtime };
}

describe("web-owned session runtime", () => {
  test("two Desktop slots are assigned atomically to distinct chats without creating native tasks", async () => {
    const { runtime, appServer, stateDir, workspaceRoot } = await setup();
    const one = await runtime.open(); const two = await runtime.open();
    await runtime.close();
    const server = new FakeServer(); server.durable = appServer.durable;
    const pool = new WebSessionRuntime({ stateDir, workspaceRoot, appServer: server, desktopThreadId: [one.threadId, two.threadId] });
    runtimes.push(pool);
    await pool.prepareDesktop();
    const opened = await Promise.allSettled(["chat-one", "chat-two", "chat-three"].map(requestKey => pool.open({ requestKey })));
    expect(opened.filter(x => x.status === "fulfilled")).toHaveLength(2);
    expect(opened.filter(x => x.status === "rejected")).toHaveLength(1);
    const first = await pool.open({ requestKey: "chat-one" });
    const second = await pool.open({ requestKey: "chat-two" });
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(server.calls.filter(c => c.method === "thread/start")).toHaveLength(0);
    await expect(pool.open({ sessionId: first.sessionId, requestKey: "chat-two" })).rejects.toThrow("different conversations");
    await pool.close();
    const restarted = new WebSessionRuntime({ stateDir, workspaceRoot, appServer: server, desktopThreadId: [one.threadId, two.threadId] });
    runtimes.push(restarted);
    expect((await restarted.open({ requestKey: "chat-one" })).sessionId).toBe(first.sessionId);
    expect((await restarted.open({ requestKey: "chat-two" })).sessionId).toBe(second.sessionId);
    await expect(restarted.open({ requestKey: "chat-three" })).rejects.toThrow("capacity reached (2)");
  });
  test("rejects another conversation's request key instead of silently sharing its session", async () => {
    const { runtime, appServer } = await setup();
    const one = await runtime.open({ requestKey: "conversation-one" });
    await expect(runtime.open({ sessionId: one.sessionId, requestKey: "conversation-two" })).rejects.toThrow("different conversations");
    expect((await runtime.open({ sessionId: one.sessionId, requestKey: "conversation-one" })).sessionId).toBe(one.sessionId);
    expect(appServer.calls.filter(c => c.method === "thread/start")).toHaveLength(1);
  });
  test("idempotent open creates one native durable thread and restart resumes that ID", async () => {
    const { runtime, appServer, stateDir, workspaceRoot } = await setup();
    const [one, duplicate] = await Promise.all([runtime.open({ title: "Web task", requestKey: "chat-123" }), runtime.open({ requestKey: "chat-123" })]);
    expect(one.sessionId).toBe(duplicate.sessionId);
    expect(appServer.calls.filter(c => c.method === "thread/start")).toHaveLength(1);
    expect(appServer.durable.has(one.threadId)).toBe(true);
    await runtime.close();
    const secondServer = new FakeServer(); secondServer.durable = appServer.durable;
    const second = new WebSessionRuntime({ stateDir, workspaceRoot, appServer: secondServer }); runtimes.push(second);
    const restored = await second.open({ sessionId: one.sessionId });
    expect(restored).toEqual(one);
    expect(secondServer.calls.some(c => c.method === "thread/resume" && c.params.threadId === one.threadId)).toBe(true);
    expect(secondServer.calls.some(c => c.method === "thread/start")).toBe(false);
  });
  test("rejects lexical traversal, outside symlinks, dangling symlinks and unknown sessions", async () => {
    const { runtime, root, workspaceRoot } = await setup();
    const session = await runtime.open();
    await writeFile(join(root, "outside.txt"), "private");
    await symlink(join(root, "outside.txt"), join(workspaceRoot, "escape"));
    await symlink(join(root, "missing"), join(workspaceRoot, "dangling"));
    await symlink(root, join(workspaceRoot, "outside-directory"));
    for (const path of ["../outside.txt", "escape", "outside-directory/outside.txt"]) await expect(runtime.readFile(session.sessionId, path)).rejects.toThrow(/outside/);
    await expect(runtime.writeFile(session.sessionId, "dangling", "bad")).rejects.toThrow(/dangling/);
    await expect(runtime.writeFile(session.sessionId, "outside-directory/new.txt", "bad")).rejects.toThrow(/outside/);
    await expect(runtime.readFile("invalid", "hello")).rejects.toThrow(/Unknown/);
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("private");
  });
  test("writes use hashes to prevent lost changes and keep content out of audit", async () => {
    const { runtime, stateDir, appServer } = await setup();
    const { sessionId } = await runtime.open();
    const created = await runtime.writeFile(sessionId, "hello.txt", "first-private-content", "");
    expect(created.created).toBe(true);
    await expect(runtime.writeFile(sessionId, "hello.txt", "replace", "")).rejects.toThrow(/changed/);
    await expect(runtime.writeFile(sessionId, "hello.txt", "replace")).rejects.toThrow(/require/);
    const current = await runtime.readFile(sessionId, "hello.txt");
    expect(current.sha256).toBe(created.sha256);
    await runtime.writeFile(sessionId, "hello.txt", "updated-private-content", current.sha256);
    await expect(runtime.writeFile(sessionId, "hello.txt", "stale", current.sha256)).rejects.toThrow(/changed/);
    expect((await runtime.readFile(sessionId, "hello.txt")).content).toBe("updated-private-content");
    const audit = await readFile(join(stateDir, "operations.jsonl"), "utf8");
    expect(audit).not.toContain("private-content");
    expect(JSON.stringify(appServer.calls)).not.toContain("private-content");
    await expect(runtime.writeFile(sessionId, "too-big", "x".repeat(1024 * 1024 + 1))).rejects.toThrow(/limit/);
  });
  test("image reads detect signatures and text reads reject binary and oversized files", async () => {
    const { runtime, workspaceRoot } = await setup(); const { sessionId } = await runtime.open();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
    await writeFile(join(workspaceRoot, "mislabeled.bin"), png);
    expect((await runtime.viewImage(sessionId, "mislabeled.bin")).mimeType).toBe("image/png");
    await expect(runtime.readFile(sessionId, "mislabeled.bin")).rejects.toThrow();
    await writeFile(join(workspaceRoot, "fake.png"), "not an image");
    await expect(runtime.viewImage(sessionId, "fake.png")).rejects.toThrow(/Unsupported/);
    await writeFile(join(workspaceRoot, "huge"), Buffer.alloc(1024 * 1024 + 1));
    await expect(runtime.readFile(sessionId, "huge")).rejects.toThrow(/limit/);
  });
  test("commands are async, bounded, sandboxed, and jobs belong to one session", async () => {
    const { runtime, appServer, workspaceRoot } = await setup();
    const one = await runtime.open(); const two = await runtime.open();
    const job = await runtime.exec(one.sessionId, { command: ["/bin/echo", "hello"], timeoutMs: 1000 });
    expect(job.state).toBe("running");
    await expect(runtime.poll(two.sessionId, job.jobId)).rejects.toThrow(/Unknown jobId/);
    await expect(runtime.cancel(two.sessionId, job.jobId)).rejects.toThrow(/Unknown jobId/);
    const call = appServer.calls.find(c => c.method === "command/exec")!;
    expect(call.params.sandboxPolicy).toMatchObject({ type: "workspaceWrite", writableRoots: [await import("node:fs/promises").then(fs => fs.realpath(workspaceRoot))], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    const chinese = Buffer.from("你好");
    for (const chunk of [chinese.subarray(0, 2), chinese.subarray(2)]) appServer.notify?.({ method: "command/exec/outputDelta", params: { processId: job.jobId, stream: "stdout", deltaBase64: chunk.toString("base64") } });
    expect((await runtime.poll(one.sessionId, job.jobId)).stdout).toBe("你好");
    appServer.output(job.jobId, "中".repeat(100000));
    expect(Buffer.byteLength((await runtime.poll(one.sessionId, job.jobId)).stdout)).toBeLessThanOrEqual(65536);
    expect((await runtime.poll(one.sessionId, job.jobId)).outputTruncated).toBe(true);
    appServer.pending.get(job.jobId)!.resolve({ exitCode: 0 });
    await Bun.sleep(10);
    expect((await runtime.poll(one.sessionId, job.jobId)).state).toBe("completed");
  });
  test("parallel job submissions are capped and session info omits command output", async () => {
    const { runtime, appServer } = await setup();
    const { sessionId } = await runtime.open();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => runtime.exec(sessionId, { command: ["/bin/sleep", "5"] })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(8);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(4);
    expect(appServer.calls.filter(c => c.method === "command/exec")).toHaveLength(8);
    const job = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.exec>>>).value;
    appServer.output(job.jobId, "output-only-in-poll");
    expect(JSON.stringify(await runtime.info(sessionId))).not.toContain("output-only-in-poll");
    expect((await runtime.poll(sessionId, job.jobId)).stdout).toBe("output-only-in-poll");
  });
  test("cancel terminates the matching command; RPC failure does not retry execution", async () => {
    const { runtime, appServer } = await setup(); const { sessionId } = await runtime.open();
    const job = await runtime.exec(sessionId, { command: ["/bin/sleep", "10"] });
    await runtime.cancel(sessionId, job.jobId);
    await Bun.sleep(10);
    expect((await runtime.poll(sessionId, job.jobId)).state).toBe("cancelled");
    expect(appServer.calls.filter(c => c.method === "command/exec/terminate")).toHaveLength(1);
    const failing = await runtime.exec(sessionId, { command: ["/bin/false"] });
    appServer.pending.get(failing.jobId)!.reject(new Error("transport disconnected"));
    await Bun.sleep(10);
    expect((await runtime.poll(sessionId, failing.jobId)).state).toBe("failed");
    expect(appServer.calls.filter(c => c.method === "command/exec")).toHaveLength(2);
  });
  test("cancel acknowledgement stays running until the process actually exits", async () => {
    const { runtime, appServer } = await setup();
    const { sessionId } = await runtime.open();
    appServer.completeOnTerminate = false;
    const job = await runtime.exec(sessionId, { command: ["/bin/sleep", "10"] });
    expect((await runtime.cancel(sessionId, job.jobId)).state).toBe("running");
    expect((await runtime.poll(sessionId, job.jobId)).finishedAt).toBeUndefined();
    appServer.pending.get(job.jobId)!.resolve({ exitCode: 137 });
    await Bun.sleep(10);
    const stopped = await runtime.poll(sessionId, job.jobId);
    expect(stopped.state).toBe("cancelled");
    expect(stopped.exitCode).toBe(137);
    expect(stopped.finishedAt).toBeDefined();
  });
  test("completed and interrupted job states survive restart without persisting output", async () => {
    const { runtime, appServer, stateDir, workspaceRoot } = await setup();
    const session = await runtime.open();
    const success = await runtime.exec(session.sessionId, { command: ["/bin/echo", "private output"] });
    appServer.output(success.jobId, "private output");
    appServer.pending.get(success.jobId)!.resolve({ exitCode: 0 });
    const failed = await runtime.exec(session.sessionId, { command: ["/bin/false"] });
    appServer.pending.get(failed.jobId)!.resolve({ exitCode: 2 });
    const running = await runtime.exec(session.sessionId, { command: ["/bin/sleep", "10"] });
    await Bun.sleep(10);
    expect((await runtime.poll(session.sessionId, failed.jobId)).state).toBe("failed");
    await runtime.close();
    const persisted = await readFile(join(stateDir, "jobs.json"), "utf8");
    expect(persisted).not.toContain("private output");
    const nextServer = new FakeServer(); nextServer.durable = appServer.durable;
    const next = new WebSessionRuntime({ stateDir, workspaceRoot, appServer: nextServer }); runtimes.push(next);
    expect((await next.poll(session.sessionId, success.jobId)).state).toBe("completed");
    expect((await next.poll(session.sessionId, failed.jobId)).state).toBe("failed");
    expect((await next.poll(session.sessionId, running.jobId)).state).toBe("interrupted");
    expect((await next.poll(session.sessionId, success.jobId)).outputOmittedOnRestore).toBe(true);
  });
  test("a successful write returns an audit warning if audit storage fails", async () => {
    const { runtime, stateDir } = await setup(); const session = await runtime.open();
    await rm(join(stateDir, "operations.jsonl"));
    await mkdir(join(stateDir, "operations.jsonl"));
    const result = await runtime.writeFile(session.sessionId, "audit-warning.txt", "write succeeded", "");
    expect(result.auditWarning).toContain("write succeeded");
    expect((await runtime.readFile(session.sessionId, "audit-warning.txt")).content).toBe("write succeeded");
  });

});
