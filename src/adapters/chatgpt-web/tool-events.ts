import type { AdapterEvent, CodexContentPart, CodexToolResultMessage, CodexUsage } from "../../types";
import { parseDataUrl } from "../image";
import type { BrokerToolRequest, BrokerToolResult } from "./turn-broker";

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function nativeBrokerContent(output: unknown[]): unknown[] {
  return output.flatMap<unknown>(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    if (["input_text", "text", "output_text"].includes(String(item.type)) && typeof item.text === "string") return [{ type: "text", text: item.text }];
    if (item.type === "refusal" && typeof item.refusal === "string") return [{ type: "text", text: `[refusal: ${item.refusal}]` }];
    if (item.type === "encrypted_content") return [{ type: "text", text: "[encrypted content omitted]" }];
    if (item.type !== "input_image" && item.type !== "input_audio") return [];
    const isImage = item.type === "input_image";
    const url = isImage ? item.image_url : item.audio_url;
    if (typeof url !== "string") return [];
    const parsed = parseDataUrl(url);
    if (!parsed) return [{ type: "resource_link", uri: url, name: isImage ? "Codex tool image" : "Codex tool audio", mimeType: isImage ? "image/*" : "audio/*" }];
    return [{ type: isImage ? "image" : "audio", data: parsed.base64, mimeType: parsed.mediaType,
      ...(isImage && typeof item.detail === "string" ? { _meta: { "codex/imageDetail": item.detail } } : {}) }];
  });
}

function gatewayEnvelope(content: unknown[]): BrokerToolResult | undefined {
  const media = content.filter(raw => raw && typeof raw === "object" && ["image", "audio", "resource_link"].includes(String((raw as Record<string, unknown>).type)));
  const envelopes: Record<string, unknown>[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).type !== "text") continue;
    const value = (raw as Record<string, unknown>).text;
    if (typeof value !== "string") continue;
    // Native exec can prefix timing/status lines to its text() output.
    const blocks = [value, ...value.split("\n")];
    for (const block of blocks) {
      let parsed: unknown;
      try { parsed = JSON.parse(block); } catch { continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const envelope = (parsed as Record<string, unknown>).__codex_gateway_result_v1;
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) continue;
      envelopes.push(envelope as Record<string, unknown>);
      // If the full block is an envelope, don't count its single line twice.
      if (block === value) break;
    }
  }
  if (!envelopes.length) return undefined;
  if (envelopes.length !== 1 || !Array.isArray(envelopes[0]!.content)) return {
    isError: true, content: [{ type: "text", text: "Native gateway returned an invalid or ambiguous result envelope." }],
  };
  const envelope = envelopes[0]!;
  const restored: unknown[] = [];
  for (const raw of envelope.content as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { isError: true, content: [{ type: "text", text: "Native gateway returned an invalid content block." }] };
    const part = raw as Record<string, unknown>;
    if (part.__codex_native_media_index === undefined) { restored.push(part); continue; }
    const index = part.__codex_native_media_index;
    const source = Number.isSafeInteger(index) && (index as number) >= 0 ? media[index as number] as Record<string, unknown> | undefined : undefined;
    if (!source || (source.type !== part.type && source.type !== "resource_link")) return {
      isError: true, content: [{ type: "text", text: "Native gateway media was not returned by Codex; refusing to invent an image or audio payload." }],
    };
    const { __codex_native_media_index: _, ...metadata } = part;
    restored.push(source.type === "resource_link" ? source : { ...metadata, ...source,
      ...(metadata._meta && typeof metadata._meta === "object" ? { _meta: { ...(source._meta as object ?? {}), ...metadata._meta } } : {}) });
  }
  return { content: restored,
    ...(typeof envelope.isError === "boolean" ? { isError: envelope.isError } : {}),
    ...(envelope.structuredContent !== undefined ? { structuredContent: envelope.structuredContent } : {}),
    ...(envelope._meta !== undefined ? { _meta: envelope._meta } : {}) };
}

export function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = message.nativeOutput ? nativeBrokerContent(message.nativeOutput) : brokerContent(message.content);
  const envelope = gatewayEnvelope(content);
  if (envelope) return envelope;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

export function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}
