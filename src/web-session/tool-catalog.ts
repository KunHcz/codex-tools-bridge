import { namespacedToolName, type CodexTool } from "../types";

/** Structural subset of the App Server's MCP status response; schema values stay intact. */
export interface McpCatalogTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface McpCatalogServer {
  name: string;
  tools: Record<string, McpCatalogTool | undefined>;
}

export interface CatalogEntry extends McpCatalogTool {
  wire_name: string;
  server_name: string;
  namespace: string;
}

export interface CatalogQuery {
  query?: string;
  offset?: number;
  limit?: number;
  includeSchema?: boolean;
}

// The same reserved forwarding surface as the original ChatGPT bridge. Exposing it
// through itself would recursively re-enter the tunnel instead of executing a tool.
const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start", "codex_exec", "codex_write_stdin", "codex_apply_patch",
  "codex_view_image", "codex_tool_inventory", "codex_tool_call", "codex_turn_complete",
]);
const WEB_SESSION_TOOL_NAMES = new Set([
  "web_open_session", "web_session_info", "web_list_files", "web_read_file",
  "web_write_file", "web_view_image", "web_exec", "web_poll_job", "web_cancel_job",
]);
const BRIDGE_SERVER_NAMES = new Set(["codex_web_sessions", "codex_chatgpt_web"]);

/** Explicitly opt in when reusing the upstream bridge without a second model.
 * Match both dotted app names and native gateway names with underscore prefixes.
 */
export const WEB_SESSION_BLOCKED_TOOL_PATTERNS = [
  `(?:^|[._])(?:${[...BRIDGE_TOOL_NAMES, ...WEB_SESSION_TOOL_NAMES].join("|")})$`,
  "(?:^|[._-])codex[_-](?:web[_-]sessions|chatgpt[_-]web)(?:[._-]|$)",
  "^codex\\.control\\.turn_complete$",
  "(?:^|[._])(?:spawn_agent|followup_task|resume_agent|send_input|create_thread|send_message_to_thread)$",
  "(?:^|[._])(?:create_goal|imagegen)$",
  "(?:^|[._])(?:collaboration|multi_agent_v[0-9]+)(?:__|\\.)(?:send_message)$",
];
/** These tools mix administrative actions with model-starting actions. Missing
 * fields count as null, allowing handoff's optional follow-up to remain absent.
 */
export const WEB_SESSION_TOOL_ARGUMENT_POLICIES = [
  {
    toolNamePattern: "(?:^|[._])handoff_thread$",
    anyOf: [{ followUpPrompt: [null, ""] }],
    reason: "Moving a task is available; starting a follow-up model turn is disabled.",
  },
  {
    toolNamePattern: "(?:^|[._])automation_update$",
    anyOf: [
      { mode: ["view", "delete"] },
      { mode: ["create", "suggested_create", "update", "suggested_update"], status: ["PAUSED"] },
    ],
    reason: "Reading, deleting, or saving a paused automation is available; scheduling model runs is disabled.",
  },
];
const webSessionBlockedPatterns = WEB_SESSION_BLOCKED_TOOL_PATTERNS.map(pattern => new RegExp(pattern));
export function isWebSessionBlockedTool(name: string): boolean {
  return webSessionBlockedPatterns.some(pattern => pattern.test(name));
}

function normalizedServerName(name: string): string {
  return name.toLowerCase().replaceAll("-", "_");
}

function recursiveTool(name: string): boolean {
  const parts = name.split(/\.|__/);
  return BRIDGE_TOOL_NAMES.has(parts.at(-1)!)
    || WEB_SESSION_TOOL_NAMES.has(parts.at(-1)!)
    || parts.some(part => BRIDGE_SERVER_NAMES.has(normalizedServerName(part)))
    || name === "codex.control.turn_complete";
}

/** Filter the real native turn registry before registering it with the original broker.
 * Keep built-in exec, freeform tools, and discovery tools unchanged. Shared app
 * namespaces are filtered per tool, since dropping them would hide unrelated apps.
 */
export function filterNativeTools(tools: readonly CodexTool[]): CodexTool[] {
  const serverName = (namespace: string) => namespace.startsWith("mcp__") ? namespace.slice(5) : namespace;
  const bridgeNamespaces = new Set(tools.filter(tool => tool.namespace
    && serverName(tool.namespace) !== "codex_apps"
    && recursiveTool(tool.name)).map(tool => tool.namespace!));
  return tools.filter(tool => !isWebSessionBlockedTool(wireNameOf(tool))
    && (!tool.namespace || (!bridgeNamespaces.has(tool.namespace)
      && !BRIDGE_SERVER_NAMES.has(normalizedServerName(serverName(tool.namespace))))));
}

function wireNameOf(tool: CodexTool): string { return namespacedToolName(tool.namespace, tool.name); }

/** Build from all pages of mcpServerStatus/list. Never infer a route by splitting a wire name. */
export function buildToolCatalog(servers: readonly McpCatalogServer[]): CatalogEntry[] {
  const result: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    const entries = Object.entries(server.tools).filter((entry): entry is [string, McpCatalogTool] => entry[1] !== undefined);
    const sharedApps = server.name === "codex_apps";
    if (BRIDGE_SERVER_NAMES.has(normalizedServerName(server.name))) continue;
    // codex_apps aggregates unrelated integrations, so only hide its bridge entries.
    if (!sharedApps && entries.some(([key, tool]) => recursiveTool(key) || recursiveTool(tool.name))) continue;
    for (const [name, tool] of entries) {
      if (recursiveTool(name) || recursiveTool(tool.name)) continue;
      if (!server.name || !name) throw new Error("MCP catalog contains an empty server or tool name");
      const namespace = `mcp__${server.name}`;
      const wire_name = namespacedToolName(namespace, name);
      if (seen.has(wire_name)) throw new Error(`Ambiguous MCP tool wire name: ${wire_name}`);
      seen.add(wire_name);
      result.push({ ...tool, name, namespace, wire_name, server_name: server.name });
    }
  }
  return result.sort((left, right) => left.wire_name < right.wire_name ? -1 : left.wire_name > right.wire_name ? 1 : 0);
}

/** Search before slicing, so pagination counts and next_offset describe matching tools. */
export function filterToolCatalog(catalog: readonly CatalogEntry[], options: CatalogQuery = {}) {
  const { offset = 0, limit = 20, includeSchema = true } = options;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer between 1 and 50");
  const needle = options.query?.trim().toLowerCase();
  const matches = catalog.filter(tool => !needle || [
    tool.wire_name, tool.name, tool.server_name, tool.title ?? "", tool.description ?? "",
  ].join("\n").toLowerCase().includes(needle));
  const tools = matches.slice(offset, offset + limit).map(tool => ({
    wire_name: tool.wire_name,
    server_name: tool.server_name,
    name: tool.name,
    namespace: tool.namespace,
    kind: "function" as const,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description ?? "",
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(includeSchema ? {
      inputSchema: tool.inputSchema,
      // Preserve the original bridge inventory field for clients already using it.
      parameters: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    } : {}),
  }));
  return { tools, total: matches.length, next_offset: offset + tools.length < matches.length ? offset + tools.length : null };
}

/** Only a name actually supplied by the runtime can be called; dotted names are valid. */
export function resolveTool(catalog: readonly CatalogEntry[], wireName: string): CatalogEntry {
  const matches = catalog.filter(tool => tool.wire_name === wireName);
  if (matches.length > 1) throw new Error(`Ambiguous MCP tool wire name: ${wireName}`);
  if (!matches.length) throw new Error(`MCP tool is not available: ${wireName}`);
  return matches[0]!;
}
