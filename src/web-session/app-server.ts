import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeInputRequiredError } from "./approvals";

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface CodexAppServerOptions {
  binary?: string;
  /** Complete argv override, primarily for fixtures. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
}

export class AppServerRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** JSONL transport; callers explicitly control the thread and turn lifecycle. */
export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private exited = false;
  private failure?: Error;
  private nextId = 1;
  private buffer = "";
  // Never log or include stderr in errors: runtime diagnostics can contain credentials.
  private stderrTail = "";
  private pending = new Map<number, Pending>();
  private listeners = new Set<(notification: AppServerNotification) => void>();
  private serverRequestHandler?: (method: string, params: unknown) => Promise<unknown>;

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed"));
    if (this.failure) return Promise.reject(this.failure);
    return this.starting ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    const child = spawn(
      this.options.binary ?? process.env.CODEX_BINARY ?? "codex",
      this.options.args ?? ["app-server", "--listen", "stdio://"],
      { cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: "pipe" },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-16_384);
    });
    child.stdin.on("error", () => this.fail(new Error("Codex app-server input stream failed")));
    child.on("error", () => this.fail(new Error("Could not start Codex app-server")));
    child.on("close", (code, signal) => {
      this.exited = true;
      this.fail(new Error(`Codex app-server exited (code ${code ?? "none"}, signal ${signal ?? "none"})`));
      this.stderrTail = "";
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => reject(new Error("Could not start Codex app-server")));
      });
      await this.sendRequest("initialize", {
        clientInfo: { name: "codex_chatgpt_web_sessions", title: "ChatGPT local sessions", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      }, this.options.requestTimeoutMs ?? 30_000);
      this.write({ method: "initialized", params: {} });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Codex app-server initialization failed"));
      throw error;
    }
  }

  async request<T = unknown>(method: string, params: unknown = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    await this.start();
    if (method === "initialize" || method === "initialized") throw new Error("Handshake is managed by CodexAppServer");
    return this.sendRequest(method, params, options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000) as Promise<T>;
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): () => void {
    if (this.serverRequestHandler) throw new Error("A server request handler is already registered");
    this.serverRequestHandler = handler;
    return () => { if (this.serverRequestHandler === handler) this.serverRequestHandler = undefined; };
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("Request timeout must be positive"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timeout is not command cancellation; callers must explicitly terminate running commands.
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app-server is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    const maxBytes = this.options.maxMessageBytes ?? 64 * 1024 * 1024;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxBytes) { this.fail(new Error("Codex app-server message exceeded limit")); return; }
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        message = parsed as Record<string, unknown>;
      } catch { this.fail(new Error("Codex app-server sent invalid JSONL")); return; }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          const handler = this.serverRequestHandler;
          if (handler) {
            void handler(message.method, message.params).then(
              result => { if (!this.closed) this.write({ id: message.id, result }); },
              error => { if (!this.closed) this.write({ id: message.id, error: { code: -32601, message: error instanceof NativeInputRequiredError ? error.message : "Server request is not authorized by this client" } }); },
            ).catch(() => {});
          } else this.write({ id: message.id, error: { code: -32601, message: "Client does not handle server requests" } });
        } else {
          for (const listener of this.listeners) {
            try { listener({ method: message.method, params: message.params }); } catch { /* isolate subscribers */ }
          }
        }
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error && typeof message.error === "object") {
          const error = message.error as { code?: number; message?: string };
          pending.reject(new AppServerRpcError(error.code ?? -32603, error.message ?? "Codex app-server RPC failed"));
        } else { pending.resolve(message.result); }
      }
    }
    if (Buffer.byteLength(this.buffer) > maxBytes) this.fail(new Error("Codex app-server message exceeded limit"));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    this.buffer = "";
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.fail(new Error("Codex app-server client closed"));
    this.listeners.clear();
    this.stderrTail = "";
    if (!child || !child.pid || this.exited || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 1_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
