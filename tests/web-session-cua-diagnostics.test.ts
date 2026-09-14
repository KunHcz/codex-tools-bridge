import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { diagnoseCuaResult, parseMacLockState } from "../src/web-session/cua-diagnostics";

const wire = "mcp__cua_repl__js";
test("recognizes the host physical-input pause without guessing its source or probing recovery", async () => {
  const native: CallToolResult = { content: [{ type: "text", text: "The Mac is locked and automatic unlock is paused because physical input was detected. Ask the user to unlock the Mac manually before continuing." }], structuredContent: { native: true } };
  const result = await diagnoseCuaResult(wire, native, async () => { throw new Error("must not probe"); });
  expect(result.isError).toBe(true);
  expect(result.content[0]).toEqual(native.content[0]);
  expect(result.structuredContent).toBe(native.structuredContent);
  const detail = JSON.parse((result.content.at(-1) as any).text);
  expect(detail.web_session_diagnostic).toBe("cua_automatic_unlock_paused");
  expect(detail.retryable).toBe(false);
  expect(detail.recovery).toBe("manual_unlock_required_by_desktop_host");
  const ax: CallToolResult = { content: [{ type: "text", text: "Window: Chrome\n" + (native.content[0] as any).text }] };
  expect(await diagnoseCuaResult(wire, ax)).toBe(ax);
});
const error: CallToolResult = { isError: false, content: [
  { type: "text", text: "Wall time: 0.2573 seconds\nOutput:" },
  { type: "text", text: "Computer Use server error -10005: cgWindowNotFound" },
  { type: "text", text: "## Computer Use\nOriginal documentation" },
], structuredContent: { session_id: "native-owned" } };

test("marks the actual CUA window failure and reports observed lock state without losing native output", async () => {
  let reads = 0;
  const result = await diagnoseCuaResult(wire, error, async () => { reads++; return true; });
  expect(reads).toBe(1);
  expect(result.isError).toBe(true);
  expect(result.content.slice(0, 3)).toEqual(error.content);
  expect(result.structuredContent).toBe(error.structuredContent);
  expect(JSON.stringify(result.content.at(-1))).toContain('mac_locked_observed_after_failure');
  expect(JSON.stringify(result.content.at(-1))).toContain('does not mean Locked use is disabled');
  expect(JSON.stringify(result.content.at(-1))).not.toContain('Ask the user to unlock');
  expect(error.isError).toBe(false);
});

test("unlocked and unavailable lock observations do not diagnose a locked Mac", async () => {
  for (const read of [async () => false, async () => null, async () => { throw new Error("unavailable"); }]) {
    const result = await diagnoseCuaResult(wire, error, read);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content.at(-1))).not.toContain('unlock it manually');
    expect(JSON.stringify(result.content.at(-1))).toContain('window lookup failed');
  }
});

test("leaves success, other tools, documents and AX trees unchanged and never checks lock state", async () => {
  for (const [name, result] of [
    ["exec_command", error],
    [wire, { content: [{ type: "text", text: "Window: Chrome\nText: Computer Use server error -10005: cgWindowNotFound" }] }],
    [wire, { content: [{ type: "text", text: "Documentation: cgWindowNotFound" }] }],
    [wire, { content: [{ type: "image", data: "pixel", mimeType: "image/png" }] }],
  ] as [string, CallToolResult][]) {
    expect(await diagnoseCuaResult(name, result, async () => { throw new Error("must not be called"); })).toBe(result);
  }
});

test("parses macOS console flags and preserves unknown state", () => {
  expect(parseMacLockState('"IOConsoleLocked" = Yes')).toBe(true);
  expect(parseMacLockState('"IOConsoleLocked" = No')).toBe(false);
  expect(parseMacLockState('"IOConsoleLocked" = true')).toBe(true);
  expect(parseMacLockState('"IOConsoleLocked" = false')).toBe(false);
  expect(parseMacLockState('"other" = No')).toBeNull();
});
