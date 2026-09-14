#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION } from "./version";
import { runWebSessionMcp } from "./web-session/mcp";
import { prepareDesktop, readDesktopSetup } from "./setup";
import { readDesktopProviderEndpoint } from "./web-session/desktop-provider";

export const HELP = `codex-tools-bridge ${VERSION} (experimental)

ChatGPT Web owns the conversation. Codex provides the local tools.

  bun src/cli.ts prepare-desktop --workspace ABS --state-dir ABS
      --codex-bin PATH --desktop-provider-registry ABS
  bun src/cli.ts mcp --workspace ABS --state-dir ABS [--codex-bin PATH]
  bun src/cli.ts doctor [--workspace ABS] [--state-dir ABS] [--codex-bin PATH]

Options:
  --tool-access configured|all   Default: configured; all is explicit opt-in.
  --allow-app BUNDLE_ID          Repeatable native macOS app allowlist.
  --section-name NAME            Optional native task sidebar section.
  --help                        Show help without starting a host.
  --version                     Show version without starting a host.

prepare-desktop creates a dedicated native task, not a model turn. Start the
MCP service, then open that task in Desktop once to connect its tool driver.
mcp automatically reads the private desktop.json in --state-dir. Without it,
it uses the advanced standalone mode described in docs/SETUP.md.
Tunnel credentials and lifecycle belong to the official tunnel-client.
`;

const VALUES = new Set(["--workspace", "--state-dir", "--codex-bin", "--desktop-provider-registry", "--tool-access", "--allow-app", "--section-name"]);
export function parseArgs(input: string[]) {
  if (input.length === 0 || input.includes("--help") || input[0] === "help") return { action: "help", values: new Map<string, string[]>() };
  if (input.length === 1 && input[0] === "--version") return { action: "version", values: new Map<string, string[]>() };
  const [action, ...rest] = input;
  if (!["mcp", "doctor", "prepare-desktop"].includes(action!)) throw new Error("Unknown command; use --help");
  const values = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]!, value = rest[i + 1];
    if (!VALUES.has(name) || !value || value.startsWith("--") || /[\r\n\0]/.test(value)) throw new Error(`Invalid option ${name}`);
    if (values.has(name) && name !== "--allow-app") throw new Error(`Duplicate option ${name}`);
    values.set(name, [...values.get(name) ?? [], value]);
  }
  const access = values.get("--tool-access")?.[0];
  if (access && !["configured", "all"].includes(access)) throw new Error("--tool-access must be configured or all");
  for (const id of values.get("--allow-app") ?? []) if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(id)) throw new Error("--allow-app must be a macOS bundle ID");
  for (const name of ["--workspace", "--state-dir", "--desktop-provider-registry"]) {
    const value = values.get(name)?.[0];
    if (value && !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  const section = values.get("--section-name")?.[0];
  if (section != null && (!section.trim() || section.length > 160)) throw new Error("--section-name must contain 1-160 characters");
  return { action: action!, values };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { action, values } = parseArgs(args);
  if (action === "help") { process.stdout.write(HELP); return; }
  if (action === "version") { process.stdout.write(VERSION + "\n"); return; }
  const value = (name: string) => values.get(name)?.[0];
  const workspace = value("--workspace"), stateDir = value("--state-dir");
  const binary = value("--codex-bin") ?? process.env.CODEX_BINARY ?? "codex";
  if (action === "doctor") {
    const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 });
    let native: Record<string, unknown> = {};
    if (workspace && existsSync(workspace)) {
      try {
        const endpoint = await readDesktopProviderEndpoint(workspace);
        if (endpoint) {
          const response = await fetch(`http://127.0.0.1:${endpoint.port}/${endpoint.key}/v1/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
          if (response.ok) {
            const status = await response.json() as Record<string, unknown>;
            native = { native_connected_drivers: status.connectedDriverCount, native_driver_connected: status.toolDriverConnected };
          } else native = { native_driver_connected: false };
        }
      } catch { native = { native_driver_connected: false }; }
    }
    process.stdout.write(JSON.stringify({ version: VERSION, bun: Bun.version, platform: process.platform,
      codex_available: version.status === 0 && !version.error,
      codex_version: version.status === 0 ? version.stdout.trim().slice(0, 160) : null,
      workspace_exists: workspace ? existsSync(workspace) : null,
      desktop_prepared: stateDir ? existsSync(join(stateDir, "desktop.json")) : null,
      ...native, note: "Read-only diagnostics; tunnel readiness is separate. This does not start a task." }, null, 2) + "\n");
    if (version.status !== 0 || version.error) process.exitCode = 1;
    return;
  }
  if (!workspace || !stateDir) throw new Error("--workspace and --state-dir are required absolute paths");
  const workspaceRoot = await realpath(workspace);
  if (action === "prepare-desktop") {
    const registryPath = value("--desktop-provider-registry");
    if (!registryPath) throw new Error("--desktop-provider-registry is required; only its named provider block is modified");
    if (value("--tool-access") || value("--section-name") || values.has("--allow-app")) throw new Error("Permission/sidebar options belong to mcp, not prepare-desktop");
    const setup = await prepareDesktop({ workspaceRoot, stateDir: resolve(stateDir), codexBinary: binary, registryPath });
    process.stdout.write(JSON.stringify({ thread_id: setup.threadId, title: setup.title,
      next: "Start the MCP service through your tunnel profile, then open this dedicated task in Desktop and send: Start the configured local tool driver; wait for web tool requests. Keep its codex_web_sessions provider; do not select another provider." }, null, 2) + "\n");
    return;
  }
  if (value("--desktop-provider-registry")) throw new Error("Set the registry during prepare-desktop, not mcp");
  const setup = await readDesktopSetup(resolve(stateDir));
  if (setup && setup.workspaceRoot !== workspaceRoot) throw new Error("Desktop setup belongs to a different workspace");
  if (setup && value("--codex-bin") && value("--codex-bin") !== setup.codexBinary) throw new Error("Desktop runtime must use the Codex binary recorded during setup");
  await runWebSessionMcp({ stateDir: resolve(stateDir), workspaceRoot,
    codexBinary: setup?.codexBinary ?? binary, toolAccess: value("--tool-access") as "configured" | "all" | undefined,
    allowedApps: values.get("--allow-app"), sidebarSection: value("--section-name"),
    desktopThreadId: setup?.threadId, desktopProviderRegistry: setup?.registryPath });
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Command failed"); process.exitCode = 1; });
