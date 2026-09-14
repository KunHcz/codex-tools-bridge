import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open as fsOpen, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CodexAppServer } from "./app-server";
import { IdleAppServer } from "./idle-app-server";
import { startupJournal } from "./startup-journal";
import { DesktopSessionController } from "./desktop-session-controller";
import { NativeHarness } from "./native-harness";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NativeInputHandler, ToolAccess } from "./approvals";

const TEXT_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const MAX_ACTIVE_JOBS = 8;
interface AppServer {
  start(): Promise<void>;
  request<T = unknown>(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<T>;
  onNotification(callback: (event: { method: string; params: unknown }) => void): () => void;
  close(): Promise<void>;
}
export interface WebSession {
  sessionId: string;
  threadId: string;
  cwd: string;
  title: string;
  createdAt: string;
  requestKey?: string;
  preparedDesktopSlot?: boolean;
  conversationKey?: string;
  managedDesktop?: boolean;
}
export interface WebSessionJob {
  jobId: string;
  sessionId: string;
  threadId: string;
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  outputOmittedOnRestore?: boolean;
}
export interface WebSessionRuntimeOptions {
  stateDir: string;
  workspaceRoot: string;
  codexBinary?: string;
  appServer?: AppServer;
  allowedApps?: string[];
  sidebarSection?: string;
  toolAccess?: ToolAccess;
  desktopThreadId?: string | readonly string[];
  desktopProviderRegistry?: string;
}
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function limitedUtf8(text: string, maxBytes: number): string {
  return new TextDecoder().decode(Buffer.from(text).subarray(0, maxBytes), { stream: true });
}

export class WebSessionRuntime {
  private readonly server: AppServer;
  private readonly harness?: NativeHarness;
  private readonly desktopController?: DesktopSessionController;
  private readonly stateDir: string;
  private root: string;
  private sessions = new Map<string, WebSession>();
  private activeThreads = new Map<string, Promise<void>>();
  private jobs = new Map<string, WebSessionJob>();
  private initialized?: Promise<void>;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private jobPersistence: Promise<unknown> = Promise.resolve();
  private cancellations = new Set<string>();
  private decoders = new Map<string, { stdout: StringDecoder; stderr: StringDecoder }>();
  private unsubscribe: () => void;
  private readonly desktopThreadIds: readonly string[];

  constructor(options: WebSessionRuntimeOptions) {
    this.desktopThreadIds = typeof options.desktopThreadId === "string" ? [options.desktopThreadId] : options.desktopThreadId ?? [];
    if (new Set(this.desktopThreadIds).size !== this.desktopThreadIds.length) throw new Error("Desktop task IDs must be distinct");
    this.root = resolve(options.workspaceRoot);
    this.stateDir = resolve(options.stateDir);
    const inherited = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME", "XDG_CONFIG_HOME"]);
    const env = Object.fromEntries(Object.keys(process.env).map(key => [key, inherited.has(key) ? process.env[key] : undefined]));
    const createServer = () => new CodexAppServer({ binary: options.codexBinary, cwd: this.root, env });
    this.server = options.appServer ?? (this.desktopThreadIds.length ? new IdleAppServer(createServer) : createServer());
    if (!options.appServer) this.harness = new NativeHarness(this.server, options.allowedApps, options.sidebarSection, options.toolAccess, options.desktopThreadId, options.desktopProviderRegistry);
    if (this.harness && this.desktopThreadIds.length) {
      this.desktopController = new DesktopSessionController({
        cwd: this.root, seedThreadId: this.desktopThreadIds[0]!, server: this.server,
        startupJournal: startupJournal(this.stateDir),
        createPreparationServer: createServer,
        attachThread: async ({ threadId, cwd, title }) => { this.harness!.authorizeDesktopThread(threadId); await this.harness!.attach(threadId, cwd, title); },
        sendFromSeed: ({ seedThreadId, threadId }) => this.harness!.startFromSeed(seedThreadId, threadId),
        stopDriver: threadId => this.harness!.stopDesktopDriver(threadId),
        driverStatus: threadId => this.harness!.status(threadId),
      });
    }
    this.unsubscribe = this.server.onNotification((event) => {
      if (event.method !== "command/exec/outputDelta") return;
      const data = event.params as { processId?: string; stream?: string; deltaBase64?: string; capReached?: boolean };
      const job = data.processId && this.jobs.get(data.processId);
      if (!job || typeof data.deltaBase64 !== "string") return;
      const key = data.stream === "stderr" ? "stderr" : "stdout";
      const output = this.decoders.get(job.jobId)?.[key].write(Buffer.from(data.deltaBase64, "base64")) ?? "";
      const remaining = Math.max(0, OUTPUT_LIMIT - Buffer.byteLength(job.stdout) - Buffer.byteLength(job.stderr));
      job[key] += limitedUtf8(output, remaining);
      job.outputTruncated ||= !!data.capReached || Buffer.byteLength(output) > remaining;
    });
  }

