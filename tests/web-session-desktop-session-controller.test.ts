import { afterEach, describe, expect, test } from "bun:test";
import { DesktopSessionController, type DesktopSessionControllerOptions, type DesktopStartupRecord } from "../src/web-session/desktop-session-controller";

const controllers: DesktopSessionController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); });

function fixture(overrides: Partial<DesktopSessionControllerOptions> = {}) {
  const cwd = "/tmp/desktop-controller-workspace";
  const endpoint = { port: 57891, key: "a".repeat(48) };
  const threads = new Map<string, any>([["seed", { id: "seed", cwd, modelProvider: "codex_web_sessions" }]]);
  const connected = new Set(["seed"]);
  const requests: { method: string; params: any }[] = [];
  const dispatched: { seedThreadId: string; threadId: string; prompt: string }[] = [];
  const attached: string[] = [];
  const stopped: string[] = [];
  let created = 0;
  const writers = new Set<string>();
  const config: any = { model_providers: { codex_web_sessions: { base_url: `http://127.0.0.1:${endpoint.port}/${endpoint.key}/v1`, wire_api: "responses", requires_openai_auth: false } } };
  const sharedRequest = async (method: string, params: any): Promise<any> => {
    requests.push({ method, params });
    if (method === "config/read") return { config };
    if (method === "thread/read") {
      if (writers.has(params.threadId)) throw new Error("creator still owns writer during restore");
      return { thread: threads.get(params.threadId) };
    }
    if (method === "thread/start") throw new Error("shared server must not create a thread");
    return {};
  };
  const options: DesktopSessionControllerOptions = {
    cwd, seedThreadId: "seed", idleMs: 30, startupTimeoutMs: 40, pollMs: 2,
    readEndpoint: async () => endpoint,
    server: { request: sharedRequest },
    createPreparationServer: () => {
      const ownedWriters = new Set<string>();
      return {
        async request(method, params: any) {
          if (method === "thread/start") {
            requests.push({ method, params });
            const thread = { id: `worker-${++created}`, cwd, modelProvider: params.modelProvider };
            threads.set(thread.id, thread); writers.add(thread.id); ownedWriters.add(thread.id);
            return { thread } as any;
          }
          // Unlike process exit, thread/unsubscribe deliberately leaves writers held.
          return sharedRequest(method, params);
        },
        async close() {
          await Bun.sleep(1);
          for (const threadId of ownedWriters) writers.delete(threadId);
          requests.push({ method: "preparation/closed", params: {} });
        },
      };
    },
    attachThread: async descriptor => { attached.push(descriptor.threadId); },
    sendFromSeed: async request => { if (writers.has(request.threadId)) throw new Error("already has an active writer"); dispatched.push(request); connected.add(request.threadId); },
    stopDriver: async threadId => { stopped.push(threadId); connected.delete(threadId); },
    driverStatus: threadId => ({ toolDriverConnected: connected.has(threadId), queuedRequests: 0 }),
    ...overrides,
  };
  const controller = new DesktopSessionController(options);
  controllers.push(controller);
  return { controller, config, threads, connected, requests, dispatched, attached, stopped, options, writers };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 150 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe("Desktop session controller", () => {
  test("only creator process close releases the writer and it completes before restore and dispatch", async () => {
    const f = fixture();
    const creator = f.options.createPreparationServer!();
    const created: any = await creator.request("thread/start", { modelProvider: "codex_web_sessions" });
    await creator.request("thread/unsubscribe", { threadId: created.thread.id });
    expect(f.writers.has(created.thread.id)).toBe(true);
    await creator.close();
    expect(f.writers.has(created.thread.id)).toBe(false);
    f.requests.length = 0;
    const session = await f.controller.prepare("worker");
    expect(f.requests.findIndex(request => request.method === "preparation/closed")).toBeLessThan(f.requests.findIndex(request => request.method === "thread/read"));
    await f.controller.ensureStarted(session.threadId);
    expect(f.dispatched).toHaveLength(1);
    expect(f.writers.has(session.threadId)).toBe(false);
  });

  test("deduplicates preparation by conversation key without merging equal titles across chats", async () => {
    const f = fixture();
    const [first, duplicate, other] = await Promise.all([
      f.controller.prepare("same title", "chat-one"),
      f.controller.prepare("same title", "chat-one"),
      f.controller.prepare("same title", "chat-two"),
    ]);
    expect(duplicate.threadId).toBe(first.threadId);
    expect(other.threadId).not.toBe(first.threadId);
    expect(f.requests.filter(request => request.method === "thread/start")).toHaveLength(2);
    expect((await f.controller.prepare("renamed title", "chat-one")).threadId).toBe(first.threadId);
    expect(f.requests.filter(request => request.method === "thread/start")).toHaveLength(2);
  });

  test("concurrent restores attach once and cannot replace existing pins", async () => {
    const f = fixture();
    await Promise.all([f.controller.restore("seed", "seed"), f.controller.restore("seed", "seed")]);
    f.controller.pin("seed", "existing-repl");
    await f.controller.restore("seed", "renamed seed");
    expect(f.attached).toEqual(["seed"]);
    expect(f.controller.status("seed").statefulPins).toEqual(["existing-repl"]);
  });

  test("prepares metadata without a model turn and uses one native seed dispatch for concurrent starts", async () => {
    const f = fixture();
    const session = await f.controller.prepare("网页代码聊天");
    expect(f.dispatched).toHaveLength(0);
    expect(f.attached).toEqual([session.threadId]);
    expect(f.requests.findIndex(request => request.method === "thread/inject_items")).toBeLessThan(f.requests.findIndex(request => request.method === "thread/read"));
    expect(f.requests.find(request => request.method === "thread/start")?.params).toMatchObject({ modelProvider: "codex_web_sessions", allowProviderModelFallback: false, approvalsReviewer: "user" });
    await Promise.all([f.controller.ensureStarted(session.threadId), f.controller.ensureStarted(session.threadId)]);
    expect(f.dispatched).toHaveLength(1);
    expect(Object.keys(f.dispatched[0]!).sort()).toEqual(["prompt", "seedThreadId", "threadId"]);
    expect(f.controller.status(session.threadId)).toMatchObject({ lifecycle: "running", generation: 1, toolDriverConnected: true });
    expect(f.requests.some(request => ["turn/start", "turn/interrupt"].includes(request.method))).toBe(false);
  });

  test("rejects provider, workspace and endpoint drift before sending anything", async () => {
    for (const drift of ["provider", "workspace", "endpoint", "seed-provider"]) {
      const f = fixture();
      const session = await f.controller.prepare("worker");
      if (drift === "provider") f.threads.get(session.threadId)!.modelProvider = "openai";
      if (drift === "workspace") f.threads.get(session.threadId)!.cwd = "/tmp/other-workspace";
      if (drift === "endpoint") f.config.model_providers.codex_web_sessions.base_url = "https://example.com/v1";
      if (drift === "seed-provider") f.threads.get("seed")!.modelProvider = "openai";
      await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow();
      expect(f.dispatched).toHaveLength(0);
    }
  });

  test("releases an idle stateless worker and restores the same task on the next request", async () => {
    const f = fixture();
    const session = await f.controller.prepare("worker");
    expect(await f.controller.withDriver(session.threadId, async () => "first result")).toBe("first result");
    await until(() => f.stopped.length === 1);
    expect(f.controller.status(session.threadId)).toMatchObject({ lifecycle: "idle_stopped", toolDriverConnected: false });
    expect(await f.controller.withDriver(session.threadId, async () => "second result")).toBe("second result");
    expect(f.dispatched.map(call => call.threadId)).toEqual([session.threadId, session.threadId]);
    expect(f.dispatched[0]!.prompt).toBe(f.dispatched[1]!.prompt);
    expect(f.controller.status(session.threadId).generation).toBe(2);
    expect(f.requests.filter(request => request.method === "thread/start")).toHaveLength(1);
  });

  test("never idles the seed, active requests, stateful REPLs or pinned background jobs", async () => {
    const f = fixture();
    await f.controller.restore("seed", "seed");
    await f.controller.ensureStarted("seed");
    const session = await f.controller.prepare("worker");
    let release!: () => void;
    const active = f.controller.withDriver(session.threadId, () => new Promise<void>(resolve => { release = resolve; }));
    await until(() => typeof release === "function");
    await Bun.sleep(65);
    expect(f.stopped).toEqual([]);
    f.controller.pin(session.threadId, "cua_repl");
    f.controller.pin(session.threadId, "background-job");
    release();
    await active;
    await Bun.sleep(65);
    expect(f.stopped).toEqual([]);
    expect(f.controller.status(session.threadId).statefulPins).toEqual(["cua_repl", "background-job"]);
    f.controller.unpin(session.threadId, "cua_repl");
    await Bun.sleep(65);
    expect(f.stopped).toEqual([]);
    f.controller.unpin(session.threadId, "background-job");
    await until(() => f.stopped.length === 1);
    expect(f.stopped).toEqual([session.threadId]);
  });

  test("an uncertain startup is not automatically resent, but a late connection is recognized", async () => {
    let sent = 0;
    const f = fixture({ sendFromSeed: async () => { sent++; } });
    const session = await f.controller.prepare("worker");
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("not confirmed");
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("outcome is unknown");
    expect(sent).toBe(1);
    f.connected.add(session.threadId);
    await f.controller.ensureStarted(session.threadId);
    expect(f.controller.status(session.threadId).lifecycle).toBe("running");
    expect(f.controller.status(session.threadId).generation).toBe(1);
    expect(sent).toBe(1);
  });

  test("an offline seed fails without an auxiliary turn or fallback", async () => {
    const f = fixture();
    const session = await f.controller.prepare("worker");
    f.connected.delete("seed");
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("seed is disconnected");
    expect(f.dispatched).toEqual([]);
    expect(f.requests.some(request => request.method === "turn/start")).toBe(false);
  });

  test("journals pending before dispatch and refuses unknown startup after controller restart", async () => {
    const records = new Map<string, DesktopStartupRecord>();
    const order: string[] = [];
    const journal = {
      read: async (id: string) => records.get(id),
      write: async (id: string, record: DesktopStartupRecord) => { order.push(record.state); records.set(id, structuredClone(record)); },
    };
    let dispatched = 0;
    const f = fixture({ startupJournal: journal, sendFromSeed: async () => { order.push("send"); dispatched++; throw new Error("approval response timed out"); } });
    const session = await f.controller.prepare("worker", "chat-one");
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("timed out");
    expect(order).toEqual(["pending", "send"]);
    f.controller.close();
    const restarted = new DesktopSessionController(f.options);
    controllers.push(restarted);
    await restarted.restore(session.threadId, session.title);
    expect(restarted.status(session.threadId)).toMatchObject({ lifecycle: "start_unknown", durableStartupState: "pending", statefulPins: ["restored_native_state"] });
    await expect(restarted.ensureStarted(session.threadId)).rejects.toThrow("outcome is unknown");
    expect(dispatched).toBe(1);
    f.connected.add(session.threadId);
    await restarted.ensureStarted(session.threadId);
    expect(records.get(session.threadId)?.state).toBe("connected");
    expect(restarted.status(session.threadId).generation).toBe(1);
    expect(dispatched).toBe(1);
  });

  test("a durable pending write failure prevents the native dispatch", async () => {
    const f = fixture({ startupJournal: { read: async () => undefined, write: async () => { throw new Error("disk write failed"); } } });
    const session = await f.controller.prepare("worker");
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("disk write failed");
    expect(f.dispatched).toHaveLength(0);
  });

  test("connected records require reconciliation when offline, then permit one explicit restart", async () => {
    const records = new Map<string, DesktopStartupRecord>();
    const f = fixture({ startupJournal: { read: async id => records.get(id), write: async (id, value) => { records.set(id, structuredClone(value)); } } });
    const session = await f.controller.prepare("worker");
    await f.controller.ensureStarted(session.threadId);
    f.controller.close();
    f.connected.delete(session.threadId);
    const restarted = new DesktopSessionController(f.options);
    controllers.push(restarted);
    await restarted.restore(session.threadId, session.title);
    await expect(restarted.ensureStarted(session.threadId)).rejects.toThrow("outcome is unknown");
    // The caller has separately confirmed the actual Desktop turn ended.
    await restarted.reconcileStopped(session.threadId);
    expect(records.get(session.threadId)?.state).toBe("stopped");
    expect(restarted.status(session.threadId).statefulPins).toEqual([]);
    await restarted.ensureStarted(session.threadId);
    expect(restarted.status(session.threadId).generation).toBe(2);
    expect(f.dispatched).toHaveLength(2);
  });

  test("idle shutdown is durable and a new controller resumes the same stopped task", async () => {
    const records = new Map<string, DesktopStartupRecord>();
    const f = fixture({ startupJournal: { read: async id => records.get(id), write: async (id, value) => { records.set(id, structuredClone(value)); } } });
    const session = await f.controller.prepare("worker");
    await f.controller.withDriver(session.threadId, async () => "done");
    await until(() => records.get(session.threadId)?.state === "stopped");
    f.controller.close();
    const restarted = new DesktopSessionController(f.options);
    controllers.push(restarted);
    await restarted.restore(session.threadId, session.title);
    await Promise.all([restarted.ensureStarted(session.threadId), restarted.ensureStarted(session.threadId)]);
    expect(f.dispatched).toHaveLength(2);
    expect(restarted.status(session.threadId).generation).toBe(2);
    expect(f.requests.filter(request => request.method === "thread/start")).toHaveLength(1);
  });

  test("failed idle shutdown does not record stopped or send another startup", async () => {
    const records = new Map<string, DesktopStartupRecord>();
    const f = fixture({
      startupJournal: { read: async id => records.get(id), write: async (id, value) => { records.set(id, structuredClone(value)); } },
      stopDriver: async () => { throw new Error("host shutdown was not confirmed"); },
    });
    const session = await f.controller.prepare("worker");
    await f.controller.ensureStarted(session.threadId);
    await until(() => f.controller.status(session.threadId).lifecycle === "start_unknown");
    expect(records.get(session.threadId)?.state).toBe("connected");
    f.connected.delete(session.threadId);
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("outcome is unknown");
    expect(f.dispatched).toHaveLength(1);
  });

  test("close does not discard active state and prevents further lifecycle changes", async () => {
    const f = fixture();
    const session = await f.controller.prepare("worker");
    await f.controller.ensureStarted(session.threadId);
    f.controller.pin(session.threadId, "cua_repl");
    f.controller.close();
    await Bun.sleep(65);
    expect(f.stopped).toEqual([]);
    await expect(f.controller.ensureStarted(session.threadId)).rejects.toThrow("closed");
    await expect(f.controller.prepare("another")).rejects.toThrow("closed");
  });
});
