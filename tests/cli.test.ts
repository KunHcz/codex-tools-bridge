import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("public CLI", () => {
  test("help/version are side-effect-free parsing paths", () => {
    expect(parseArgs([]).action).toBe("help");
    expect(parseArgs(["--help"]).action).toBe("help");
    expect(parseArgs(["--version"]).action).toBe("version");
  });
  test("accepts explicit configuration and repeated application grants", () => {
    const result = parseArgs(["mcp", "--workspace", "/tmp/project", "--state-dir", "/tmp/state", "--allow-app", "com.example.Editor", "--allow-app", "com.example.Browser"]);
    expect(result.values.get("--allow-app")).toEqual(["com.example.Editor", "com.example.Browser"]);
    expect(result.values.has("--tool-access")).toBe(false);
  });
  for (const args of [
    ["connect"], ["mcp", "--token", "secret"], ["mcp", "--workspace", "relative"],
    ["mcp", "--workspace", "/tmp/a", "--workspace", "/tmp/b"],
    ["mcp", "--tool-access", "unsafe"], ["mcp", "--state-dir"],
    ["mcp", "--allow-app", "bad;value"], ["mcp", "--codex-bin", "bad\nvalue"],
  ]) test("rejects malformed arguments: " + args.join(" "), () => expect(() => parseArgs(args)).toThrow());
});
