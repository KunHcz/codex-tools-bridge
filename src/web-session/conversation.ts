import { createHash } from "node:crypto";

/** Correlation only, never an authorization credential. Do not substitute an MCP
 * transport session: several ChatGPT conversations can share that connection.
 * https://developers.openai.com/plugins/reference#_meta-fields-the-client-provides
 */
export function conversationKey(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const session = (meta as Record<string, unknown>)["openai/session"];
  if (session === undefined) return undefined;
  if (typeof session !== "string" || !session.trim() || session.length > 4096) throw new Error("Invalid ChatGPT conversation metadata");
  return createHash("sha256").update(JSON.stringify(["chatgpt-conversation-v1", session])).digest("hex");
}
