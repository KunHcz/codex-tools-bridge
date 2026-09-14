import { describe, expect, test } from "bun:test";
import { buildToolCatalog, filterNativeTools, filterToolCatalog, resolveTool, type McpCatalogTool } from "../src/web-session/tool-catalog";
import type { CodexTool } from "../src/types";

const tool = (name: string, description = ""): McpCatalogTool => ({ name, description, inputSchema: { type: "object" } });

describe("MCP tool catalog", () => {
  test("filters native recursion without hiding exec, freeform, discovery, or other apps", () => {
    const native = (name: string, namespace?: string): CodexTool => ({ name, namespace, description: name, parameters: { type: "object" } });
    const exec = native("exec");
    const freeform = { ...native("apply_patch"), freeform: true };
    const discovery = { ...native("tool_search"), toolSearch: true };
    const otherApp = native("drive.search", "mcp__codex_apps");
    const browser = native("js", "mcp__cua_repl");
    const webSearch = native("web_search");
    const input = [exec, freeform, discovery, otherApp, browser, webSearch,
      native("codex_tool_call"), native("web_open_session"),
      native("codex_tool_inventory", "mcp__renamed_bridge"), native("helper", "mcp__renamed_bridge"),
      native("other_tool", "mcp__codex-web-sessions"),
      native("codex_web_sessions.web_read_file", "mcp__codex_apps"),
      native("old_bridge.codex_exec", "mcp__codex_apps"),
      native("mcp__codex_apps__codex_web_sessions.web_view_image"),
      native("codex.control.turn_complete"),
    ];
    expect(filterNativeTools(input)).toEqual([exec, freeform, discovery, otherApp, browser, webSearch]);
    expect(filterNativeTools(input)[0]).toBe(exec);
    expect(input).toHaveLength(15);
  });

  test("keeps task inspection, copying and conditional administrative tools discoverable", () => {
    const names = ["list_threads", "read_thread", "wait_threads", "fork_thread", "handoff_thread", "automation_update", "get_usage_limits"];
    const input = names.map(name => ({ name, namespace: "mcp__codex_app", description: name, parameters: { type: "object" } }));
    expect(filterNativeTools(input)).toEqual(input);
  });

  test("filters bridge servers and recursive app entries without hiding unrelated apps", () => {
    const catalog = buildToolCatalog([
      { name: "codex-web-sessions", tools: { web_open_session: tool("web_open_session") } },
      { name: "renamed_bridge", tools: { codex_tool_call: tool("codex_tool_call"), helper: tool("helper") } },
      { name: "codex_apps", tools: {
        "codex_web_sessions.web_read_file": tool("codex_web_sessions.web_read_file"),
        "legacy.codex_tool_call": tool("legacy.codex_tool_call"),
        "drive.search": tool("drive.search"),
      } },
      { name: "cua_repl", tools: { js: tool("js") } },
    ]);
    expect(catalog.map(entry => entry.wire_name)).toEqual(["mcp__codex_apps__drive.search", "mcp__cua_repl__js"]);
    expect(() => resolveTool(catalog, "mcp__codex_apps__codex_web_sessions.web_read_file")).toThrow("not available");
  });

  test("detects flattened-name collisions and does not guess a route", () => {
    expect(() => buildToolCatalog([
      { name: "a__b", tools: { c: tool("c") } },
      { name: "a", tools: { b__c: tool("b__c") } },
    ])).toThrow("Ambiguous MCP tool wire name");
    const catalog = buildToolCatalog([{ name: "browser", tools: { "tab.click": tool("tab.click") } }]);
    expect(resolveTool(catalog, "mcp__browser__tab.click")).toMatchObject({ server_name: "browser", name: "tab.click" });
    expect(() => resolveTool(catalog, "mcp__browser__tab__click")).toThrow("not available");
    expect(() => resolveTool([...catalog, ...catalog], catalog[0]!.wire_name)).toThrow("Ambiguous");
  });

  test("preserves real schemas and annotations, searches before stable pagination", () => {
    const inputSchema = { type: "object", properties: { path: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["path"], additionalProperties: false };
    const annotations = { readOnlyHint: true, idempotentHint: false, custom: "preserved" };
    const outputSchema = { type: "array", items: { type: "string" } };
    const catalog = buildToolCatalog([{ name: "files", tools: {
      z: tool("z", "Search item z"),
      a: { ...tool("a", "Search item a"), inputSchema, outputSchema, annotations },
      omitted: undefined,
      x: tool("x", "unrelated"),
    } }]);
    const first = filterToolCatalog(catalog, { query: "  SEARCH ITEM ", limit: 1 });
    expect(first).toMatchObject({ total: 2, next_offset: 1 });
    expect(first.tools[0]).toMatchObject({ name: "a", inputSchema, parameters: inputSchema, annotations, outputSchema });
    const second = filterToolCatalog(catalog, { query: "Search item", offset: 1, limit: 1, includeSchema: false });
    expect(second).toMatchObject({ total: 2, next_offset: null });
    expect(second.tools[0]!.name).toBe("z");
    expect(second.tools[0]).not.toHaveProperty("inputSchema");
    expect(second.tools[0]).not.toHaveProperty("parameters");
    expect(filterToolCatalog(catalog, { offset: 10 })).toEqual({ tools: [], total: 3, next_offset: null });
    expect(filterToolCatalog(catalog, { query: "not found" })).toEqual({ tools: [], total: 0, next_offset: null });
  });

  test("rejects invalid page inputs instead of yielding misleading cursors", () => {
    expect(() => filterToolCatalog([], { limit: 0 })).toThrow("limit");
    expect(() => filterToolCatalog([], { limit: 51 })).toThrow("limit");
    expect(() => filterToolCatalog([], { offset: -1 })).toThrow("offset");
    expect(() => filterToolCatalog([], { offset: 0.5 })).toThrow("offset");
  });
});