  private async init(): Promise<void> {
    if (this.stopped) throw new Error("Session runtime is closed");
    this.initialized ??= (async () => {
      this.root = await realpath(this.root);
      if (!(await stat(this.root)).isDirectory()) throw new Error("workspaceRoot must be an existing directory");
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      let saved: WebSession[] = [];
      try { saved = JSON.parse(await readFile(join(this.stateDir, "sessions.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!Array.isArray(saved)) throw new Error("Invalid sessions manifest");
      for (const session of saved) {
        if (!session.sessionId || !session.threadId || session.cwd !== this.root) throw new Error("Session manifest belongs to another workspace or is invalid");
        this.sessions.set(session.sessionId, session);
      }
      try {
        const savedJobs: WebSessionJob[] = JSON.parse(await readFile(join(this.stateDir, "jobs.json"), "utf8"));
        if (!Array.isArray(savedJobs)) throw new Error("Invalid jobs manifest");
        for (const job of savedJobs) {
          const owner = this.sessions.get(job.sessionId);
          if (!owner || owner.threadId !== job.threadId) throw new Error("Invalid persisted job owner");
          this.jobs.set(job.jobId, { ...job, stdout: "", stderr: "", outputOmittedOnRestore: true, ...(job.state === "running" ? { state: "interrupted", finishedAt: new Date().toISOString() } : {}) });
        }
        await this.persistJobs();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.server.start();
    })();
    return this.initialized;
  }
  private locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.catch(() => {});
    return result;
  }
  async prepareDesktop(): Promise<void> {
    if (!this.desktopThreadIds.length) return;
    await this.init();
    for (const threadId of [...new Set([...this.desktopThreadIds, ...[...this.sessions.values()].filter(s => s.managedDesktop).map(s => s.threadId)])]) {
      const session = [...this.sessions.values()].find(value => value.threadId === threadId);
      if (!session) throw new Error("--desktop-thread must select a task already present in this runtime's session manifest");
      await this.activate(session);
    }
  }
  private async persist(): Promise<void> {
    const target = join(this.stateDir, "sessions.json");
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify([...this.sessions.values()], null, 2), { mode: 0o600 });
    await rename(temp, target);
  }
  private persistJobs(): Promise<void> {
    const save = this.jobPersistence.then(async () => {
      const target = join(this.stateDir, "jobs.json");
      const temp = `${target}.${randomUUID()}.tmp`;
      // Persist execution state, never command output or transport error text.
      const jobs = [...this.jobs.values()].map(({ stdout, stderr, error, ...job }) => ({ ...job, stdout: "", stderr: "", outputOmittedOnRestore: true }));
      await writeFile(temp, JSON.stringify(jobs), { mode: 0o600 });
      await rename(temp, target);
    });
    this.jobPersistence = save.catch(() => {});
    return save;
  }
  private async audit(session: WebSession, operation: string, summary: Record<string, unknown>): Promise<boolean> {
    const entry = { at: new Date().toISOString(), sessionId: session.sessionId, threadId: session.threadId, operation, ...summary };
    let synced = true;
    try { await writeFile(join(this.stateDir, "operations.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a", mode: 0o600 }); }
    catch (error) { if (operation === "open") throw error; synced = false; }
    if (this.desktopThreadIds.length) return synced;
    try {
      await this.server.request("thread/inject_items", { threadId: session.threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: `[Local tool audit] ${JSON.stringify(entry)}` }] }] });
    } catch (error) {
      if (operation === "open") throw error;
      synced = false;
    }
    return synced;
  }
  private async session(sessionId: string): Promise<WebSession> {
    await this.init();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown sessionId; call open_session first");
    await this.activate(session);
    return session;
  }
  private async activate(session: WebSession): Promise<void> {
    let pending = this.activeThreads.get(session.threadId);
    if (!pending) {
      pending = this.desktopController ? this.desktopController.restore(session.threadId, session.title).then(() => {}) : (this.harness
        ? this.harness.attach(session.threadId, this.root, session.title)
        : this.server.request("thread/resume", { threadId: session.threadId }).then(() => {}));
      this.activeThreads.set(session.threadId, pending);
      pending.catch(() => this.activeThreads.delete(session.threadId));
    }
    return pending;
  }
  private async path(path: string, allowMissing = false): Promise<string> {
    if (typeof path !== "string" || path.includes("\0")) throw new Error("Invalid path");
    const absolute = resolve(this.root, path);
    if (!contained(this.root, absolute)) throw new Error("Path is outside the authorized workspace");
    let canonical: string;
    try { canonical = await realpath(absolute); }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = await realpath(dirname(absolute));
      canonical = join(parent, absolute.slice(dirname(absolute).length + 1));
      // A dangling symlink must never turn into a write target.
      try { if ((await lstat(absolute)).isSymbolicLink()) throw new Error("Refusing dangling symlink"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!contained(this.root, canonical)) throw new Error("Symlink points outside the authorized workspace");
    return canonical;
  }
  private async bytes(path: string, limit: number): Promise<Buffer> {
    const handle = await fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("Path must be a regular file");
      if (metadata.size > limit) throw new Error(`File exceeds ${limit} byte limit`);
      const bytes = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > limit) throw new Error(`File exceeds ${limit} byte limit`);
      return bytes.subarray(0, length);
    } finally { await handle.close(); }
  }

  /** Read-only correlation: never bind a legacy handle, resume or create a task. */
  async inspect(options: { sessionId?: string; requestKey?: string; conversationKey?: string }) {
    await this.init();
    const bound = options.conversationKey ? [...this.sessions.values()].find(s => s.conversationKey === options.conversationKey) : undefined;
    let session = options.sessionId ? this.sessions.get(options.sessionId) : bound;
    if (options.sessionId && !session) throw new Error("Unknown sessionId");
    if (bound && session && bound.sessionId !== session.sessionId) throw new Error("session_id belongs to a different conversation");
    session ??= options.requestKey ? [...this.sessions.values()].find(s => s.requestKey === options.requestKey) : undefined;
    if (!session) return undefined;
    if (options.conversationKey && session.conversationKey && session.conversationKey !== options.conversationKey) throw new Error("session_id belongs to a different conversation");
    if (options.requestKey && session.requestKey !== options.requestKey) throw new Error("session_id and request_key belong to different conversations");
    return { ...session };
  }

  async discovery(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    // The seed is already running. Discovery never starts an execution worker,
    // adopts its identity, or invokes a model when the seed is unavailable.
    const seed = this.desktopThreadIds[0];
    if (!seed || !this.harness?.status(seed).toolDriverConnected) throw new Error("Tool discovery host is offline; no local task was created or started.");
    return this.harness.invoke(seed, "codex_tool_inventory", args, signal);
  }

  async auditRequest(operation: string, conversation: string | undefined, clientName: string | undefined) {
    await this.init();
    await writeFile(join(this.stateDir, "requests.jsonl"), JSON.stringify({
      at: new Date().toISOString(), operation, conversationKey: conversation,
      clientName: clientName?.slice(0, 100), origin: "not_attested",
    }) + "\n", { flag: "a", mode: 0o600 });
  }

  async open(options: { title?: string; sessionId?: string; requestKey?: string; conversationKey?: string } = {}): Promise<WebSession> {
    await this.init();
    return this.locked(async () => {
      if (options.requestKey && (options.requestKey.length > 200 || !/^[\w.-]+$/.test(options.requestKey))) throw new Error("requestKey must be 1-200 letters, digits, dots, underscores or hyphens");
      if (options.conversationKey && !/^[a-f0-9]{64}$/.test(options.conversationKey)) throw new Error("Invalid conversation key");
      const bound = options.conversationKey ? [...this.sessions.values()].find(s => s.conversationKey === options.conversationKey) : undefined;
      if (bound && options.sessionId && bound.sessionId !== options.sessionId) throw new Error("session_id belongs to a different conversation");
      let existing = options.sessionId ? this.sessions.get(options.sessionId) : undefined;
      if (options.sessionId && !existing) throw new Error("Unknown sessionId");
      existing ??= bound;
      if (existing && options.requestKey && existing.requestKey !== options.requestKey) {
        throw new Error("session_id and request_key belong to different conversations. Do not share another chat's session.");
      }
      if (!existing && options.requestKey) existing = [...this.sessions.values()].find(s => s.requestKey === options.requestKey);
      if (existing) {
        if (options.conversationKey && existing.conversationKey && existing.conversationKey !== options.conversationKey) throw new Error("session_id belongs to a different conversation");
        if (options.conversationKey && !existing.conversationKey) {
          const previous = existing;
          existing = { ...existing, conversationKey: options.conversationKey };
          this.sessions.set(existing.sessionId, existing);
          try { await this.persist(); } catch (error) { this.sessions.set(previous.sessionId, previous); throw error; }
        }
        await this.activate(existing);
        await this.audit(existing, "resume", {});
        return { ...existing };
      }
      if (this.desktopThreadIds.length) {
        if (!options.requestKey && !options.conversationKey) throw new Error("Conversation identity is required");
        const available = [...this.sessions.values()].find(session => this.desktopThreadIds.includes(session.threadId) && !session.requestKey && !session.conversationKey);
        if (!available && this.desktopController) {
          const title = (options.title?.trim() || "网页本地工具").slice(0, 160);
          const prepared = await this.desktopController.prepare(title, options.conversationKey ?? options.requestKey);
          const session: WebSession = { ...prepared, sessionId: randomUUID(), createdAt: new Date().toISOString(), requestKey: options.requestKey, conversationKey: options.conversationKey, managedDesktop: true };
          this.sessions.set(session.sessionId, session);
          try { await this.persist(); } catch (error) { this.sessions.delete(session.sessionId); throw error; }
          await this.audit(session, "open", { title });
          return { ...session };
        }
        if (!available) throw new Error(`Desktop session capacity reached (${this.desktopThreadIds.length}). Do not reuse another chat's session_id; all configured native execution slots are assigned.`);
        await this.activate(available);
        const assigned = { ...available, requestKey: options.requestKey, conversationKey: options.conversationKey, title: (options.title?.trim() || available.title).slice(0, 160) };
        this.sessions.set(assigned.sessionId, assigned);
        try { await this.persist(); }
        catch (error) { this.sessions.set(available.sessionId, available); throw error; }
        await this.audit(assigned, "assign", {});
        return { ...assigned };
      }
      const title = (options.title?.trim() || "ChatGPT web workspace").slice(0, 160);
      const prepared = await this.harness?.prepare(this.root);
      const result = await this.server.request<{ thread: { id: string } }>("thread/start", {
        cwd: this.root, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: false,
        ...prepared?.params,
      });
      if (!result.thread?.id) throw new Error("Codex did not return a threadId");
      const session: WebSession = { sessionId: randomUUID(), threadId: result.thread.id, cwd: this.root, title, createdAt: new Date().toISOString(), ...(options.requestKey ? { requestKey: options.requestKey } : {}), ...(options.conversationKey ? { conversationKey: options.conversationKey } : {}) };
      if (prepared) this.harness!.bind(prepared.key, session.threadId);
      // Injection creates the rollout file without invoking a model turn.
      await this.audit(session, "open", { title });
      await this.server.request("thread/name/set", { threadId: session.threadId, name: title });
      await this.harness?.connectThread(session.threadId, title);
      this.activeThreads.set(session.threadId, Promise.resolve());
      this.sessions.set(session.sessionId, session);
      await this.persist();
      return { ...session };
    });
  }

  async nativeTool(sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal, requestInput?: NativeInputHandler): Promise<CallToolResult> {
    const session = await this.session(sessionId);
    if (!this.harness) throw new Error("Native harness is unavailable in this runtime");
    const action = () => this.harness!.invoke(session.threadId, name, args, signal, requestInput);
    if (!this.desktopController) return action();
    const wire = String(args.wire_name ?? "");
    // A long-running native command carries its own process session ID. Keep
    // it alive until write_stdin observes an exit code. Opaque JS/REPL calls
    // remain pinned because their process lifetime cannot be inferred safely.
    const opaque = /(?:^|__)exec$|repl/.test(wire) && !wire.endsWith("js_reset");
    if (opaque) this.desktopController.pin(session.threadId, /cua_repl/.test(wire) ? "cua-kernel" : "opaque-runtime");
    const result = await this.desktopController.withDriver(session.threadId, action);
    if (/cua_repl__js_reset$/.test(wire) && !result.isError) this.desktopController.unpin(session.threadId, "cua-kernel");
    if (["exec_command", "write_stdin"].includes(wire)) {
      const outputs = result.content.flatMap(c => { if (c.type !== "text") return []; try { return [JSON.parse(c.text)]; } catch { return []; } });
      const state = outputs.find(x => x && typeof x === "object" && (typeof x.exit_code === "number" || typeof x.session_id === "number"));
      if (state?.session_id != null && state.exit_code == null) this.desktopController.pin(session.threadId, `command:${state.session_id}`);
      else if (typeof state?.exit_code === "number" && wire === "write_stdin") {
        const original = args.arguments as Record<string, unknown> | undefined;
        if (typeof original?.session_id === "number") this.desktopController.unpin(session.threadId, `command:${original.session_id}`);
      } else if (!state) this.desktopController.pin(session.threadId, "unknown-command");
    }
    return result;
  }

  async info(sessionId: string, activate = true) {
    const session = activate ? await this.session(sessionId) : await this.inspect({ sessionId });
    if (!session) throw new Error("Unknown sessionId");
    const sessionJobs = [...this.jobs.values()].filter(j => j.sessionId === sessionId);
    return { ...session, ...this.harness?.status(session.threadId),
      desktopLifecycle: this.desktopController?.status(session.threadId),
      connectionPolicy: { tunnel: "shared_persistent", desktopSessionCapacity: this.desktopController ? null : this.desktopThreadIds.length || null,
        allocation: this.desktopController ? "on_demand" : "configured", conversationRouting: session.conversationKey ? "host_metadata" : "model_handle",
        assignedDesktopSessions: this.desktopThreadIds.length ? [...this.sessions.values()].filter(s => this.desktopThreadIds.includes(s.threadId) && (s.requestKey || s.conversationKey)).length : null,
        browserCloseDisconnects: false, nativeIdleRelease: !!this.desktopController, physicalDesktop: "shared" },
      auxiliaryProcess: this.server instanceof IdleAppServer ? this.server.status() : undefined,
      jobCount: sessionJobs.length, jobsTruncated: sessionJobs.length > 100,
      jobs: sessionJobs.slice(-100).map(({ stdout, stderr, error, ...job }) => job) };
  }
  async readFile(sessionId: string, path: string) {
    const session = await this.session(sessionId);
    const canonical = await this.path(path);
    const bytes = await this.bytes(canonical, TEXT_LIMIT);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("File is binary; use view_image for images");
    const result = { path: relative(this.root, canonical), content, sha256: digest(bytes), bytes: bytes.length };
    await this.audit(session, "read_file", { path: result.path, bytes: result.bytes, sha256: result.sha256 });
    return result;
  }
  async writeFile(sessionId: string, path: string, content: string, expectedSha256?: string) {
    const session = await this.session(sessionId);
    if (Buffer.byteLength(content) > TEXT_LIMIT) throw new Error("Text exceeds 1 MiB limit");
    return this.locked(async () => {
      const canonical = await this.path(path, true);
      let previous: Buffer | undefined;
      try { previous = await this.bytes(canonical, TEXT_LIMIT); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (previous && expectedSha256 === undefined) throw new Error("Existing files require expectedSha256 from read_file before replacement");
      if (expectedSha256 !== undefined && (previous ? digest(previous) : "") !== expectedSha256) throw new Error("File changed: expectedSha256 does not match (use empty string to require a new file)");
      const temp = join(dirname(canonical), `.web-session-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, content, { flag: "wx", mode: previous ? (await stat(canonical)).mode & 0o777 : 0o600 });
        await this.path(canonical, true);
        await rename(temp, canonical);
      } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      const result = { path: relative(this.root, canonical), sha256: digest(content), bytes: Buffer.byteLength(content), created: !previous };
      const audited = await this.audit(session, "write_file", result);
      return { ...result, ...(!audited ? { auditWarning: "File write succeeded, but audit synchronization failed; do not repeat this write" } : {}) };
    });
  }
  async listFiles(sessionId: string, path = ".") {
    const session = await this.session(sessionId);
    const canonical = await this.path(path);
    const entries: Dirent[] = await readdir(canonical, { withFileTypes: true });
    const result = { path: relative(this.root, canonical) || ".", entries: entries.slice(0, 2000).map(e => ({ name: e.name, type: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "directory" : e.isFile() ? "file" : "other" })), truncated: entries.length > 2000 };
    await this.audit(session, "list_files", { path: result.path, entries: result.entries.length });
    return result;
  }
  async viewImage(sessionId: string, path: string) {
    const session = await this.session(sessionId);
    const canonical = await this.path(path);
    const bytes = await this.bytes(canonical, IMAGE_LIMIT);
    let mimeType: string;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = "image/jpeg";
    else if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) mimeType = "image/gif";
    else if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") mimeType = "image/webp";
    else throw new Error("Unsupported image format; expected PNG, JPEG, GIF or WebP signature");
    await this.audit(session, "view_image", { path: relative(this.root, canonical), bytes: bytes.length, mimeType });
    return { path: relative(this.root, canonical), mimeType, bytes };
  }

  async exec(sessionId: string, options: { command: string[]; timeoutMs?: number; cwd?: string }): Promise<WebSessionJob> {
    const session = await this.session(sessionId);
    if (!Array.isArray(options.command) || !options.command.length || options.command.some(s => typeof s !== "string" || s.includes("\0")) || options.command.join("").length > 32768) throw new Error("command must be a nonempty array of strings (at most 32 KiB)");
    const cwd = await this.path(options.cwd ?? ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd must be a directory");
    const timeoutMs = options.timeoutMs ?? 60000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error("timeoutMs must be 100-300000");
    if ([...this.jobs.values()].filter(job => job.state === "running").length >= MAX_ACTIVE_JOBS) {
      throw new Error(`Local command capacity reached (${MAX_ACTIVE_JOBS}). Poll existing jobs before submitting more work.`);
    }
    const job: WebSessionJob = { jobId: randomUUID(), sessionId, threadId: session.threadId, state: "running", stdout: "", stderr: "", outputTruncated: false, startedAt: new Date().toISOString() };
    this.jobs.set(job.jobId, job);
    this.decoders.set(job.jobId, { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") });
    await this.persistJobs();
    await this.audit(session, "exec_start", { jobId: job.jobId, executable: options.command[0], argumentCount: options.command.length - 1, cwd: relative(this.root, cwd), timeoutMs });
    void this.server.request<{ exitCode?: number; stdout?: string; stderr?: string }>("command/exec", {
      command: options.command, cwd, processId: job.jobId, streamStdoutStderr: true, timeoutMs, outputBytesCap: OUTPUT_LIMIT,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [this.root], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    }, { timeoutMs: timeoutMs + 10000 }).then(async result => {
      if (job.state === "running") job.state = this.cancellations.has(job.jobId) ? "cancelled" : result.exitCode === 0 ? "completed" : "failed";
      job.exitCode = result.exitCode;
      for (const key of ["stdout", "stderr"] as const) {
        if (result[key]) {
          const remaining = Math.max(0, OUTPUT_LIMIT - Buffer.byteLength(job.stdout) - Buffer.byteLength(job.stderr));
          job[key] += limitedUtf8(result[key], remaining);
          job.outputTruncated ||= Buffer.byteLength(result[key]) > remaining;
        }
      }
      job.finishedAt = new Date().toISOString();
      this.decoders.delete(job.jobId);
      this.cancellations.delete(job.jobId);
      await this.persistJobs();
      await this.audit(session, "exec_finish", { jobId: job.jobId, state: job.state, exitCode: job.exitCode, outputTruncated: job.outputTruncated });
    }).catch(async error => {
      if (job.state === "running") job.state = "failed";
      job.error = errorMessage(error).slice(0, 2000);
      this.decoders.delete(job.jobId);
      this.cancellations.delete(job.jobId);
      job.finishedAt = new Date().toISOString();
      await this.persistJobs().catch(() => {});
      await this.audit(session, "exec_finish", { jobId: job.jobId, state: job.state }).catch(() => {});
    });
    return { ...job };
  }
  async poll(sessionId: string, jobId: string): Promise<WebSessionJob> {
    await this.session(sessionId);
    const job = this.jobs.get(jobId);
    if (!job || job.sessionId !== sessionId) throw new Error("Unknown jobId for this session");
    return { ...job };
  }
  async cancel(sessionId: string, jobId: string): Promise<WebSessionJob> {
    const job = await this.poll(sessionId, jobId);
    if (job.state !== "running") return job;
    this.cancellations.add(jobId);
    try { await this.server.request("command/exec/terminate", { processId: jobId }); }
    catch (error) { this.cancellations.delete(jobId); throw error; }
    const actual = this.jobs.get(jobId)!;
    // A terminate acknowledgement is not process completion. Keep polling until
    // the original command/exec response supplies its exit status.
    await this.audit(await this.session(sessionId), "exec_cancel", { jobId });
    return { ...actual };
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.desktopController?.close();
    await this.queue;
    this.unsubscribe();
    for (const job of this.jobs.values()) if (job.state === "running") { job.state = "interrupted"; job.finishedAt = new Date().toISOString(); }
    if (this.initialized) await this.persistJobs();
    await this.harness?.close();
    await this.server.close();
    await this.jobPersistence;
  }
}
