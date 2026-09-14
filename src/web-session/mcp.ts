import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { conversationKey } from "./conversation";
import { WebSessionRuntime } from "./sessions";
import { diagnoseCuaResult } from "./cua-diagnostics";
import { NativeInputRequiredError, type NativeInputHandler, type ToolAccess } from "./approvals";

export const WEB_SESSION_INSTRUCTIONS =
  "Use these tools for work on the user's local computer directly from this ChatGPT conversation. " +
  "Call codex_tool_inventory when local tools are needed. Discovery does not create or start a task. Actual local tool calls automatically select or create this chat's session; omit session_id and request_key normally. Do not use this connector for unsolicited background suggestions or generic capability probes unrelated to the user's current local-tool request. " +
  "Session bookkeeping is internal: never ask the user for session_id, request_key, a setup prompt, or permission to create the ordinary local execution context. " +
  "If this client omits conversation metadata, choose a unique UUID request_key yourself once and reuse the returned session_id throughout this chat. Never borrow another chat's identity. " +
  "If the native execution host is unavailable, report its actual error. Do not claim that opening a logical session repaired it or ask the user to manage slot IDs. " +
  "The tunnel is shared and persistent, independent of whether a browser chat tab is open. web_session_info reports native connection state separately. A disconnected native driver is not repaired merely by reopening the logical session. Never replay an operation with unknown outcome. " +
  "No outer Codex request, turn_token, or pasted Codex prompt is needed. " +
  "Use codex_tool_inventory to discover existing native Codex and MCP tools, then codex_tool_call with the exact wire_name and declared arguments (or input for freeform tools). Browser tools are existing cua_repl tools: follow their returned documentation. Never relay back into this connector. " +
  "The native registry may include discovery-only gateway entries with generic schemas: use the runtime's tool search or returned tool documentation to learn their arguments, then refresh inventory if new tools were loaded. Do not guess schemas. " +
  "For inventory pagination keep query and include_schema unchanged; offset 0 starts a fresh stable snapshot, including newly loaded tools. " +
  "Local skills and project instructions are files: discover and read the relevant SKILL.md/AGENTS.md using the existing file or command tools before applying them. They are not automatically copied into this web chat. " +
  "Check web_session_info.executionHost to distinguish standalone and Desktop execution. Standalone may not register Desktop-only UI tools. Use the actual inventory, available CLI/API tools or native CUA; never claim an unavailable Desktop API was called. " +
  "Non-model tools retain their native permissions and prerequisites. Subagents, model-starting task prompts, image generation and autonomous goal starts are excluded. Do not launch those through shell commands or another gateway. " +
  "A listed tool is discoverable, not proof it works: verify the actual file, command status, or changed UI before reporting success. get_app_state is internal to cua.getApp/getAXState, not a separate public tool to discover. A lock observation alone does not prove missing permissions or require changing settings. If the native host reports automatic unlock paused because physical input was detected, stop Computer Use requests and explain its manual-unlock requirement; Always allow does not clear that safeguard. Never restart services, create another task, or switch input paths to bypass it. Do not promise the next attempt will succeed. If an action reports cgWindowNotFound or noWindowsAvailable without that pause, inspect its diagnostic before retrying; do not repeat a potentially completed action blindly. In Chrome, the native Window menu Center action may restore a misplaced window; inspect available menu items before using it, then verify a harmless interaction. This is a recovery option, not a guaranteed fix. Prefer native paste with format text for exact punctuation, Unicode or multiline input. " +
  "Read files before editing; pass the returned sha256 when replacing existing files. " +
  "web_exec returns a job_id; poll it until terminal status before claiming the command succeeded. " +
  "Use web_view_image to see local image pixels. Tool errors are failures: report them, never invent results.";

function result(data: unknown): CallToolResult {
  const keys: Record<string, string> = { sessionId: "session_id", threadId: "thread_id", jobId: "job_id", requestKey: "request_key", createdAt: "created_at", startedAt: "started_at", finishedAt: "finished_at", exitCode: "exit_code", outputTruncated: "output_truncated" };
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [keys[key] ?? key, normalize(child)]));
    return value;
  };
  const normalized = normalize(data);
  return { content: [{ type: "text", text: JSON.stringify(normalized) }], structuredContent: { result: normalized } };
}

async function guarded(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await action(); }
  catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

