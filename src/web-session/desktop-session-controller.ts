import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readDesktopProviderEndpoint } from "./desktop-provider";

const START_PROMPT = "启动本聊天的网页本地工具驱动器。仅使用已配置的 codex_web_sessions 本机 provider，等待新的网页工具请求；不调用其他模型，不重放过去的操作。";

export interface DesktopSessionDescriptor { threadId: string; cwd: string; title: string }
export interface DesktopDriverState { toolDriverConnected: boolean; queuedRequests?: number }
export interface DesktopPreparationServer {
  request<T = any>(method: string, params: unknown): Promise<T>;
  close(): Promise<void>;
}
export interface DesktopStartupRecord {
  version: 1;
  attemptId: string;
  state: "pending" | "connected" | "stopped";
  generation: number;
}
export interface DesktopSessionControllerOptions {
  cwd: string;
  seedThreadId: string;
  server: { request<T = any>(method: string, params: unknown): Promise<T> };
  /** A dedicated creator owns the rollout writer until its process has exited. */
  createPreparationServer?: () => DesktopPreparationServer;
  attachThread(session: DesktopSessionDescriptor): Promise<void>;
  /** Private native dispatch: the real executor supplies its own call metadata. */
  sendFromSeed(request: { seedThreadId: string; threadId: string; prompt: string }): Promise<void>;
  /** Gracefully finish an idle Responses turn, never interrupt an unrelated process. */
  stopDriver(threadId: string): Promise<void>;
  driverStatus(threadId: string): DesktopDriverState;
  idleMs?: number;
  startupTimeoutMs?: number;
  pollMs?: number;
  /** Dependency seam; production defaults to the owned workspace config reader. */
  readEndpoint?: typeof readDesktopProviderEndpoint;
  /** Durable writes must be atomic. A pending marker must reach disk before dispatch. */
  startupJournal?: {
    read(threadId: string): Promise<DesktopStartupRecord | undefined>;
    write(threadId: string, record: DesktopStartupRecord): Promise<void>;
  };
}

interface ManagedSession extends DesktopSessionDescriptor {
  activeRequests: number;
  pins: Set<string>;
  lifecycle: "prepared" | "starting" | "running" | "idle_stopped" | "disconnected" | "start_unknown";
  generation: number;
  start?: Promise<void>;
  stop?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastError?: string;
  startupRecord?: DesktopStartupRecord;
}

/** Owns metadata and leases, while a legitimate Desktop seed owns native startup.
 * A fresh turn is never started through the auxiliary CLI App Server.
 */
export class DesktopSessionController {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly preparations = new Map<string, Promise<DesktopSessionDescriptor>>();
  private readonly restorations = new Map<string, Promise<DesktopSessionDescriptor>>();
  private readonly cwd: string;
  private readonly idleMs: number;
  private readonly startupTimeoutMs: number;
  private readonly pollMs: number;
  private closed = false;

  constructor(private readonly options: DesktopSessionControllerOptions) {
    if (!isAbsolute(options.cwd) || !options.seedThreadId.trim()) throw new Error("Desktop session controller requires an absolute workspace and an existing seed task");
    this.cwd = resolve(options.cwd);
    this.idleMs = options.idleMs ?? 5 * 60_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
    this.pollMs = options.pollMs ?? 100;
    if ([this.idleMs, this.startupTimeoutMs, this.pollMs].some(value => !Number.isFinite(value) || value <= 0)) throw new Error("Desktop lifecycle durations must be positive");
  }

  async prepare(title: string, requestKey?: string): Promise<DesktopSessionDescriptor> {
    this.assertOpen();
    if (requestKey === undefined) return this.prepareOne(title);
    if (!requestKey.trim()) return Promise.reject(new Error("Desktop preparation requires a nonempty conversation key"));
    const existing = this.preparations.get(requestKey);
    if (existing) return existing;
    // Keep uncertain preparation failures too: a timed-out thread/start might
    // have created a durable task, so silently trying again can create duplicates.
    const pending = this.prepareOne(title);
    this.preparations.set(requestKey, pending);
    return pending;
  }

