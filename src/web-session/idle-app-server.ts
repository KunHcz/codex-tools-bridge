import type { AppServerNotification } from "./app-server";

interface Server {
  start(): Promise<void>;
  request<T = unknown>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
  onNotification(callback: (event: AppServerNotification) => void): () => void;
  close(): Promise<void>;
}

/** The Desktop turn owns native tools. Only legacy command jobs need this process.
 * Keep it absent until requested, and release it once no RPC or command is active.
 * A transport failure is returned to the caller, never retried here.
 */
export class IdleAppServer implements Server {
  private current?: Server;
  private retiring?: Promise<void>;
  private unsubscribe?: () => void;
  private listeners = new Set<(event: AppServerNotification) => void>();
  private pending = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private commands = new Set<string>();

  constructor(private readonly create: () => Server, private readonly idleMs = 120_000) {}

  async start(): Promise<void> { if (this.closed) throw new Error("Auxiliary app-server is closed"); }

  onNotification(callback: (event: AppServerNotification) => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  status() { return { started: !!this.current, activeRequests: this.pending, activeCommands: this.commands.size, idleTimeoutMs: this.idleMs }; }

  async request<T = unknown>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T> {
    if (this.closed) throw new Error("Auxiliary app-server is closed");
    this.pending++;
    clearTimeout(this.timer);
    try {
      await this.retiring;
      if (this.closed) throw new Error("Auxiliary app-server is closed");
      if (!this.current) {
        this.current = this.create();
        this.unsubscribe = this.current.onNotification(event => { for (const listener of this.listeners) listener(event); });
      }
      const commandId = method === "command/exec" ? (params as { processId?: string })?.processId : undefined;
      if (commandId) this.commands.add(commandId);
      try {
        const result = await this.current.request<T>(method, params, options);
        if (commandId) this.commands.delete(commandId);
        return result;
      } catch (error) {
        // A timeout is not evidence that the OS process exited. Do not reclaim
        // an environment containing a command with an unknown outcome.
        throw error;
      }
    } finally {
      this.pending--;
      if (!this.closed && !this.pending && !this.commands.size) {
        this.timer = setTimeout(() => { void this.retire().catch(() => {}); }, this.idleMs);
        this.timer.unref?.();
      }
    }
  }

  private retire(): Promise<void> {
    if (this.retiring) return this.retiring;
    const server = this.current;
    this.current = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.retiring = (async () => { await server?.close(); })().finally(() => { this.retiring = undefined; });
    return this.retiring;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.retire();
    this.commands.clear();
    this.listeners.clear();
  }
}
