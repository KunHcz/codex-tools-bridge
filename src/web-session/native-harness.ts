import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createChatGptMcpServer } from "../adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../adapters/chatgpt-web/turn-broker";
import { brokerResult, emitToolBatch } from "../adapters/chatgpt-web/tool-events";
import { bridgeToResponsesSSE } from "../bridge";
import { AsyncEventQueue } from "../event-queue";
import { readJsonRequestBody } from "../http-body";
import { parseRequest } from "../responses/parser";
import { namespacedToolName, type AdapterEvent } from "../types";
import { filterNativeTools, WEB_SESSION_BLOCKED_TOOL_PATTERNS, WEB_SESSION_TOOL_ARGUMENT_POLICIES } from "./tool-catalog";
import { respondToNativeRequest, type NativeInputHandler, type ToolAccess } from "./approvals";
import { readDesktopProviderEndpoint, writeDesktopProviderConfig, writeDesktopProviderRegistry } from "./desktop-provider";

interface Server {
  request<T = any>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
  onNotification(callback: (event: { method: string; params: unknown }) => void): () => void;
  onServerRequest?(callback: (method: string, params: unknown) => Promise<unknown>): () => void;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A native turn can fail before its caller gets as far as awaiting readiness.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer!); }
}
interface Operation {
  ready: ReturnType<typeof deferred<string>>;
  finished: ReturnType<typeof deferred<void>>;
  stop: AbortController;
  token?: string;
  turnId?: string;
  outstanding: Set<string>;
  responseBusy: boolean;
  ending: boolean;
  ended?: boolean;
  requestInput?: NativeInputHandler;
}
function createOperation(): Operation {
  return { ready: deferred(), finished: deferred(), stop: new AbortController(), outstanding: new Set(), responseBusy: false, ending: false };
}
interface Route {
  key: string; cwd: string; threadId?: string; operation?: Operation; queue: Promise<unknown>;
  queuedRequests: number;
  providerRequestHeaderNames?: string[];
  providerThreadId?: string;
  providerThreadBodyFields?: string[];
}
const MAX_PENDING_REQUESTS = 16;

/** Local Responses transport only: tools come from the real Codex turn registry.
 * Nothing here invokes a model or manufactures browser turn metadata.
 */
export class NativeHarness {
  private http?: ReturnType<typeof Bun.serve>;
  private broker?: TurnBroker;
  private bridge?: ReturnType<typeof createChatGptMcpServer>;
  private client?: Client;
  private controlClient?: Client;
  private controlBridge?: ReturnType<typeof createChatGptMcpServer>;
  private directory?: string;
  private initialization?: Promise<void>;
  private routes = new Map<string, Route>();
  private threads = new Map<string, Route>();
  private unsubscribe: () => void;
  private unsubscribeRequests?: () => void;
  private section?: Promise<string>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly desktopThreadIds: string[];

