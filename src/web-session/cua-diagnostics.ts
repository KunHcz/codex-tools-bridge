import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const exec = promisify(execFile);

export function parseMacLockState(output: string): boolean | null {
  const match = /"IOConsoleLocked"\s*=\s*(Yes|No|true|false)\b/.exec(output);
  return match ? ["Yes", "true"].includes(match[1]!) : null;
}

/** Read only the console lock flag. Never unlock, change settings, or log ioreg output. */
async function macLockState(): Promise<boolean | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await exec("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"], { timeout: 2_000, maxBuffer: 1_048_576 });
    return parseMacLockState(stdout);
  } catch { return null; }
}

/** Native Responses may preserve CUA's error text without its MCP isError flag.
 * Recognize standalone runtime errors only, not error words inside an AX tree,
 * source file, or returned documentation. Keep every original block intact.
 */
export async function diagnoseCuaResult(
  wireName: string,
  native: CallToolResult,
  readLockState: () => Promise<boolean | null> = macLockState,
): Promise<CallToolResult> {
  if (!/(?:^|[._])cua_repl(?:__|\.)js$/.test(wireName)) return native;
  const paused = native.content.some(part => part.type === "text" && /^The Mac is locked and automatic unlock is paused because physical input was detected\.\s*(?:Ask the user to unlock the Mac manually before continuing\.)?\s*$/.test(part.text.trim()));
  if (paused) return { ...native, isError: true, content: [...native.content, { type: "text", text: JSON.stringify({
    web_session_diagnostic: "cua_automatic_unlock_paused",
    retryable: false,
    recovery: "manual_unlock_required_by_desktop_host",
    message: "The official desktop host reports its physical-input safeguard paused automatic unlock. Always allow app access does not clear this pause. Stop Computer Use requests until the user manually unlocks; do not restart the service, create another task, or use another input path to bypass the pause. This does not prove which device or event triggered detection, nor that the bridge or permissions are broken.",
  }) }] };
  const failure = native.content.find(part => part.type === "text" && (
    /^Computer Use server error -?\d+: (?:cgWindowNotFound|noWindowsAvailable)\s*$/.test(part.text.trim())
    || /^The Mac is locked and automatic unlock could not unlock it\./.test(part.text.trim())
  ));
  if (!failure) return native;
  let locked: boolean | null = null;
  try { locked = await readLockState(); } catch { /* A failed diagnostic is not evidence of an unlocked Mac. */ }
  const message = locked === true
    ? "The Mac console was locked when this native CUA call failed. This observation does not mean Locked use is disabled or that manual unlock is always required. Check the actual execution host and native error; this observation alone cannot identify an integration failure. Do not ask the user to repeatedly change an already-enabled setting or keep retrying window actions. Manual unlock is only a temporary workaround, not a repair."
    : "The native CUA window lookup failed. Inspect the app's current window state before retrying. An unlocked console alone does not prove that the target window is usable.";
  return { ...native, isError: true, content: [...native.content, { type: "text", text: JSON.stringify({
    web_session_diagnostic: "cua_window_unavailable",
    mac_locked_observed_after_failure: locked,
    message,
    note: "get_app_state is internal to cua.getApp/getAXState, not a missing public tool. No action was automatically retried. The lock observation does not prove the cause of earlier failures.",
  }) }] };
}