export function createWebSessionMcp(runtime: WebSessionRuntime): McpServer {
  const server = new McpServer({ name: "Codex Web Sessions", version: "1.0.0" }, {
    instructions: WEB_SESSION_INSTRUCTIONS,
  });
  const sessionId = z.string().min(1).max(160).describe("Internal compatibility handle. Normally omit: ChatGPT supplies this conversation identity automatically. Never ask the user for it.");
  const requestInput: NativeInputHandler = async (params, signal) => {
    const mode = params.mode === "url" ? "url" : "form";
    const capabilities = server.server.getClientCapabilities()?.elicitation;
    if (!capabilities || !(mode in capabilities)) throw new NativeInputRequiredError(`The local tool requires ${mode} user input, but this ChatGPT client does not support MCP elicitation. Complete the requested input in the app and retry.`);
    return server.server.elicitInput(params, { signal, timeout: 80_000 });
  };
  const path = z.string().min(1).max(4096).describe("Path relative to this session's workspace, or an absolute path inside it.");
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const connection = {
    session_id: sessionId.optional(),
    request_key: z.string().min(8).max(160).regex(/^[\w.-]+$/).optional().describe("Legacy client fallback only: generate a unique UUID yourself if the host omits conversation metadata. Never ask the user for a key."),
    title: z.string().min(1).max(160).optional(),
  };
  const connect = async (input: { session_id?: string; request_key?: string; title?: string }, extra: { _meta?: unknown }, operation: string) => {
    const key = conversationKey(extra._meta);
    if (!key && !input.session_id && !input.request_key) throw new Error("This client omitted ChatGPT conversation metadata. Generate a UUID request_key yourself, retry once with that key, and retain the returned session_id. Do not ask the user for either value.");
    await runtime.auditRequest(operation, key, server.server.getClientVersion()?.name);
    return runtime.open({ sessionId: input.session_id, requestKey: input.request_key, title: input.title, conversationKey: key });
  };
  server.registerTool("web_open_session", {
    title: "Connect this chat to local tools",
    description: "Automatically select or create this chat's local context using host conversation metadata. All local tools connect automatically; this explicit entry point is optional. No session management or setup prompt from the user is needed.",
    inputSchema: connection,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => guarded(async () => result(await connect(input, extra, "web_open_session"))));
  server.registerTool("codex_tool_inventory", {
    title: "Discover existing Codex tools",
    description: "Read the already-online host tool registry without creating or waking a local task. This shared capability catalog includes browser and configured MCP tools; actual availability is validated when a tool is called. Uses the original project's inventory gateway. Normally omit session_id/request_key: host conversation metadata connects this chat automatically. Use exact wire_name. Gateway entries may have generic schemas; consult tool discovery or returned documentation before calling them.",
    inputSchema: { ...connection, query: z.string().max(500).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20), include_schema: z.boolean().default(true) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input, extra) => guarded(async () => {
    const key = conversationKey(extra._meta);
    await runtime.inspect({ sessionId: input.session_id, requestKey: input.request_key, conversationKey: key });
    await runtime.auditRequest("codex_tool_inventory", key, server.server.getClientVersion()?.name);
    const native = await runtime.discovery({ query: input.query, offset: input.offset, limit: input.limit, include_schema: input.include_schema }, extra.signal);
    const discovery = { scope: "shared_host_capabilities", execution_session_created: false, note: "Actual tool calls auto-connect this conversation; this catalog is not a per-session availability guarantee." };
    return { ...native, structuredContent: { ...native.structuredContent, discovery }, content: [{ type: "text", text: JSON.stringify(discovery) }, ...native.content] };
  }));
  server.registerTool("codex_tool_call", {
    title: "Call an existing Codex tool",
    description: "Invoke an exact wire_name discovered by codex_tool_inventory. The real Codex turn executes the existing tool with native context, permissions and result/image handling. Browser state belongs to this local session. This does not invoke another model.",
    inputSchema: { ...connection, wire_name: z.string().min(1).max(1000), arguments: z.record(z.string(), z.unknown()).optional(), input: z.string().max(5_000_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (input, extra) => guarded(async () => {
    const session = await connect(input, extra, "codex_tool_call");
    const native = await runtime.nativeTool(session.sessionId, "codex_tool_call", { wire_name: input.wire_name, arguments: input.arguments, input: input.input }, extra.signal, requestInput);
    // A native tool may have its own session_id/thread_id fields. Its result is
    // opaque here; relay identity is already returned by inventory/open_session.
    return diagnoseCuaResult(input.wire_name, native);
  }));
  server.registerTool("web_session_info", {
    title: "Inspect the local session", description: "Read this conversation's local Codex thread ID, workspace, native driver state, connection policy, and up to 100 recent job summaries. Use web_poll_job to retrieve command output.",
    inputSchema: { ...connection }, annotations: read,
  }, async (input, extra) => guarded(async () => {
    const key = conversationKey(extra._meta);
    await runtime.auditRequest("web_session_info", key, server.server.getClientVersion()?.name);
    const session = await runtime.inspect({ sessionId: input.session_id, requestKey: input.request_key, conversationKey: key });
    return result(session ? await runtime.info(session.sessionId, false) : { connected: false, execution_session_created: false });
  }));
  server.registerTool("web_list_files", {
    title: "List local workspace files", description: "List a directory in the session's authorized local workspace.",
    inputSchema: { ...connection, path: path.optional() }, annotations: read,
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_list_files");
    const { path } = input;
    return result(await runtime.listFiles(sessionId, path ?? "."));
  }));
  server.registerTool("web_read_file", {
    title: "Read a local text file", description: "Read a UTF-8 file and its sha256 before editing. Maximum 1 MiB. Use web_view_image for images.",
    inputSchema: { ...connection, path }, annotations: read,
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_read_file");
    const { path } = input;
    return result(await runtime.readFile(sessionId, path));
  }));
  server.registerTool("web_write_file", {
    title: "Write a local text file", description: "Create or replace a UTF-8 file in this session's workspace. For an existing file pass expected_sha256 from web_read_file to prevent overwriting concurrent edits.",
    inputSchema: { ...connection, path, content: z.string().max(1_048_576), expected_sha256: z.string().regex(/^(?:[a-f0-9]{64})?$/).optional().describe("sha256 from the last read; empty string means create only if absent.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_write_file");
    const { path, content, expected_sha256 } = input;
    return result(await runtime.writeFile(sessionId, path, content, expected_sha256));
  }));
  server.registerTool("web_view_image", {
    title: "View a local image", description: "Read actual PNG, JPEG, WebP or GIF image pixels from the local workspace and return them for visual inspection. Maximum 8 MiB.",
    inputSchema: { ...connection, path }, annotations: read,
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_view_image");
    const { path } = input;
    const image = await runtime.viewImage(sessionId, path);
    return { content: [
      { type: "text", text: `Local image: ${path}` },
      { type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType },
    ] };
  }));
  server.registerTool("web_exec", {
    title: "Run a local command", description: "Execute an argv array through the Codex workspace-write sandbox. Returns a job_id immediately; use web_poll_job to get output and exit status. For shell syntax explicitly use ['/bin/sh','-c','...']. Commands are real, not simulated.",
    inputSchema: { ...connection, command: z.array(z.string().max(32768)).min(1).max(128), timeout_ms: z.number().int().min(100).max(300_000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_exec");
    const { command, timeout_ms } = input;
    return result(await runtime.exec(sessionId, { command, timeoutMs: timeout_ms }));
  }));
  server.registerTool("web_poll_job", {
    title: "Read command output and status", description: "Get bounded stdout/stderr, status and exit code of a command in this session. A running status is not success; poll again when needed.",
    inputSchema: { ...connection, job_id: z.string().min(1).max(160) }, annotations: read,
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_poll_job");
    const { job_id } = input;
    return result(await runtime.poll(sessionId, job_id));
  }));
  server.registerTool("web_cancel_job", {
    title: "Stop a local command", description: "Cancel a running command belonging to this session. Poll its final state after requesting cancellation.",
    inputSchema: { ...connection, job_id: z.string().min(1).max(160) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, extra) => guarded(async () => {
    const { sessionId } = await connect(input, extra, "web_cancel_job");
    const { job_id } = input;
    return result(await runtime.cancel(sessionId, job_id));
  }));
  return server;
}

export async function runWebSessionMcp(options: { stateDir: string; workspaceRoot: string; codexBinary?: string; allowedApps?: string[]; sidebarSection?: string; toolAccess?: ToolAccess; desktopThreadId?: string | readonly string[]; desktopProviderRegistry?: string }): Promise<void> {
  // The upstream broker uses console.info; stdio MCP reserves stdout for JSON-RPC.
  console.info = console.error;
  console.log = console.error;
  const runtime = new WebSessionRuntime(options);
  await runtime.prepareDesktop();
  const server = createWebSessionMcp(runtime);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
    await server.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  process.stdin.once("end", () => void close());
  await server.connect(new StdioServerTransport());
}