  constructor(private readonly server: Server, private readonly allowedApps: string[] = [], private readonly sectionName?: string, private readonly toolAccess: ToolAccess = "configured", private readonly desktopThreadId?: string | readonly string[], private readonly desktopProviderRegistry?: string) {
    this.desktopThreadIds = typeof desktopThreadId === "string" ? [desktopThreadId] : [...desktopThreadId ?? []];
    if (desktopThreadId !== undefined && (!this.desktopThreadIds.length || new Set(this.desktopThreadIds).size !== this.desktopThreadIds.length || this.desktopThreadIds.some(id => !id.trim()))) throw new Error("Desktop host requires distinct explicitly selected existing tasks");
    this.unsubscribeRequests = server.onServerRequest?.(async (method, value) => {
      const p = value as any;
      const operation = this.threads.get(p?.threadId)?.operation;
      return respondToNativeRequest(method, p, {
        active: !!operation && !operation.stop.signal.aborted && operation.outstanding.size > 0 && !!p.turnId && p.turnId === operation.turnId,
        toolAccess: this.toolAccess, allowedApps: this.allowedApps,
        signal: operation?.stop.signal ?? AbortSignal.abort(), requestInput: operation?.requestInput,
      });
    });
    this.unsubscribe = server.onNotification(event => {
      // Desktop owns this turn. Notifications from the auxiliary CLI process
      // are not evidence of the Desktop turn's lifecycle.
      if (this.desktopThreadId) return;
      const p = event.params as any;
      const operation = this.threads.get(p?.threadId)?.operation;
      if (!operation) return;
      if (event.method === "turn/started" && !operation.turnId) operation.turnId = p.turn.id;
      if (event.method === "turn/completed") {
        if (operation.turnId && p.turn.id !== operation.turnId) return;
        operation.ended = true;
        if (p.turn.status === "completed" && !operation.outstanding.size) {
          operation.ending = true;
          operation.stop.abort();
          operation.ready.reject(new Error("Native turn ended before tool registry became ready"));
          if (operation.token) this.broker?.revoke(operation.token);
          operation.finished.resolve();
        }
        else {
          const error = new Error(`Native tool turn ${p.turn.status}: ${p.turn.error?.message ?? "interrupted or failed"}`);
          operation.ready.reject(error); operation.finished.reject(error);
          operation.stop.abort();
          if (operation.token) this.broker?.revoke(operation.token, error);
        }
      }
    });
  }
  private init(port = 0): Promise<void> {
    return this.initialization ??= (async () => {
      this.directory = await mkdtemp(join(tmpdir(), "codex-tools-bridge-"));
      this.broker = TurnBroker.forSocket(join(this.directory, "broker.sock"));
      await this.broker.listen();
      this.bridge = createChatGptMcpServer({ brokerSocketPath: this.broker.socketPath, blockedToolNamePatterns: WEB_SESSION_BLOCKED_TOOL_PATTERNS, toolArgumentPolicies: WEB_SESSION_TOOL_ARGUMENT_POLICIES });
      this.client = new Client({ name: "web-session-native-relay", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await this.bridge.connect(serverTransport);
      await this.client.connect(clientTransport);
      // Private lifecycle plane. Never returned to the Web tool inventory. Only
      // startFromSeed below can use it, with a fixed local-provider bootstrap.
      this.controlBridge = createChatGptMcpServer({ brokerSocketPath: this.broker.socketPath });
      this.controlClient = new Client({ name: "desktop-driver-controller", version: "1.0.0" });
      const [controlClientTransport, controlServerTransport] = InMemoryTransport.createLinkedPair();
      await this.controlBridge.connect(controlServerTransport);
      await this.controlClient.connect(controlClientTransport);
      this.http = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: request => this.receive(request) });
    })();
  }
  async prepare(cwd: string) {
    if (this.closed) throw new Error("Native harness is closed");
    const endpoint = this.desktopThreadId ? await readDesktopProviderEndpoint(cwd) : undefined;
    await this.init(endpoint?.port);
    if (this.closed) throw new Error("Native harness is closed");
    const key = (this.desktopThreadId ? [...this.routes.values()].find(route => route.cwd === cwd)?.key : undefined) ?? endpoint?.key ?? randomBytes(24).toString("hex");
    const route: Route = { key, cwd, queue: Promise.resolve(), queuedRequests: 0 };
    this.routes.set(key, route);
    return { key, params: {
      model: "gpt-6-astra", modelProvider: "codex_web_sessions", approvalPolicy: "on-request",
      config: { "approvals_reviewer": "user",
        ...(this.toolAccess === "all" ? { "computer_use.default_app_access": "allow" } : {}),
        ...(this.allowedApps.length ? { "computer_use.macos.bundle_ids": Object.fromEntries(this.allowedApps.map(id => [id, "allow"])) } : {}), "model_providers.codex_web_sessions": {
        name: "ChatGPT Web local tool relay", base_url: `http://127.0.0.1:${this.http!.port}/${key}/v1`,
        wire_api: "responses", requires_openai_auth: false, supports_websockets: false,
        request_max_retries: 0, stream_max_retries: 0,
      } },
    } };
  }
  bind(key: string, threadId: string): void {
    if (this.desktopThreadId && !this.desktopThreadIds.includes(threadId)) throw new Error("Desktop host mode only serves its explicitly selected existing tasks");
    const route = this.routes.get(key);
    if (!route) throw new Error("Native harness route is missing");
    // The URL authenticates access to a workspace; the Desktop thread header
    // selects an independent execution slot within it.
    this.threads.set(threadId, { key: route.key, cwd: route.cwd, threadId, queue: Promise.resolve(), queuedRequests: 0 });
  }
  async attach(threadId: string, cwd: string, title = "ChatGPT 网页任务"): Promise<void> {
    if (this.threads.has(threadId)) return;
    if (this.desktopThreadId && !this.desktopThreadIds.includes(threadId)) throw new Error("Desktop host mode only serves its explicitly selected existing task");
    const prepared = await this.prepare(cwd);
    if (this.desktopThreadId) {
      await writeDesktopProviderConfig(cwd, prepared.params.config["model_providers.codex_web_sessions"].base_url);
      if (this.desktopProviderRegistry) await writeDesktopProviderRegistry(this.desktopProviderRegistry, prepared.params.config["model_providers.codex_web_sessions"].base_url);
      this.bind(prepared.key, threadId);
      this.threads.get(threadId)!.operation = createOperation();
      return;
    }
    const resumed = await this.server.request<any>("thread/resume", { threadId, ...prepared.params });
    this.bind(prepared.key, threadId);
    if (!resumed.thread.preview) await this.connectThread(threadId, title);
    else if (!resumed.thread.section) await this.placeInSidebar(threadId);
  }
  async connectThread(threadId: string, title: string): Promise<void> {
    await this.run(threadId, `连接 ChatGPT 网页工具会话：${title}。后续操作由网页模型发起，本地 Codex 负责工具执行。`, async () => undefined);
    await this.placeInSidebar(threadId);
  }
  private async placeInSidebar(threadId: string): Promise<void> {
    if (!this.sectionName) return;
    this.section ??= (async () => {
      let cursor: string | undefined;
      do {
        const page = await this.server.request<any>("threadSection/list", { limit: 100, cursor });
        const found = page.data.find((item: any) => item.name === this.sectionName);
        if (found) return found.id as string;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const result = await this.server.request<any>("threadSection/create", { name: this.sectionName });
      return result.section.id as string;
    })();
    await this.server.request("thread/section/move", { threadId, sectionId: await this.section });
  }
  async invoke(threadId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, requestInput?: NativeInputHandler): Promise<CallToolResult> {
    if (!["codex_tool_inventory", "codex_tool_call", "codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image"].includes(name)) throw new Error("Unsupported native bridge operation");
    const label = name === "codex_tool_inventory" ? "发现本地工具" : `执行网页请求的工具：${String(args.wire_name ?? name)}`;
    return this.run(threadId, label, async token => {
      return await this.client!.callTool({ name, arguments: { ...args, turn_token: token } }, undefined, { timeout: 95_000, signal }) as CallToolResult;
    }, signal, requestInput, true);
  }
  authorizeDesktopThread(threadId: string): void {
    if (!this.desktopThreadId || !/^[a-f0-9-]{36}$/.test(threadId)) throw new Error("Invalid managed Desktop task");
    if (!this.desktopThreadIds.includes(threadId)) this.desktopThreadIds.push(threadId);
  }
  async startFromSeed(sourceThreadId: string, targetThreadId: string): Promise<void> {
    if (sourceThreadId === targetThreadId || !this.desktopThreadIds.includes(targetThreadId)) throw new Error("Invalid Desktop bootstrap target");
    const target = this.threads.get(targetThreadId);
    if (!target || target.cwd !== this.threads.get(sourceThreadId)?.cwd) throw new Error("Desktop bootstrap workspace mismatch");
    // The controller verifies persisted provider/cwd immediately before this.
    // This is an actual executor call, with host-issued context, not a bridge
    // process impersonating a model turn or calling the Desktop's private pipe.
    const input = 'const entry = ALL_TOOLS.find(t => t.name === "mcp__codex_app__send_message_to_thread"); if (!entry) throw new Error("Native Desktop task scheduler is unavailable"); const result = await tools[entry.name](' + JSON.stringify({ threadId: targetThreadId, prompt: "继续使用已配置 codex_web_sessions 本地工具驱动器，仅等待网页工具请求，不进行模型推理，不重放历史操作。" }) + '); text({driverStart: result?.isError ? "rejected" : "accepted", result});';
    await this.run(sourceThreadId, "按需连接网页工具任务", async token => {
      const result = await this.controlClient!.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: "exec", input } }, undefined, { timeout: 95_000 }) as CallToolResult;
      const output = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const accepted = result.content.some(c => { if (c.type !== "text") return false; try { return JSON.parse(c.text)?.driverStart === "accepted"; } catch { return false; } });
      if (result.isError || !accepted) throw new Error("Native Desktop scheduler did not acknowledge startup: " + output);
    }, undefined, undefined, true);
  }
  async waitForDriver(threadId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.status(threadId).toolDriverConnected) {
      if (this.closed || Date.now() >= deadline) throw new Error("Native Desktop task did not connect; bootstrap was not replayed");
      await Bun.sleep(100);
    }
  }
  async stopDesktopDriver(threadId: string): Promise<void> {
    const route = this.threads.get(threadId);
    const operation = route?.operation;
    if (!route || !operation || operation.ended || operation.ending) return;
    if (route.queuedRequests || operation.outstanding.size) throw new Error("Desktop driver is busy; it was not stopped");
    operation.ending = true;
    operation.stop.abort();
    if (operation.token) this.broker?.revoke(operation.token);
    // No CLI turn/interrupt: wait for a terminal local Responses completion.
    await bounded(operation.finished.promise, 15_000, "Desktop idle shutdown was not confirmed");
  }
  status(threadId: string) {
    const route = this.threads.get(threadId);
    const operation = route?.operation;
    return {
      executionHost: this.desktopThreadId ? "desktop" : "standalone",
      toolDriverConnected: !!operation?.token && !operation.stop.signal.aborted && !operation.ended,
      queuedRequests: route?.queuedRequests ?? 0,
      providerRequestHeaderNames: route?.providerRequestHeaderNames,
      providerThreadId: route?.providerThreadId,
      providerThreadBodyFields: route?.providerThreadBodyFields,
    };
  }
  private run<T>(threadId: string, prompt: string, action: (token: string) => Promise<T>, signal?: AbortSignal, requestInput?: NativeInputHandler, keepAlive = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Native harness is closed"));
    const route = this.threads.get(threadId);
    if (!route) return Promise.reject(new Error("Native harness thread is not attached"));
    if (route.queuedRequests >= MAX_PENDING_REQUESTS) return Promise.reject(new Error("Native tool queue is busy (16 pending requests); this request was not queued or executed"));
    route.queuedRequests++;
    const queuedOperation = route.operation;
    const task = route.queue.then(async () => {
      if (this.closed) throw new Error("Native harness is closed");
      signal?.throwIfAborted();
      if (this.desktopThreadId && route.operation !== queuedOperation) throw new Error("This request was queued before the Desktop driver disconnected; resubmit explicitly after checking the new native state. It was not executed.");
      const previous = route.operation;
      if (this.desktopThreadId && (!previous || previous.ended || previous.ending || previous.stop.signal.aborted)) {
        throw new Error("The Desktop tool driver is disconnected. Resume the existing task in Desktop with its local provider; no CLI or remote model fallback was started.");
      }
      if (this.desktopThreadId && !previous?.token) throw new Error("Desktop tool driver has not connected yet. Start the selected existing task in Desktop using its configured local provider. This request did not start a model or cancel the waiting driver.");
      const operation: Operation = previous && !previous.ended && !previous.ending && !previous.stop.signal.aborted
        ? previous
        : createOperation();
      const reused = operation === previous;
      if (!reused && previous?.token) this.broker?.revoke(previous.token);
      operation.requestInput = requestInput;
      route.operation = operation;
      let retained = false;
      const abort = () => {
        operation.stop.abort();
        operation.ready.reject(new Error("Web tool request cancelled"));
        if (operation.token) this.broker?.revoke(operation.token, new Error("Web tool request cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (!reused) {
          const started = await this.server.request<any>("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] });
          operation.turnId = started.turn.id;
        }
        if (this.closed) throw new Error("Native harness is closed");
        const token = await bounded(operation.ready.promise, 60_000, "Codex tool registry did not become ready");
        const result = await action(token);
        // CUA activation belongs to a native turn, not to the JS app object.
        // Keep that turn alive between independent web MCP calls. Finishing it
        // here would revoke the target before the next click or scroll.
        if (keepAlive && !operation.ended && !operation.stop.signal.aborted) {
          retained = true;
          return result;
        }
        operation.ending = true;
        operation.stop.abort();
        await bounded(operation.finished.promise, 15_000, "Native tool turn did not finish");
        return result;
      } catch (error) {
        operation.stop.abort();
        if (operation.turnId) {
          await this.server.request("turn/interrupt", { threadId, turnId: operation.turnId }).catch(() => {});
          await bounded(operation.finished.promise.catch(() => {}), 15_000, "Native cancellation did not settle").catch(() => {});
        }
        throw error;
      } finally {
        if (!retained && operation.token) this.broker?.revoke(operation.token);
        signal?.removeEventListener("abort", abort);
        operation.requestInput = undefined;
        if (!retained && route.operation === operation) route.operation = undefined;
      }
    });
    const settled = task.finally(() => { route.queuedRequests--; });
    route.queue = settled.catch(() => {});
    return settled;
  }
  private async receive(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/([a-f0-9]{48})\/v1\/(responses|health)$/);
    const authorizedRoute = match && this.routes.get(match[1]!);
    if (!authorizedRoute || request.headers.has("origin") || this.closed) return new Response("Unknown local tool route", { status: 404 });
    const candidates = [...this.threads.values()].filter(route => route.key === authorizedRoute.key);
    if (match?.[2] === "health") {
      if (request.method !== "GET" || !candidates.length) return new Response("Unknown local tool route", { status: 404 });
      const selected = url.searchParams.get("thread_id");
      if (selected !== null) {
        if (!candidates.some(route => route.threadId === selected)) return new Response("Unknown local tool route", { status: 404 });
        return Response.json(this.status(selected), { headers: { "Cache-Control": "no-store" } });
      }
      const allDrivers = candidates.map(route => ({ threadId: route.threadId!, ...this.status(route.threadId!) }));
      const connectedDriverCount = allDrivers.filter(driver => driver.toolDriverConnected).length;
      return Response.json({ ...(allDrivers.length === 1 ? this.status(allDrivers[0]!.threadId) : { executionHost: this.desktopThreadId ? "desktop" : "standalone", queuedRequests: allDrivers.reduce((sum, driver) => sum + driver.queuedRequests, 0) }), toolDriverConnected: connectedDriverCount > 0, connectedDriverCount, allDrivers }, { headers: { "Cache-Control": "no-store" } });
    }
    const requestedThread = request.headers.get("thread-id");
    const route = requestedThread !== null ? this.threads.get(requestedThread) : (this.desktopThreadIds.length <= 1 && candidates.length === 1 ? candidates[0] : undefined);
    if (request.method !== "POST" || !route || route.key !== authorizedRoute.key || (!route.operation && !this.desktopThreadId)) return new Response("Unknown local tool route or missing Desktop thread-id", { status: 404 });
    // A fresh Desktop turn may reconnect to the same provider URL after the
    // previous HTTP consumer went away. Never reuse its broker invocations:
    // a partially delivered tool batch may already have executed.
    if (this.desktopThreadId && (!route.operation || route.operation.ended || route.operation.stop.signal.aborted)) route.operation = createOperation();
    const operation = route.operation!;
    if (operation.responseBusy) return new Response("Concurrent model request rejected", { status: 409 });
    operation.responseBusy = true;
    let responseCompleted = false;
    const failOperation = (failure: Error) => {
      if (operation.ended) return;
      operation.ended = true;
      operation.responseBusy = false;
      operation.stop.abort();
      operation.ready.reject(failure);
      operation.finished.reject(failure);
      if (operation.token) this.broker?.revoke(operation.token, failure);
    };
    const disconnected = () => {
      // The Responses bridge also invokes its cleanup hook after a successful
      // terminal event. That boundary preserves CUA's native turn activation.
      if (responseCompleted) return;
      request.signal.removeEventListener("abort", disconnected);
      const suffix = operation.outstanding.size ? " Tool execution outcome is unknown; the call was not replayed." : " No tool request was replayed.";
      failOperation(new Error(`Desktop tool driver HTTP connection disconnected.${suffix}`));
    };
    request.signal.addEventListener("abort", disconnected, { once: true });
    const detach = () => request.signal.removeEventListener("abort", disconnected);
    try {
      request.signal.throwIfAborted();
      const body = await readJsonRequestBody(request);
      request.signal.throwIfAborted();
      // Diagnostic metadata only: never persist arbitrary header values or
      // bodies, which can contain credentials, context, or the private route.
      route.providerRequestHeaderNames = [...request.headers.keys()].sort();
      route.providerThreadId = undefined;
      for (const name of ["thread-id", "session-id", "session_id", "x-codex-thread-id", "conversation_id", "x-session-id", "x-codex-session-id"]) {
        const value = request.headers.get(name);
        if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
          route.providerThreadId = value;
          break;
        }
      }
      route.providerThreadBodyFields = Object.keys(body as object).filter(name => ["thread_id", "threadId", "conversation_id", "conversationId", "session_id"].includes(name));
      const parsed = parseRequest(body);
      if (parsed._compactionRequest || parsed.previousResponseId) throw new Error("Unsupported continuation; restart this tool operation with full Codex context");
      const tools = filterNativeTools(parsed.context.tools ?? []);
      const environment = { cwd: route.cwd, roots: [route.cwd], writableRoots: [route.cwd], sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [route.cwd], networkAccess: false }, tools };
      if (!operation.token) {
        operation.token = await this.broker!.register(environment, undefined, route.threadId!.slice(-12));
        if (operation.stop.signal.aborted) {
          this.broker!.revoke(operation.token, new Error("Desktop tool driver disconnected during registration"));
          throw new Error("Desktop tool driver disconnected during registration");
        }
        operation.ready.resolve(operation.token);
      } else {
        this.broker!.updateEnvironment(operation.token, environment);
        for (const message of parsed.context.messages) {
          if (message.role === "toolResult" && operation.outstanding.delete(message.toolCallId)) this.broker!.completeTool(operation.token, message.toolCallId, brokerResult(message));
        }
        if (operation.outstanding.size) throw new Error("Native tool result is missing; execution outcome is unknown, refusing to replay the operation");
      }
      const queue = new AsyncEventQueue<AdapterEvent>();
      const ns = new Map(tools.filter(tool => tool.namespace).map(tool => [namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace!, name: tool.name }]));
      const freeform = new Set(tools.filter(tool => tool.freeform).map(tool => tool.name));
      const search = new Set(tools.filter(tool => tool.toolSearch).map(tool => tool.name));
      // Codex may stop reading after response.completed before the HTTP body is
      // drained. That is a response boundary, not cancellation of the tool turn.
      const stream = bridgeToResponsesSSE(queue, parsed.modelId, ns, freeform, search, disconnected, 2000, {
        stallTimeoutSec: 100,
        onTerminal: status => {
          if (status === "completed") {
            responseCompleted = true;
            if (operation.ending) { operation.ended = true; operation.finished.resolve(); }
          }
          else failOperation(new Error(`Desktop tool driver response ${status}; no tool call was replayed`));
          detach();
        },
      });
      // Waiting for the next web tool request is intentional idleness, not a
      // stalled model. Heartbeats carry no generated text or model inference.
      const heartbeat = setInterval(() => queue.push({ type: "heartbeat" }), 10_000);
      void (async () => {
        try {
          let batch: Awaited<ReturnType<TurnBroker["nextToolBatch"]>> | undefined;
          try { batch = await this.broker!.nextToolBatch(operation.token!, operation.stop.signal); }
          catch (error) { if (!operation.ending) throw error; }
          if (batch?.length) {
            for (const item of batch) operation.outstanding.add(item.callId);
            emitToolBatch(batch, { inputTokens: 0, outputTokens: 0 }, event => queue.push(event));
          } else {
            queue.push({ type: "text_delta", text: "网页工具请求已处理。具体结果已回传 ChatGPT。" });
            queue.push({ type: "done", stopReason: "stop", endTurn: true, usage: { inputTokens: 0, outputTokens: 0 } });
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          queue.push({ type: "error", message: failure.message });
          failOperation(failure);
        } finally { clearInterval(heartbeat); operation.responseBusy = false; queue.close(); }
      })();
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
    } catch (error) {
      detach();
      const failure = error instanceof Error ? error : new Error(String(error));
      failOperation(failure);
      return Response.json({ error: { message: failure.message } }, { status: 400 });
    }
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.dispose();
  }
  private async dispose(): Promise<void> {
    await this.initialization?.catch(() => {});
    const finishing: Promise<unknown>[] = [];
    for (const route of this.threads.values()) {
      const operation = route.operation;
      if (!operation || operation.ended) continue;
      operation.ending = true;
      operation.stop.abort();
      operation.ready.reject(new Error("Native harness is closed"));
      if (operation.outstanding.size && operation.token) this.broker?.revoke(operation.token, new Error("Native harness is closed"));
      if (operation.outstanding.size && operation.turnId) {
        await this.server.request("turn/interrupt", { threadId: route.threadId, turnId: operation.turnId }).catch(() => {});
      }
      finishing.push(bounded(operation.finished.promise, 3000, "Native tool turn did not close").catch(() => {}));
    }
    await Promise.all(finishing);
    await Promise.all([...this.threads.values()].map(route => route.queue.catch(() => {})));
    await this.controlClient?.close();
    await this.controlBridge?.close();
    await this.client?.close();
    await this.bridge?.close();
    await this.broker?.close();
    this.http?.stop(true);
    this.unsubscribe();
    this.unsubscribeRequests?.();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
