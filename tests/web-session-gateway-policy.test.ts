import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { WEB_SESSION_BLOCKED_TOOL_PATTERNS, WEB_SESSION_TOOL_ARGUMENT_POLICIES, filterNativeTools } from "../src/web-session/tool-catalog";
import type { CodexTool } from "../src/types";

const blockedNames = ["mcp__codex_apps__codex_web_sessions_codex_tool_call", "mcp__codex_apps__codex_native2_codex_exec", "collaboration__spawn_agent", "collaboration__followup_task", "mcp__codex_app__send_message_to_thread", "create_goal", "image_gen__imagegen"];
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nativeStore = new Map<string, unknown>();
async function execute(input: string, names: string[]) {
  const output: { type: "text"; text: string }[] = [];
  const calls: string[] = [];
  const tools = Object.fromEntries(names.map(name => [name, async () => { calls.push(name); return "called"; }]));
  await new AsyncFunction("tools", "ALL_TOOLS", "text", "store", "load", input)(tools, names.map(name => ({ name, description: name })), (value: unknown) => output.push({ type: "text", text: String(value) }), (key: string, value: unknown) => nativeStore.set(key, structuredClone(value)), (key: string) => structuredClone(nativeStore.get(key)));
  return { output, calls };
}
async function withBridge(blocked: boolean, run: (client: Client, broker: TurnBroker, token: string, directory: string) => Promise<void>, extraTools: CodexTool[] = []) {
  const directory = await mkdtemp("/tmp/web-gateway-test-");
  const broker = TurnBroker.forSocket(join(directory, "broker.sock"));
  await broker.listen();
  const token = await broker.register({ cwd: directory, roots: [directory], writableRoots: [directory], sandboxPolicy: { type: "workspaceWrite", writableRoots: [directory], networkAccess: false }, tools: [
    { name: "exec", description: "Native nested gateway", parameters: {}, freeform: true },
    { namespace: "collaboration", name: "spawn_agent", description: "Start an autonomous model", parameters: {} },
    ...extraTools,
  ] });
  const server = createChatGptMcpServer({ brokerSocketPath: broker.socketPath, ...(blocked ? { blockedToolNamePatterns: WEB_SESSION_BLOCKED_TOOL_PATTERNS, toolArgumentPolicies: WEB_SESSION_TOOL_ARGUMENT_POLICIES } : {}) });
  const client = new Client({ name: "gateway-policy-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try { await server.connect(remote); await client.connect(local); await run(client, broker, token, directory); }
  finally { await client.close(); await server.close(); await broker.close(); await rm(directory, { recursive: true, force: true }); }
}

test("new bridge policy filters direct and gateway inventory before pagination, while original mode remains unchanged", async () => {
  for (const blocked of [false, true]) await withBridge(blocked, async (client, broker, token) => {
    const pending = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, limit: 50 } });
    const [request] = await broker.nextToolBatch(token);
    const executed = await execute(request!.input!, [...blockedNames, "web__run"]);
    broker.completeTool(token, request!.callId, { content: executed.output });
    const result = await pending;
    const inventory = result.structuredContent as { tools: { wire_name: string }[]; total: number };
    const names = inventory.tools.map(tool => tool.wire_name);
    if (blocked) { expect(names).toEqual(["exec", "web__run"]); expect(inventory.total).toBe(2); }
    else { expect(names).toContain("collaboration__spawn_agent"); expect(names).toContain(blockedNames[0]!); }
    expect(executed.calls).toHaveLength(0);
  });
});

test("new bridge policy rejects guessed bridge and autonomous-model names before gateway dispatch", async () => {
  await withBridge(true, async (client, _broker, token) => {
    for (const wire_name of blockedNames) {
      const result = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name, arguments: {} } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("disabled by the current bridge policy");
    }
  });
});

test("raw exec hides blocked entries and rejects computed tool access", async () => {
  await withBridge(true, async (client, broker, token) => {
    const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: "exec", input: `text(ALL_TOOLS.map(tool => tool.name)); text(Object.keys(tools)); try { await tools[${JSON.stringify(blockedNames[0])}]({}); } catch (error) { text(error.message); } await tools.web__run({});` } });
    const [request] = await broker.nextToolBatch(token);
    const executed = await execute(request!.input!, [...blockedNames, "web__run"]);
    expect(executed.calls).toEqual(["web__run"]);
    expect(executed.output[0]!.text).toBe("web__run");
    expect(executed.output[1]!.text).toBe("web__run");
    expect(executed.output[2]!.text).toContain("disabled by the current bridge policy");
    broker.completeTool(token, request!.callId, { content: executed.output });
    expect((await pending).isError).not.toBe(true);
  });
});

test("native registry excludes model-starting tools while retaining commands and browser tools", () => {
  const names = [...blockedNames, "exec", "mcp__cua_repl__js", "web_search"];
  expect(filterNativeTools(names.map(name => ({ name, description: name, parameters: {} }))).map(tool => tool.name)).toEqual(["exec", "mcp__cua_repl__js", "web_search"]);
});

