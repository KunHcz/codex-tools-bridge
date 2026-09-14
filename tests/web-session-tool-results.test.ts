import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { brokerResult } from "../src/adapters/chatgpt-web/tool-events";
import { createChatGptMcpServer, execGatewayResultProgram, gatewayToolCatalogPage } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function parseNativeOutput(output: unknown, custom = true) {
  const parsed = parseRequest({
    model: "chatgpt-web/luna",
    input: [
      custom
        ? { type: "custom_tool_call", call_id: "call_test", name: "exec", input: "fake" }
        : { type: "function_call", call_id: "call_test", name: "test", arguments: "{}" },
      { type: custom ? "custom_tool_call_output" : "function_call_output", call_id: "call_test", output },
    ],
  });
  const message = parsed.context.messages.find(item => item.role === "toolResult");
  if (!message || message.role !== "toolResult") throw new Error("Tool output was not parsed");
  return message;
}

async function gatewayOutput(result: unknown, banner = false) {
  const output: Record<string, unknown>[] = [];
  const media = (type: "input_image" | "input_audio", value: Record<string, unknown>) => {
    output.push({ type, [type === "input_image" ? "image_url" : "audio_url"]: `data:${value.mimeType};base64,${value.data}`,
      ...(type === "input_image" && (value._meta as Record<string, unknown> | undefined)?.["codex/imageDetail"]
        ? { detail: (value._meta as Record<string, unknown>)["codex/imageDetail"] } : {}) });
  };
  await new AsyncFunction("text", "image", "audio", "generatedImage", execGatewayResultProgram([
    `const result = ${JSON.stringify(result)};`,
  ]))(
    (value: unknown) => output.push({ type: "input_text", text: `${banner ? "Script completed\nWall time 0.1 seconds\nOutput:\n" : ""}${typeof value === "string" ? value : JSON.stringify(value)}` }),
    (value: Record<string, unknown>) => media("input_image", value),
    (value: Record<string, unknown>) => media("input_audio", value),
    () => { throw new Error("Unexpected generated image"); },
  );
  return output;
}

test("gateway MCP results survive native Responses with errors, metadata, resources, images and audio", async () => {
  const result = {
    content: [
      { type: "text", text: "Partial output", annotations: { audience: ["user"] } },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png", _meta: { "codex/imageDetail": "original", provenance: "fixture" } },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav", annotations: { priority: 0.8 } },
      { type: "resource_link", uri: "https://example.test/report", name: "Report", mimeType: "text/plain", size: 18 },
      { type: "resource", resource: { uri: "test://embedded", mimeType: "text/plain", text: "Embedded text" }, _meta: { origin: "fixture" } },
      { type: "resource", resource: { uri: "test://binary", mimeType: "application/octet-stream", blob: "YmluYXJ5" } },
    ],
    structuredContent: { session_id: "original-session", ok: false, count: 2 },
    isError: true,
    _meta: { private: { value: "preserved" } },
  };
  const native = await gatewayOutput(result, true);
  // Binary media must use native multimodal blocks, never duplicate large base64 in text.
  const text = native.filter(item => item.type === "input_text").map(item => item.text).join("\n");
  expect(text).not.toContain("aW1hZ2U=");
  expect(text).not.toContain("YXVkaW8=");
  expect(native.map(item => item.type)).toEqual(["input_image", "input_audio", "input_text"]);
  expect(brokerResult(parseNativeOutput(native))).toEqual(result);
});

test("empty MCP errors and explicit false remain distinct from an absent error flag", async () => {
  for (const result of [{ content: [], isError: true, _meta: { reason: "no access" } }, { content: [], isError: false }, { content: [] }]) {
    expect(brokerResult(parseNativeOutput(await gatewayOutput(result)))).toEqual(result);
  }
});

test("both native function and custom outputs preserve audio and original image detail", () => {
  const output = [
    { type: "input_audio", audio_url: "data:audio/mpeg;base64,YXVkaW8=" },
    { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "original" },
    { type: "input_text", text: "Done" },
  ];
  for (const custom of [false, true]) {
    const parsed = parseNativeOutput(output, custom);
    expect(parsed.nativeOutput).toEqual(output);
    expect(brokerResult(parsed)).toEqual({ content: [
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png", _meta: { "codex/imageDetail": "original" } },
      { type: "text", text: "Done" },
    ] });
  }
});

