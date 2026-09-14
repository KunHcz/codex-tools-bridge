import { afterEach, describe, expect, test } from "bun:test";
import { NativeHarness } from "../src/web-session/native-harness";
import { gatewayToolCatalogPage } from "../src/adapters/chatgpt-web/mcp-server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingMessage } from "node:http";

/** Drives the public local Responses endpoint as Codex would, without a model or tool executor. */
class FakeCodex {
  endpoint = "";
  tools: unknown[] = [];
  requests: { method: string; params: any }[] = [];
  executed: any[] = [];
  callbacks = new Set<(event: { method: string; params: unknown }) => void>();
  mode: "complete" | "fail_after_tool" | "missing_result" | "pause_after_tool" | "disconnect_response" | "cancel_after_completed" = "complete";
  onExecuted?: () => void;
  onStarted?: (turnId: string) => void;
  serverRequest?: (method: string, params: unknown) => Promise<unknown>;
  output = "native result";
  lastHttpStatus?: number;
  headers: Record<string, string> = {};
  driveSignal?: AbortSignal;
  private nextTurn = 0;
  onNotification(callback: (event: { method: string; params: unknown }) => void) { this.callbacks.add(callback); return () => { this.callbacks.delete(callback); }; }
  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>) { this.serverRequest = handler; return () => { this.serverRequest = undefined; }; }
  notify(method: string, threadId: string, turn: unknown) { for (const callback of this.callbacks) callback({ method, params: { threadId, turn } }); }
  async request<T = any>(method: string, params: any): Promise<T> {
    this.requests.push({ method, params });
    if (method === "turn/start") {
      const turn = { id: `turn-${++this.nextTurn}`, status: "inProgress" };
      this.notify("turn/started", params.threadId, turn);
      this.onStarted?.(turn.id);
      void this.drive(params.threadId, turn.id).catch(error => this.notify("turn/completed", params.threadId, { id: turn.id, status: "failed", error: { message: String(error) } }));
      return { turn } as T;
    }
    if (method === "turn/interrupt") this.notify("turn/completed", params.threadId, { id: params.turnId, status: "interrupted" });
    return {} as T;
  }
  private async drive(threadId: string, turnId: string) {
    const input: unknown[] = [{ role: "user", content: "relay tool request" }];
    for (let round = 0; round < 5; round++) {
      const response = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...this.headers }, signal: this.driveSignal, body: JSON.stringify({ model: "gpt-6-astra", stream: true, tools: this.tools, input }) });
      this.lastHttpStatus = response.status;
      if (!response.ok) throw new Error(`local response ${response.status}: ${await response.text()}`);
      if (this.mode === "disconnect_response") {
        await response.body?.cancel();
        throw new Error("local response transport disconnected");
      }
      let responseText: string;
      if (this.mode === "cancel_after_completed") {
        const reader = response.body!.getReader();
        responseText = "";
        while (!responseText.includes('"type":"response.completed"')) {
          const next = await reader.read();
          if (next.done) break;
          responseText += new TextDecoder().decode(next.value);
        }
        await reader.cancel();
      } else responseText = await response.text();
      const events = responseText.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6)));
      const completed = events.find(event => event.type === "response.completed");
      if (!completed) throw new Error("response.completed missing");
      const calls = completed.response.output.filter((item: any) => ["function_call", "custom_tool_call"].includes(item.type));
      if (!calls.length) { this.notify("turn/completed", threadId, { id: turnId, status: "completed" }); return; }
      this.executed.push(...calls);
      this.onExecuted?.();
      if (this.mode === "pause_after_tool") return;
      if (this.mode === "fail_after_tool") throw new Error("native tool turn interrupted after execution");
      if (this.mode !== "missing_result") for (const call of calls) {
        input.push(call, { type: call.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: call.call_id, output: this.output });
      }
    }
    throw new Error("unexpected tool replay loop");
  }
}

