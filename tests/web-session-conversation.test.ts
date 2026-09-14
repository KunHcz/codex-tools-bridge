import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSessionRuntime } from "../src/web-session/sessions";
import { createWebSessionMcp } from "../src/web-session/mcp";
import { conversationKey } from "../src/web-session/conversation";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "web-conversations-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workspace"));
  let starts = 0;
  const appServer = {
    async start() {}, async close() {}, onNotification() { return () => {}; },
    async request<T>(method: string): Promise<T> { if (method === "thread/start") { starts++; return { thread: { id: crypto.randomUUID() } } as T; } return {} as T; },
  };
  const options = { stateDir: join(root, "state"), workspaceRoot: join(root, "workspace"), appServer };
  const runtime = new WebSessionRuntime(options); cleanup.push(() => runtime.close());
  const server = createWebSessionMcp(runtime); cleanup.push(() => server.close());
  const client = new Client({ name: "test", version: "1" }); cleanup.push(() => client.close());
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const call = (name: string, args = {}, chat?: string) => client.callTool({ name, arguments: args, ...(chat ? { _meta: { "openai/session": chat } } : {}) });
  return { runtime, options, root, call, starts: () => starts };
}
test("30 conversations share a transport, route file calls without handles and persist across restart", async () => {
  const { runtime, options, root, call, starts } = await setup();
  const chats = Array.from({ length: 30 }, (_, i) => `chat-${i}`);
  await Promise.all(chats.map(chat => call("web_write_file", { path: `${chat}.txt`, content: chat, expected_sha256: "" }, chat)));
  const opened = await Promise.all(chats.map(chat => call("web_session_info", {}, chat)));
  const ids = opened.map(r => (r.structuredContent as any).result.session_id);
  expect(new Set(ids).size).toBe(30); expect(starts()).toBe(30);
  for (const [i, chat] of chats.entries()) {
    expect((await call("web_write_file", { path: `${i}.txt`, content: chat, expected_sha256: "" }, chat)).isError).not.toBe(true);
    expect((await call("web_read_file", { path: `${i}.txt` }, chat)).structuredContent).toMatchObject({ result: { content: chat } });
    expect((await call("web_session_info", {}, chat)).structuredContent).toMatchObject({ result: { session_id: ids[i] } });
  }
  expect(starts()).toBe(30);
  expect(await readFile(join(root, "state/sessions.json"), "utf8")).not.toContain('"chat-');
  await runtime.close();
  const restored = new WebSessionRuntime(options); cleanup.push(() => restored.close());
  for (const [i, chat] of chats.entries()) expect((await restored.open({ conversationKey: conversationKey({ "openai/session": chat }) })).sessionId).toBe(ids[i]);
  expect(starts()).toBe(30);
});
test("reject cross-chat handles; migrate legacy mapping once", async () => {
  const { call } = await setup();
  const legacy = await call("web_open_session", { request_key: "legacy-chat-one" });
  const id = (legacy.structuredContent as any).result.session_id;
  expect((await call("web_open_session", { session_id: id }, "chat-one")).isError).not.toBe(true);
  expect((await call("web_session_info", {}, "chat-one")).structuredContent).toMatchObject({ result: { session_id: id } });
  expect((await call("web_read_file", { session_id: id, path: "x" }, "chat-two")).isError).toBe(true);
  expect((await call("web_open_session", { request_key: "legacy-chat-one" }, "chat-two")).isError).toBe(true);
});
test("missing metadata never defaults to shared transport identity", async () => {
  const { call, starts } = await setup();
  const missing = await call("web_session_info");
  expect(missing.isError).not.toBe(true); expect(starts()).toBe(0);
  expect(missing.structuredContent).toMatchObject({ result: { connected: false } });
  const [a, b] = await Promise.all([call("web_open_session", { request_key: "fallback-once" }), call("web_open_session", { request_key: "fallback-once" })]);
  expect(a.structuredContent).toEqual(b.structuredContent); expect(starts()).toBe(1);
  expect(conversationKey({ "openai/subject": "same-user", sessionId: "shared-transport" })).toBeUndefined();
  expect(() => conversationKey({ "openai/session": "" })).toThrow();
});

test("background discovery and status probes never allocate; real work still auto-connects", async () => {
  const { runtime, root, call, starts } = await setup();
  let discoveries = 0;
  runtime.discovery = async () => { discoveries++; return { content: [], structuredContent: { tools: [] } }; };
  for (let i = 0; i < 30; i++) {
    const chat = `probe-${i}`;
    expect((await call("codex_tool_inventory", {}, chat)).structuredContent).toMatchObject({ discovery: { execution_session_created: false } });
    expect((await call("web_session_info", {}, chat)).structuredContent).toMatchObject({ result: { connected: false } });
  }
  expect(discoveries).toBe(30);
  expect(starts()).toBe(0);
  expect((await call("web_write_file", { path: "actual.txt", content: "actual work", expected_sha256: "" }, "probe-0")).isError).not.toBe(true);
  expect(starts()).toBe(1);
  const before = (await call("web_session_info", {}, "probe-0")).structuredContent;
  await call("codex_tool_inventory", {}, "probe-0");
  expect((await call("web_session_info", {}, "probe-0")).structuredContent).toEqual(before);
  expect(starts()).toBe(1);
  const audit = await readFile(join(root, "state/requests.jsonl"), "utf8");
  expect(audit).toContain('"operation":"codex_tool_inventory"');
  expect(audit).toContain('"operation":"web_write_file"');
  expect(audit).toContain('"clientName":"test"');
  expect(audit).not.toContain('probe-0');
});
test("offline discovery fails without creating a fallback task", async () => {
  const { call, starts } = await setup();
  const result = await call("codex_tool_inventory", {}, "offline-probe");
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("no local task was created or started");
  expect(starts()).toBe(0);
});