test("standalone MCP resources retain their original block types", async () => {
  for (const resource of [
    { type: "resource_link", uri: "test://report", name: "report" },
    { type: "resource", resource: { uri: "test://report", text: "report" } },
  ]) expect(brokerResult(parseNativeOutput(await gatewayOutput(resource)))).toEqual({ content: [resource] });
});

test("gateway decoding fails explicitly when native media are missing or envelopes are ambiguous", async () => {
  const native = await gatewayOutput({ content: [{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" }] });
  const envelopeOnly = native.filter(item => item.type === "input_text");
  const missing = brokerResult(parseNativeOutput(envelopeOnly));
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.content)).toContain("media was not returned");
  expect(missing.content.some((item: unknown) => (item as { type: string }).type === "audio")).toBe(false);
  const ambiguous = brokerResult(parseNativeOutput([{ type: "input_text", text: `Output:\n${envelopeOnly[0]!.text}\n${envelopeOnly[0]!.text}` }]));
  expect(ambiguous.isError).toBe(true);
  expect(JSON.stringify(ambiguous.content)).toContain("ambiguous");
});

test("ordinary outputs and unavailable native MCP metadata are not manufactured", () => {
  expect(brokerResult(parseNativeOutput("Plain native text"))).toEqual({ content: [{ type: "text", text: "Plain native text" }] });
  expect(brokerResult(parseNativeOutput([{ type: "input_text", text: "Native output without MCP metadata" }]))).not.toHaveProperty("_meta");
  expect(brokerResult(parseNativeOutput([{ type: "input_audio", audio_url: "https://example.test/audio.wav" }]))).toEqual({ content: [
    { type: "resource_link", uri: "https://example.test/audio.wav", name: "Codex tool audio", mimeType: "audio/*" },
  ] });
});

test("the final MCP client receives the preserved result through the original broker transport", async () => {
  const directory = await mkdtemp("/tmp/web-result-test-");
  const broker = TurnBroker.forSocket(join(directory, "broker.sock"));
  const server = createChatGptMcpServer({ brokerSocketPath: broker.socketPath });
  const client = new Client({ name: "tool-result-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await broker.listen();
    const token = await broker.register({
      cwd: directory, roots: [directory], writableRoots: [directory],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [directory], networkAccess: false },
      tools: [{ name: "example", description: "fake tool", parameters: {} }],
    });
    await server.connect(remote);
    await client.connect(local);
    const result = {
      content: [
        { type: "text", text: "Preserved" },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "test://report", text: "Report" } },
      ],
      structuredContent: { session_id: "original-session", value: 42 },
      isError: false,
      _meta: { example: "preserved" },
    } satisfies CallToolResult;
    const pending = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: "example", arguments: {} } });
    const [request] = await broker.nextToolBatch(token);
    await broker.completeTool(token, request!.callId, brokerResult(parseNativeOutput(await gatewayOutput(result))));
    expect(await pending).toEqual(result);
  } finally {
    await client.close();
    await server.close();
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog rejection identifies the descriptor and reason without exposing descriptions", () => {
  for (const [tool, excluded, blocked, reason] of [
    [{ name: "tool", description: null }, [], [], "description type object"],
    [{ name: "tool", description: "private description" }, ["tool"], [], "duplicate outer tool"],
    [{ name: "tool", description: "private description" }, [], ["^tool$"], "blocked tool"],
    [{ name: "invalid.name", description: "private description" }, [], [], "invalid name syntax"],
  ] as const) {
    const check = () => gatewayToolCatalogPage({ content: [{ type: "text", text: JSON.stringify({ tools: [tool], total: 1 }) }] }, new Set<string>(excluded), blocked);
    expect(check).toThrow(`index 0: ${JSON.stringify(tool.name)} (${reason})`);
    try { check(); } catch (error) { expect(String(error)).not.toContain("private description"); }
  }
});