test("administrative tools remain visible while direct and gateway calls distinguish model-starting parameters", async () => {
  for (const direct of [false, true]) await withBridge(true, async (client, broker, token) => {
    const allowed: [string, Record<string, unknown>][] = [
      ["fork_thread", { threadId: "existing" }],
      ["handoff_thread", { threadId: "existing" }],
      ["handoff_thread", { threadId: "existing", followUpPrompt: "" }],
      ["automation_update", { mode: "view", id: "existing" }],
      ["automation_update", { mode: "delete", id: "existing" }],
      ["automation_update", { mode: "update", id: "existing", status: "PAUSED" }],
      ["automation_update", { mode: "create", status: "PAUSED", prompt: "future task" }],
    ];
    for (const [name, args] of allowed) {
      const wire_name = `mcp__codex_app__${name}`;
      const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name, arguments: args } });
      const [request] = await broker.nextToolBatch(token);
      if (direct) { expect(request!.wireName).toBe(wire_name); expect(request!.arguments).toEqual(args); }
      else { const run = await execute(request!.input!, [wire_name]); expect(run.calls).toEqual([wire_name]); }
      broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "administrative operation complete" }] });
      expect((await pending).isError).not.toBe(true);
    }
    for (const [name, args] of [
      ["handoff_thread", { threadId: "existing", followUpPrompt: "continue working" }],
      ["automation_update", { mode: "create", status: "ACTIVE" }],
      ["automation_update", { mode: "update", id: "existing" }],
      ["automation_update", { mode: "update", status: "ACTIVE" }],
    ] as const) {
      const result = await client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: `mcp__codex_app__${name}`, arguments: args } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("invocation is disabled");
    }
  }, direct ? ["fork_thread", "handoff_thread", "automation_update"].map(name => ({ namespace: "mcp__codex_app", name, description: name, parameters: {} })) : []);
});

test("raw exec applies parameter rules without hiding administrative functions", async () => {
  await withBridge(true, async (client, broker, token) => {
    const name = "mcp__codex_app__automation_update";
    const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: "exec", input: `text(ALL_TOOLS.map(tool => tool.name)); await tools.${name}({ mode: "view", id: "x" }); try { await tools.${name}({ mode: "create", status: "ACTIVE" }); } catch (error) { text(error.message); }` } });
    const [request] = await broker.nextToolBatch(token);
    const run = await execute(request!.input!, [name]);
    expect(run.calls).toEqual([name]);
    expect(run.output[0]!.text).toBe(name);
    expect(run.output[1]!.text).toContain("scheduling model runs is disabled");
    broker.completeTool(token, request!.callId, { content: run.output });
    expect((await pending).isError).not.toBe(true);
  });
});

test("inventory pages deduplicate and retain one native snapshot while the registry changes", async () => {
  await withBridge(true, async (client, broker, token, directory) => {
    const page = async (offset: number, names: string[], extra: Record<string, unknown> = {}) => {
      const pending = client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, offset, limit: 2, ...extra } });
      const [request] = await broker.nextToolBatch(token);
      try {
        const { output } = await execute(request!.input!, names);
        await broker.completeTool(token, request!.callId, { content: output });
      } catch (error) {
        await broker.completeTool(token, request!.callId, { isError: true, content: [{ type: "text", text: String(error) }] });
      }
      return await pending;
    };
    const initial = (await page(0, ["exec", "alpha", "nested_a", "nested_a", "nested_b"])).structuredContent;
    expect(initial).toMatchObject({ total: 4, next_offset: 2, tools: [{ wire_name: "exec" }, { wire_name: "alpha" }] });

    broker.updateEnvironment(token, {
      cwd: directory, roots: [directory], writableRoots: [directory], sandboxPolicy: { type: "workspaceWrite", writableRoots: [directory], networkAccess: false },
      tools: [
        { name: "exec", description: "Native gateway", parameters: {}, freeform: true },
        { name: "alpha", description: "Changed alpha", parameters: {} },
        { name: "nested_a", description: "Promoted from the gateway", parameters: {} },
        { name: "direct_new", description: "New outer tool", parameters: {} },
      ],
    });
    const changedNames = ["exec", "alpha", "nested_a", "new_first", "nested_b", "nested_c"];
    expect((await page(2, changedNames)).structuredContent).toMatchObject({ total: 4, next_offset: null, tools: [{ wire_name: "nested_a" }, { wire_name: "nested_b" }] });

    const renewed = (await page(0, changedNames, { limit: 50 })).structuredContent as { total: number; tools: { wire_name: string }[] };
    expect(renewed.total).toBe(7);
    expect(renewed.tools.map(tool => tool.wire_name)).toEqual(["exec", "alpha", "nested_a", "direct_new", "new_first", "nested_b", "nested_c"]);
    expect(new Set(renewed.tools.map(tool => tool.wire_name)).size).toBe(renewed.total);

    // Query and schema modes cannot accidentally continue another traversal.
    for (const extra of [{ query: "nested" }, { include_schema: false }]) {
      const missing = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token, offset: 2, limit: 2, ...extra } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain("restart with offset 0");
    }
    const otherToken = await broker.register({ cwd: directory, roots: [directory], writableRoots: [directory], sandboxPolicy: { type: "workspaceWrite", writableRoots: [directory], networkAccess: false }, tools: [{ name: "exec", description: "Native gateway", parameters: {}, freeform: true }] });
    const isolated = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: otherToken, offset: 2, limit: 2 } });
    expect(isolated.isError).toBe(true);
    expect(JSON.stringify(isolated.content)).toContain("restart with offset 0");
    await page(0, changedNames, { query: " NESTED " });
    expect((await page(2, changedNames, { query: "nested" })).structuredContent).toMatchObject({ total: 3, next_offset: null, tools: [{ wire_name: "nested_c" }] });
    // Native store loss must fail clearly instead of silently switching snapshots.
    nativeStore.clear();
    const expired = await page(2, changedNames, { query: "nested" });
    expect(expired.isError).toBe(true);
    expect(JSON.stringify(expired.content)).toContain("snapshot expired; restart with offset 0");
  }, [
    { name: "alpha", description: "Initial alpha", parameters: {} },
    { name: "alpha", description: "Duplicate alpha", parameters: {} },
  ]);
});