  private async prepareOne(title: string): Promise<DesktopSessionDescriptor> {
    await this.verifyProvider();
    this.assertOpen();
    const preparationServer = this.options.createPreparationServer?.();
    const creator = preparationServer ?? this.options.server;
    let createdThreadId: string | undefined;
    try {
      const result = await creator.request<any>("thread/start", {
        cwd: this.cwd, model: "gpt-6-astra", modelProvider: "codex_web_sessions",
        allowProviderModelFallback: false, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandbox: "danger-full-access", ephemeral: false,
        config: { approvals_reviewer: "user", "computer_use.default_app_access": "allow" },
      });
      createdThreadId = typeof result.thread?.id === "string" ? result.thread.id : undefined;
      if (!createdThreadId || result.thread?.modelProvider !== "codex_web_sessions" || typeof result.thread?.cwd !== "string" || resolve(result.thread.cwd) !== this.cwd) throw new Error("Prepared Desktop task does not match the dedicated local provider and workspace");
      // A metadata-only thread/start need not write a rollout yet. Persist an
      // ordinary message so a later Desktop client can read and resume it.
      await creator.request("thread/inject_items", { threadId: createdThreadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: START_PROMPT }] }] });
      await creator.request("thread/name/set", { threadId: createdThreadId, name: title });
    } catch (error) {
      // No native turn has been requested for this newly created task.
      if (createdThreadId) await creator.request("thread/archive", { threadId: createdThreadId }).catch(() => {});
      throw error;
    } finally {
      // Unsubscribing does not release the creator's active rollout writer.
      // Wait for the dedicated process to exit before Desktop can adopt it.
      await preparationServer?.close();
    }
    return this.restore(createdThreadId!, title);
  }

  async restore(threadId: string, title: string): Promise<DesktopSessionDescriptor> {
    this.assertOpen();
    const existing = this.sessions.get(threadId);
    if (existing) return this.descriptor(existing);
    const restoring = this.restorations.get(threadId);
    if (restoring) return restoring;
    const pending = this.restoreOne(threadId, title);
    this.restorations.set(threadId, pending);
    try { return await pending; }
    finally { if (this.restorations.get(threadId) === pending) this.restorations.delete(threadId); }
  }

  private async restoreOne(threadId: string, title: string): Promise<DesktopSessionDescriptor> {
    await this.verifyThread(threadId);
    const startupRecord = await this.options.startupJournal?.read(threadId);
    if (startupRecord && (startupRecord.version !== 1 || typeof startupRecord.attemptId !== "string" || !startupRecord.attemptId || !["pending", "connected", "stopped"].includes(startupRecord.state) || !Number.isSafeInteger(startupRecord.generation) || startupRecord.generation < 0)) throw new Error("Invalid durable Desktop startup record; refusing to guess its lifecycle");
    this.assertOpen();
    const descriptor = { threadId, cwd: this.cwd, title };
    await this.options.attachThread(descriptor);
    this.assertOpen();
    this.sessions.set(threadId, {
      ...descriptor, activeRequests: 0, pins: new Set(startupRecord && startupRecord.state !== "stopped" ? ["restored_native_state"] : []),
      lifecycle: startupRecord ? (startupRecord.state === "stopped" ? "idle_stopped" : "start_unknown") : "prepared",
      generation: startupRecord?.generation ?? 0, startupRecord,
    });
    return descriptor;
  }

  async ensureStarted(threadId: string): Promise<void> {
    this.assertOpen();
    const session = this.get(threadId);
    this.clearIdle(session);
    if (session.stop) await session.stop;
    this.assertOpen();
    if (session.start) return session.start;
    if (this.options.driverStatus(threadId).toolDriverConnected) {
      if (session.lifecycle === "start_unknown") {
        const confirmed = this.confirmConnected(session);
        session.start = confirmed;
        try { await confirmed; }
        finally { if (session.start === confirmed) session.start = undefined; }
      }
      session.lifecycle = "running";
      session.lastError = undefined;
      this.scheduleIdle(session);
      return;
    }
    if (session.lifecycle === "start_unknown") throw new Error("Desktop startup outcome is unknown; no duplicate startup was sent. Wait for the existing task or explicitly reconcile its stopped state.");
    if (threadId === this.options.seedThreadId) throw new Error("The Desktop seed is disconnected; resume that existing task once in Desktop. No CLI or model fallback was started.");
    const pending = this.start(session);
    session.start = pending;
    try { await pending; }
    finally { if (session.start === pending) session.start = undefined; this.scheduleIdle(session); }
  }

  async withDriver<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const session = this.get(threadId);
    session.activeRequests++;
    this.clearIdle(session);
    try { await this.ensureStarted(threadId); return await action(); }
    finally { session.activeRequests--; this.scheduleIdle(session); }
  }

  /** Stateful REPLs and background jobs must be pinned until explicitly released.
   * A caller that cannot prove their retirement should leave the pin in place.
   */
  pin(threadId: string, reason: string): void {
    this.assertOpen();
    if (!reason.trim()) throw new Error("Stateful driver pins require a reason");
    const session = this.get(threadId);
    session.pins.add(reason);
    this.clearIdle(session);
  }

  unpin(threadId: string, reason: string): void {
    const session = this.get(threadId);
    session.pins.delete(reason);
    this.scheduleIdle(session);
  }

  /** Use only after the host has positively confirmed that an uncertain turn ended. */
  async reconcileStopped(threadId: string): Promise<void> {
    this.assertOpen();
    const session = this.get(threadId);
    if (session.activeRequests || session.start || session.stop || this.options.driverStatus(threadId).toolDriverConnected) throw new Error("Cannot reconcile a Desktop task while its driver is active");
    const reconcile = this.recordStartup(session, { version: 1, attemptId: session.startupRecord?.attemptId ?? randomUUID(), state: "stopped", generation: session.generation }).then(() => {
      session.lifecycle = "idle_stopped";
      session.pins.delete("restored_native_state");
      session.lastError = undefined;
    });
    session.stop = reconcile;
    try { await reconcile; }
    finally { if (session.stop === reconcile) session.stop = undefined; }
  }

  status(threadId: string) {
    const session = this.get(threadId);
    const driver = this.options.driverStatus(threadId);
    const lifecycle = session.lifecycle === "running" && !driver.toolDriverConnected ? "disconnected" : session.lifecycle;
    return { ...this.descriptor(session), ...driver, lifecycle, generation: session.generation, activeRequests: session.activeRequests, statefulPins: [...session.pins], idleTimeoutMs: this.idleMs, lastError: session.lastError, seed: threadId === this.options.seedThreadId, durableStartupState: session.startupRecord?.state };
  }

  /** Do not stop a seed or an active/stateful worker just because this owner closes. */
  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) this.clearIdle(session);
  }

  private async start(session: ManagedSession): Promise<void> {
    await this.verifyThread(session.threadId);
    await this.verifyThread(this.options.seedThreadId);
    if (!this.options.driverStatus(this.options.seedThreadId).toolDriverConnected) throw new Error("The Desktop seed is disconnected; no native startup or model fallback was attempted");
    this.assertOpen();
    session.lifecycle = "starting";
    session.lastError = undefined;
    try {
      await this.recordStartup(session, { version: 1, attemptId: randomUUID(), state: "pending", generation: session.generation + 1 });
      this.assertOpen();
      await this.options.sendFromSeed({ seedThreadId: this.options.seedThreadId, threadId: session.threadId, prompt: START_PROMPT });
      const deadline = Date.now() + this.startupTimeoutMs;
      while (!this.options.driverStatus(session.threadId).toolDriverConnected) {
        if (this.closed || Date.now() >= deadline) throw new Error("Desktop startup was dispatched but connection was not confirmed; no retry was sent");
        await new Promise(resolve => setTimeout(resolve, this.pollMs));
      }
      await this.confirmConnected(session);
    } catch (error) {
      session.lifecycle = "start_unknown";
      session.lastError = error instanceof Error ? error.message : "Desktop startup failed";
      throw error;
    }
  }

  private scheduleIdle(session: ManagedSession): void {
    this.clearIdle(session);
    if (this.closed || session.threadId === this.options.seedThreadId || session.activeRequests || session.pins.size || session.start || session.stop || session.lifecycle !== "running") return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined;
      if (this.closed || session.activeRequests || session.pins.size || session.start || session.stop) return;
      if ((this.options.driverStatus(session.threadId).queuedRequests ?? 0) > 0) { this.scheduleIdle(session); return; }
      const stopping = Promise.resolve().then(() => this.options.stopDriver(session.threadId)).then(async () => {
        if (this.options.driverStatus(session.threadId).toolDriverConnected) throw new Error("Idle shutdown returned before the Desktop driver disconnected");
        await this.recordStartup(session, { version: 1, attemptId: session.startupRecord?.attemptId ?? randomUUID(), state: "stopped", generation: session.generation });
        session.lifecycle = "idle_stopped";
      }).catch(error => {
        session.lastError = error instanceof Error ? error.message : "Idle driver shutdown failed";
        session.lifecycle = "start_unknown";
      });
      session.stop = stopping;
      void stopping.finally(() => { if (session.stop === stopping) session.stop = undefined; });
    }, this.idleMs);
    session.idleTimer.unref?.();
  }

  private async recordStartup(session: ManagedSession, record: DesktopStartupRecord): Promise<void> {
    await this.options.startupJournal?.write(session.threadId, record);
    session.startupRecord = record;
  }

  private async confirmConnected(session: ManagedSession): Promise<void> {
    const record: DesktopStartupRecord = { version: 1, attemptId: session.startupRecord?.attemptId ?? randomUUID(), state: "connected", generation: session.startupRecord?.generation ?? session.generation + 1 };
    await this.recordStartup(session, record);
    session.generation = record.generation;
    session.lifecycle = "running";
    session.lastError = undefined;
  }

  private async verifyProvider(): Promise<void> {
    const endpoint = await (this.options.readEndpoint ?? readDesktopProviderEndpoint)(this.cwd);
    if (!endpoint) throw new Error("Owned Desktop local provider config is missing");
    const expected = `http://127.0.0.1:${endpoint.port}/${endpoint.key}/v1`;
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[a-f0-9]{48}\/v1$/.test(expected) || endpoint.port > 65535) throw new Error("Desktop controller requires the dedicated loopback provider URL");
    const result = await this.options.server.request<any>("config/read", { cwd: this.cwd, includeLayers: false });
    const provider = result.config?.model_providers?.codex_web_sessions;
    if (provider?.base_url !== expected || provider?.wire_api !== "responses" || provider?.requires_openai_auth !== false) throw new Error("Desktop local provider registry does not match the owned workspace endpoint");
  }

  private async verifyThread(threadId: string): Promise<void> {
    await this.verifyProvider();
    const result = await this.options.server.request<any>("thread/read", { threadId, includeTurns: false });
    if (result.thread?.id !== threadId || result.thread?.modelProvider !== "codex_web_sessions" || typeof result.thread?.cwd !== "string" || resolve(result.thread.cwd) !== this.cwd) throw new Error("Refusing to start a Desktop task outside the verified local provider and workspace");
  }

  private descriptor(session: DesktopSessionDescriptor): DesktopSessionDescriptor { return { threadId: session.threadId, cwd: session.cwd, title: session.title }; }
  private get(threadId: string): ManagedSession { const session = this.sessions.get(threadId); if (!session) throw new Error("Desktop task is not managed by this controller"); return session; }
  private clearIdle(session: ManagedSession): void { clearTimeout(session.idleTimer); session.idleTimer = undefined; }
  private assertOpen(): void { if (this.closed) throw new Error("Desktop session controller is closed"); }
}