const harnesses: NativeHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map(harness => harness.close())); });
async function fixture(tools: unknown[], allowedApps: string[] = []) {
  const server = new FakeCodex();
  server.tools = tools;
  const harness = new NativeHarness(server, allowedApps);
  harnesses.push(harness);
  const prepared = await harness.prepare("/tmp");
  server.endpoint = `${prepared.params.config["model_providers.codex_web_sessions"].base_url}/responses`;
  harness.bind(prepared.key, "test-native-thread");
  return { server, harness };
}
const functionTool = { type: "function", name: "example", description: "Example existing native tool", parameters: { type: "object" } };

describe("web session native harness", () => {
  test("Desktop host mode accepts the real provider stream without starting a CLI turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "desktop-harness-test-"));
    const server = new FakeCodex();
    server.tools = [functionTool];
    const harness = new NativeHarness(server, [], undefined, "configured", "existing-desktop-thread");
    harnesses.push(harness);
    try {
      await harness.attach("existing-desktop-thread", cwd);
      const config = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      expect(config.model_provider).toBe("codex_web_sessions");
      server.endpoint = config.model_providers.codex_web_sessions.base_url + "/responses";
      await expect(harness.invoke("existing-desktop-thread", "codex_tool_call", { wire_name: "example", arguments: {} })).rejects.toThrow("has not connected");
      const desktop = (server as any).drive("existing-desktop-thread", "desktop-owned-turn") as Promise<void>;
      for (let attempt = 0; attempt < 100 && !harness.status("existing-desktop-thread").toolDriverConnected; attempt++) await Bun.sleep(2);
      expect(harness.status("existing-desktop-thread").toolDriverConnected).toBe(true);
      const result = await harness.invoke("existing-desktop-thread", "codex_tool_call", { wire_name: "example", arguments: { desktop: true } });
      expect(JSON.stringify(result)).toContain("native result");
      expect(server.executed).toHaveLength(1);
      expect(server.requests).toEqual([]);
      await expect(harness.attach("another-thread", cwd)).rejects.toThrow("explicitly selected");
      await harness.close();
      await desktop;
      expect(server.requests).toEqual([]);
      const replacement = new NativeHarness(server, [], undefined, "configured", "existing-desktop-thread");
      harnesses.push(replacement);
      await replacement.attach("existing-desktop-thread", cwd);
      const restarted = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      expect(restarted.model_providers.codex_web_sessions.base_url).toBe(config.model_providers.codex_web_sessions.base_url);
      expect(replacement.status("existing-desktop-thread").toolDriverConnected).toBe(false);
      expect(server.requests).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 10_000);

  test("routes two concurrent Desktop slots by strict thread header and isolates a disconnection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "desktop-two-slots-test-"));
    const otherCwd = await mkdtemp(join(tmpdir(), "desktop-other-route-test-"));
    const server = new FakeCodex();
    const first = new FakeCodex();
    const second = new FakeCodex();
    const firstId = "01a09431-e0ac-7952-a868-5a795d482cb4";
    const secondId = "01a09431-e0ac-7952-a868-5a795d482cb5";
    const harness = new NativeHarness(server, [], undefined, "configured", [firstId, secondId]);
    harnesses.push(harness);
    try {
      await harness.attach(firstId, cwd);
      const firstConfig = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      await harness.attach(secondId, cwd);
      const config = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      expect(config.model_providers.codex_web_sessions.base_url).toBe(firstConfig.model_providers.codex_web_sessions.base_url);
      const base = config.model_providers.codex_web_sessions.base_url;
      const endpoint = base + "/responses";
      const body = JSON.stringify({ model: "gpt-6-astra", stream: true, tools: [functionTool], input: [] });
      for (const headers of [{}, { "thread-id": "unknown-desktop-thread" }] as Record<string, string>[]) expect((await fetch(endpoint, { method: "POST", headers, body })).status).toBe(404);
      const other = await harness.prepare(otherCwd);
      expect((await fetch(other.params.config["model_providers.codex_web_sessions"].base_url + "/responses", { method: "POST", headers: { "thread-id": firstId }, body })).status).toBe(404);
      await expect(harness.attach("third-desktop-thread", cwd)).rejects.toThrow("explicitly selected");
      first.endpoint = second.endpoint = endpoint;
      first.headers = { "thread-id": firstId };
      second.headers = { "thread-id": secondId };
      first.tools = second.tools = [functionTool];
      first.output = "result only from first slot";
      second.output = "result only from second slot";
      const controller = new AbortController();
      first.driveSignal = controller.signal;
      const firstDesktop = ((first as any).drive(firstId, "first-desktop-turn") as Promise<void>).catch(error => error);
      const secondDesktop = (second as any).drive(secondId, "second-desktop-turn") as Promise<void>;
      for (let attempt = 0; attempt < 200 && (!harness.status(firstId).toolDriverConnected || !harness.status(secondId).toolDriverConnected); attempt++) await Bun.sleep(5);
      const results = await Promise.all([
        harness.invoke(firstId, "codex_tool_call", { wire_name: "example", arguments: { slot: "one" } }),
        harness.invoke(secondId, "codex_tool_call", { wire_name: "example", arguments: { slot: "two" } }),
      ]);
      expect(JSON.stringify(results[0])).toContain(first.output);
      expect(JSON.stringify(results[0])).not.toContain(second.output);
      expect(JSON.stringify(results[1])).toContain(second.output);
      expect(first.executed.map(call => JSON.parse(call.arguments))).toEqual([{ slot: "one" }]);
      expect(second.executed.map(call => JSON.parse(call.arguments))).toEqual([{ slot: "two" }]);
      const healthy = await (await fetch(base + "/health")).json() as any;
      expect(healthy.connectedDriverCount).toBe(2);
      expect(healthy.allDrivers.map((driver: any) => driver.threadId)).toEqual([firstId, secondId]);
      expect(await (await fetch(base + "/health?thread_id=" + secondId)).json()).toMatchObject({ toolDriverConnected: true, providerThreadId: secondId });
      expect((await fetch(base + "/health?thread_id=unknown")).status).toBe(404);
      controller.abort();
      await firstDesktop;
      for (let attempt = 0; attempt < 200 && harness.status(firstId).toolDriverConnected; attempt++) await Bun.sleep(5);
      expect(harness.status(firstId).toolDriverConnected).toBe(false);
      expect(harness.status(secondId).toolDriverConnected).toBe(true);
      expect((await (await fetch(base + "/health")).json() as any).connectedDriverCount).toBe(1);
      const continuing = await harness.invoke(secondId, "codex_tool_call", { wire_name: "example", arguments: { slot: "two-still-live" } });
      expect(JSON.stringify(continuing)).toContain(second.output);
      expect(first.executed).toHaveLength(1);
      expect(second.executed).toHaveLength(2);
      expect(server.requests).toEqual([]);
      await harness.close();
      await secondDesktop;
    } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); await rm(otherCwd, { recursive: true, force: true }); }
  }, 10_000);

  test("requires distinct configured Desktop tasks without a two-chat limit", () => {
    const server = new FakeCodex();
    const many = new NativeHarness(server, [], undefined, "configured", Array.from({ length: 30 }, (_, i) => `thread-${i}`));
    harnesses.push(many);
    for (const ids of [[], ["same", "same"], [""]]) expect(() => new NativeHarness(server, [], undefined, "configured", ids)).toThrow("distinct");
  });

  test("Desktop detects idle HTTP cancellation and reconnects on the same endpoint without CLI lifecycle events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "desktop-disconnect-test-"));
    const server = new FakeCodex();
    const harness = new NativeHarness(server, [], undefined, "configured", "existing-desktop-thread");
    harnesses.push(harness);
    try {
      await harness.attach("existing-desktop-thread", cwd);
      const config = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      const endpoint = config.model_providers.codex_web_sessions.base_url + "/responses";
      const body = JSON.stringify({ model: "gpt-6-astra", stream: true, tools: [functionTool], input: [{ role: "user", content: "wait for tools" }] });
      for (const cancellation of ["request", "socket"] as const) {
        let disconnect: () => Promise<void>;
        if (cancellation === "request") {
          const controller = new AbortController();
          const response = await fetch(endpoint, { method: "POST", body, signal: controller.signal });
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          await reader.read();
          disconnect = async () => { controller.abort(); await reader.read().catch(() => {}); };
        } else {
          const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const outgoing = httpRequest(endpoint, { method: "POST" }, resolve);
            outgoing.once("error", reject);
            outgoing.end(body);
          });
          expect(response.statusCode).toBe(200);
          await new Promise<void>(resolve => response.once("data", () => resolve()));
          disconnect = async () => { response.destroy(); };
        }
        expect(harness.status("existing-desktop-thread").toolDriverConnected).toBe(true);
        await disconnect();
        for (let attempt = 0; attempt < 200 && harness.status("existing-desktop-thread").toolDriverConnected; attempt++) await Bun.sleep(5);
        expect(harness.status("existing-desktop-thread").toolDriverConnected).toBe(false);
        await expect(harness.invoke("existing-desktop-thread", "codex_tool_inventory", {})).rejects.toThrow("disconnected");
      }
      server.endpoint = endpoint;
      server.tools = [functionTool];
      server.mode = "cancel_after_completed";
      const desktop = (server as any).drive("existing-desktop-thread", "reconnected-desktop-turn") as Promise<void>;
      for (let attempt = 0; attempt < 200 && !harness.status("existing-desktop-thread").toolDriverConnected; attempt++) await Bun.sleep(5);
      const result = await harness.invoke("existing-desktop-thread", "codex_tool_call", { wire_name: "example", arguments: { fresh: true } });
      expect(JSON.stringify(result)).toContain("native result");
      expect(server.executed).toHaveLength(1);
      expect(server.lastHttpStatus).toBe(200);
      expect(server.requests).toEqual([]);
      await harness.close();
      await desktop;
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 10_000);

  test("does not transfer queued Desktop actions to a reconnected native operation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "desktop-queue-generation-test-"));
    const server = new FakeCodex();
    const harness = new NativeHarness(server, [], undefined, "configured", "existing-desktop-thread");
    harnesses.push(harness);
    let release!: () => void;
    try {
      await harness.attach("existing-desktop-thread", cwd);
      const config = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      const endpoint = config.model_providers.codex_web_sessions.base_url + "/responses";
      const body = JSON.stringify({ model: "gpt-6-astra", stream: true, tools: [functionTool], input: [] });
      const firstController = new AbortController();
      const first = await fetch(endpoint, { method: "POST", body, signal: firstController.signal });
      const reader = first.body!.getReader();
      await reader.read();
      // Hold dispatch at the queue boundary to deterministically exercise a
      // reconnect racing an earlier action's asynchronous broker cleanup.
      (harness as any).threads.get("existing-desktop-thread").queue = new Promise<void>(resolve => { release = resolve; });
      const queued = harness.invoke("existing-desktop-thread", "codex_tool_call", { wire_name: "example", arguments: { oldNativeState: true } }).catch(error => error);
      firstController.abort();
      await reader.read().catch(() => {});
      for (let attempt = 0; attempt < 200 && harness.status("existing-desktop-thread").toolDriverConnected; attempt++) await Bun.sleep(5);
      expect(harness.status("existing-desktop-thread").toolDriverConnected).toBe(false);
      const secondController = new AbortController();
      const second = await fetch(endpoint, { method: "POST", body, signal: secondController.signal });
      const secondReader = second.body!.getReader();
      await secondReader.read();
      expect(harness.status("existing-desktop-thread").toolDriverConnected).toBe(true);
      release();
      expect((await queued).message).toContain("queued before the Desktop driver disconnected");
      expect(harness.status("existing-desktop-thread").queuedRequests).toBe(0);
      expect(server.executed).toEqual([]);
      expect(server.requests).toEqual([]);
      secondController.abort();
      await secondReader.read().catch(() => {});
    } finally { release?.(); await harness.close(); await rm(cwd, { recursive: true, force: true }); }
  }, 10_000);

  test("Desktop rejects unknown tool outcomes and reconnects only for a new explicit call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "desktop-unknown-outcome-test-"));
    const server = new FakeCodex();
    const harness = new NativeHarness(server, [], undefined, "configured", "existing-desktop-thread");
    harnesses.push(harness);
    try {
      await harness.attach("existing-desktop-thread", cwd);
      const config = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      server.endpoint = config.model_providers.codex_web_sessions.base_url + "/responses";
      server.tools = [functionTool];
      server.mode = "missing_result";
      const failedDesktop = ((server as any).drive("existing-desktop-thread", "unknown-outcome-turn") as Promise<void>).catch(error => error);
      for (let attempt = 0; attempt < 200 && !harness.status("existing-desktop-thread").toolDriverConnected; attempt++) await Bun.sleep(5);
      await expect(harness.invoke("existing-desktop-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation: 1 } })).rejects.toThrow("outcome is unknown");
      expect((await failedDesktop).message).toContain("400");
      expect(server.executed).toHaveLength(1);
      expect(harness.status("existing-desktop-thread").toolDriverConnected).toBe(false);
      server.mode = "complete";
      const desktop = (server as any).drive("existing-desktop-thread", "explicit-new-turn") as Promise<void>;
      for (let attempt = 0; attempt < 200 && !harness.status("existing-desktop-thread").toolDriverConnected; attempt++) await Bun.sleep(5);
      await harness.invoke("existing-desktop-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation: 2 } });
      expect(server.executed.map(call => JSON.parse(call.arguments))).toEqual([{ invocation: 1 }, { invocation: 2 }]);
      expect(server.requests).toEqual([]);
      await harness.close();
      await desktop;
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 10_000);

  test("normal completed-response cancellation preserves the native turn for the next tool", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "cancel_after_completed";
    for (const invocation of [1, 2]) {
      const result = await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation } });
      expect(JSON.stringify(result)).toContain("native result");
      expect(harness.status("test-native-thread").toolDriverConnected).toBe(true);
    }
    expect(server.executed.map(call => JSON.parse(call.arguments))).toEqual([{ invocation: 1 }, { invocation: 2 }]);
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(server.requests.some(request => request.method === "turn/interrupt")).toBe(false);
  }, 10_000);

  test("bounds pending work and rejects overflow without starting or replaying it", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "pause_after_tool";
    const controller = new AbortController();
    const emitted = new Promise<void>(resolve => { server.onExecuted = resolve; });
    const active = harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { active: true } }, controller.signal).catch(error => error);
    await emitted;
    const queued = Array.from({ length: 15 }, () => harness.invoke("test-native-thread", "codex_tool_inventory", {}, controller.signal).catch(error => error));
    expect(harness.status("test-native-thread").queuedRequests).toBe(16);
    await expect(harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { overflow: true } })).rejects.toThrow("not queued or executed");
    controller.abort();
    expect(await active).toBeInstanceOf(Error);
    for (const result of await Promise.all(queued)) expect(result).toBeInstanceOf(Error);
    expect(harness.status("test-native-thread").queuedRequests).toBe(0);
    expect(server.executed).toHaveLength(1);
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("provider diagnostics expose header names and validated thread identifiers without arbitrary values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "desktop-metadata-test-"));
    const server = new FakeCodex();
    const harness = new NativeHarness(server, [], undefined, "configured", "existing-desktop-thread");
    harnesses.push(harness);
    try {
      await harness.attach("existing-desktop-thread", cwd);
      const config = Bun.TOML.parse(await readFile(join(cwd, ".codex/config.toml"), "utf8")) as any;
      const endpoint = config.model_providers.codex_web_sessions.base_url + "/responses";
      const controller = new AbortController();
      const id = "01a09431-e0ac-7952-a868-5a795d482cb4";
      const response = await fetch(endpoint, { method: "POST", signal: controller.signal, headers: { session_id: id, authorization: "Bearer fake-sensitive-value", "x-private": "private-value" }, body: JSON.stringify({ model: "gpt-6-astra", stream: true, thread_id: "body-private-value", tools: [], input: [] }) });
      const reader = response.body!.getReader();
      await reader.read();
      const status = harness.status("existing-desktop-thread");
      expect(status.providerThreadId).toBe(id);
      expect(status.providerRequestHeaderNames).toContain("authorization");
      expect(status.providerThreadBodyFields).toEqual(["thread_id"]);
      expect(JSON.stringify(status)).not.toContain("fake-sensitive-value");
      expect(JSON.stringify(status)).not.toContain("body-private-value");
      expect(JSON.stringify(status)).not.toContain("private-value");
      controller.abort();
      await reader.read().catch(() => {});
    } finally { await harness.close(); await rm(cwd, { recursive: true, force: true }); }
  }, 10_000);

  test("refreshes dynamically loaded tools inside the same native turn", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.onExecuted = () => {
      server.tools = [functionTool, { type: "namespace", name: "mcp__loaded", tools: [
        { ...functionTool, name: "read_item", parameters: { type: "object", properties: { item_id: { type: "string" } }, required: ["item_id"] } },
        { ...functionTool, name: "create_thread" },
      ] }];
    };
    await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} });
    const inventory = await harness.invoke("test-native-thread", "codex_tool_inventory", {});
    const catalog = inventory.structuredContent as { tools: any[] };
    expect(catalog.tools.find(tool => tool.wire_name === "mcp__loaded__read_item")?.parameters).toMatchObject({ required: ["item_id"] });
    expect(catalog.tools.some(tool => tool.wire_name.endsWith("create_thread"))).toBe(false);
    await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "mcp__loaded__read_item", arguments: { item_id: "existing" } });
    expect(server.executed[1]).toMatchObject({ namespace: "mcp__loaded", name: "read_item", arguments: '{"item_id":"existing"}' });
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("starts a fresh turn after an idle native turn ends externally", async () => {
    const { server, harness } = await fixture([functionTool]);
    await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation: 1 } });
    server.notify("turn/completed", "test-native-thread", { id: "turn-1", status: "completed" });
    await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation: 2 } });
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(2);
    expect(server.executed.map(call => JSON.parse(call.arguments))).toEqual([{ invocation: 1 }, { invocation: 2 }]);
  }, 10_000);

  test("closing rejects queued work before it can start another native turn", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "pause_after_tool";
    const emitted = new Promise<void>(resolve => { server.onExecuted = resolve; });
    const first = harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} }).catch(error => error);
    await emitted;
    const queued = harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} }).catch(error => error);
    await harness.close();
    expect(await first).toBeInstanceOf(Error);
    expect((await queued).message).toContain("closed");
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    await expect(harness.invoke("test-native-thread", "codex_tool_inventory", {})).rejects.toThrow("closed");
  }, 10_000);

  test("restores explicit namespaces and freeform inputs through the original Responses bridge", async () => {
    const { server, harness } = await fixture([
      { type: "namespace", name: "mcp__example", tools: [{ ...functionTool, name: "read.item" }] },
      { type: "custom", name: "apply_patch", description: "Native patch", format: { type: "text" } },
    ]);
    const result = await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "mcp__example__read.item", arguments: { id: "x" } });
    expect(result.isError).not.toBe(true);
    expect(server.executed[0]).toMatchObject({ type: "function_call", name: "read.item", namespace: "mcp__example", arguments: '{"id":"x"}' });
    const patch = "*** Begin Patch\n*** End Patch";
    await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "apply_patch", input: patch });
    expect(server.executed[1]).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: patch });
    expect(server.executed).toHaveLength(2);
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(server.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(0);
    await harness.close();
  }, 10_000);

  test("rejects missing native results without emitting the tool call again", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "missing_result";
    await expect(harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} })).rejects.toThrow();
    expect(server.executed).toHaveLength(1);
    expect(server.lastHttpStatus).toBe(400);
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(server.requests.some(request => request.method === "turn/interrupt")).toBe(true);
  }, 10_000);

  test("does not retry interrupted execution and permits a fresh explicit operation", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "fail_after_tool";
    await expect(harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation: 1 } })).rejects.toThrow();
    expect(server.executed).toHaveLength(1);
    server.mode = "complete";
    server.onStarted = () => server.notify("turn/completed", "test-native-thread", { id: "turn-1", status: "failed", error: { message: "stale completion" } });
    await harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: { invocation: 2 } });
    expect(server.executed.map(call => JSON.parse(call.arguments))).toEqual([{ invocation: 1 }, { invocation: 2 }]);
  }, 10_000);

  test("cancels a pending native operation without replaying it", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "pause_after_tool";
    const emitted = new Promise<void>(resolve => { server.onExecuted = resolve; });
    const controller = new AbortController();
    const pending = harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} }, controller.signal);
    const failed = pending.then(() => null, error => error);
    await emitted;
    controller.abort();
    expect(await failed).toBeInstanceOf(Error);
    expect(server.executed).toHaveLength(1);
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
    expect(server.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
  }, 10_000);

  test("does not replay an ambiguously delivered local HTTP response", async () => {
    const { server, harness } = await fixture([functionTool]);
    server.mode = "disconnect_response";
    await expect(harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} })).rejects.toThrow("transport disconnected");
    expect(server.executed).toHaveLength(0);
    expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  }, 10_000);

  test("limits explicit app consent to the active matching CUA permission request", async () => {
    const { server, harness } = await fixture([functionTool], ["com.google.Chrome"]);
    server.mode = "pause_after_tool";
    const emitted = new Promise<void>(resolve => { server.onExecuted = resolve; });
    const controller = new AbortController();
    const pending = harness.invoke("test-native-thread", "codex_tool_call", { wire_name: "example", arguments: {} }, controller.signal);
    const failed = pending.then(() => null, error => error);
    await emitted;
    const params = { threadId: "test-native-thread", turnId: "turn-1", serverName: "cua_repl", mode: "form", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", tool_name: "get_app_state", tool_params: { app: "com.google.Chrome" } } };
    expect(await server.serverRequest!("mcpServer/elicitation/request", params)).toMatchObject({ action: "accept", content: {} });
    for (const changed of [
      { ...params, threadId: "another-thread" }, { ...params, turnId: "another-turn" },
      { ...params, serverName: "other-mcp" }, { ...params, mode: "url" },
      { ...params, requestedSchema: { type: "object", properties: { credential: { type: "string" } } } },
      { ...params, _meta: { ...params._meta, tool_params: { app: "com.apple.Terminal" } } },
      { ...params, _meta: { ...params._meta, codex_approval_kind: "other_operation" } },
    ]) expect(await server.serverRequest!("mcpServer/elicitation/request", changed)).toMatchObject({ action: "decline" });
    await expect(server.serverRequest!("item/commandExecution/requestApproval", params)).rejects.toThrow("explicit operator decision");
    controller.abort();
    expect(await failed).toBeInstanceOf(Error);
  }, 10_000);

  test("rejects public-origin requests and inactive routes", async () => {
    const { server } = await fixture([]);
    const health = server.endpoint.replace(/responses$/, "health");
    expect(await (await fetch(health)).json()).toMatchObject({ toolDriverConnected: false, queuedRequests: 0 });
    expect((await fetch(health, { headers: { Origin: "https://untrusted.example" } })).status).toBe(404);
    expect((await fetch(health, { method: "POST" })).status).toBe(404);
    expect((await fetch(server.endpoint, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(server.endpoint, { method: "POST", headers: { Origin: "https://untrusted.example" }, body: "{}" })).status).toBe(404);
  });
});

describe("native gateway catalog transport", () => {
  const catalog = { tools: [{ name: "web__run", description: "Existing web tool" }], total: 1 };
  test("accepts one catalog after a runtime banner in one text block or separate blocks", () => {
    const payload = JSON.stringify(catalog);
    for (const content of [
      [{ type: "text", text: `Script completed\nWall time 0.1 seconds\nOutput:\n${payload}` }],
      [{ type: "text", text: "Script completed" }, { type: "text", text: payload }],
    ]) expect(gatewayToolCatalogPage({ content }, new Set())).toEqual(catalog);
  });
  test("rejects multiple catalog payloads instead of choosing an ambiguous result", () => {
    const payload = JSON.stringify(catalog);
    expect(() => gatewayToolCatalogPage({ content: [{ type: "text", text: `Output:\n${payload}\n${payload}` }] }, new Set())).toThrow("ambiguous JSON");
    expect(() => gatewayToolCatalogPage({ content: [{ type: "text", text: payload }, { type: "text", text: payload }] }, new Set())).toThrow("ambiguous JSON");
  });
});
