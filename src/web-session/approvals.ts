import { ElicitRequestParamsSchema, type ElicitRequestParams, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolAccess = "configured" | "all";
export type NativeInputHandler = (params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult>;
/** Only static, client-authored errors may be returned through the RPC channel. */
export class NativeInputRequiredError extends Error {}

/** Resolve only requests belonging to an actual outstanding native tool call.
 * The all mode is an explicit operator grant for this web runtime, not a global
 * Codex preference. Input forms and login URLs still require real user input.
 */
export async function respondToNativeRequest(method: string, p: any, options: {
  active: boolean; toolAccess: ToolAccess; allowedApps: readonly string[];
  signal: AbortSignal; requestInput?: NativeInputHandler;
}): Promise<unknown> {
  if (options.active) options.signal.throwIfAborted();
  const full = options.active && options.toolAccess === "all";
  const meta = p?._meta;
  const emptyForm = ["form", "openai/form", "openaiForm"].includes(p?.mode)
    && p.requestedSchema?.type === "object"
    && Object.keys(p.requestedSchema.properties ?? {}).length === 0
    && (p.requestedSchema.required ?? []).length === 0;
  const nativeConfirmation = emptyForm && meta?.codex_approval_kind === "mcp_tool_call"
    && typeof meta.tool_name === "string" && meta.tool_name.length > 0;
  const allowedApp = options.active && p?.serverName === "cua_repl"
    && meta?.connector_id === "computer-use"
    && options.allowedApps.includes(meta?.tool_params?.app);
  if (method === "mcpServer/elicitation/request") {
    if (nativeConfirmation && (full || allowedApp)) return { action: "accept", content: {}, _meta: null };
    if (options.active && options.requestInput) {
      const input = ElicitRequestParamsSchema.parse(p.mode === "url"
        ? { mode: "url", message: p.message, url: p.url, elicitationId: p.elicitationId }
        : { mode: "form", message: p.message, requestedSchema: p.requestedSchema });
      const response = await options.requestInput(input, options.signal);
      options.signal.throwIfAborted();
      if (response.action === "accept" && input.mode !== "url" && Object.keys(input.requestedSchema.properties).length
        && (!response.content || typeof response.content !== "object")) throw new NativeInputRequiredError("The client accepted the input request without providing answers");
      return response;
    }
    return { action: "decline", content: null, _meta: null };
  }
  if (full && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    if (p.availableDecisions && !p.availableDecisions.includes("accept")) throw new Error("Native approval does not offer accept");
    return { decision: "accept" };
  }
  if (full && method === "item/permissions/requestApproval") {
    return { permissions: p.permissions ?? {}, scope: "turn" };
  }
  if (options.active && options.requestInput && ["item/tool/requestUserInput", "tool/requestUserInput"].includes(method)) {
    const questions = p.questions as Array<{ id: string; header: string; question: string; options?: Array<{ label: string; description: string }> }>;
    const response = await options.requestInput({ mode: "form", message: "The local tool needs your input.", requestedSchema: {
      type: "object", properties: Object.fromEntries(questions.map(q => [q.id, { type: "string", title: q.header,
        description: q.question + (q.options?.length ? "\n" + q.options.map(o => `${o.label}: ${o.description}`).join("\n") : "") }])),
      required: questions.map(q => q.id),
    } }, options.signal);
    options.signal.throwIfAborted();
    if (response.action !== "accept") throw new Error("User cancelled the local tool's input request");
    if (!response.content || questions.some(q => typeof response.content?.[q.id] !== "string")) throw new NativeInputRequiredError("The client did not supply every requested answer");
    return { answers: Object.fromEntries(questions.map(q => [q.id, { answers: [response.content![q.id]] }])) };
  }
  throw new Error(`Local tool needs an explicit operator decision: ${method}`);
}
