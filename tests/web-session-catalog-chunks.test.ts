import { expect, test } from "bun:test";
import { gatewayToolCatalogProgram, GATEWAY_CATALOG_CHUNK_CHARS, readGatewayToolCatalog } from "../src/adapters/chatgpt-web/mcp-server";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const longDescription = '完整工具说明。Arguments schema: {"type":"object","properties":{"path":{"type":"string"}}}\n'.repeat(600);
const registry = [
  { name: "example_one", description: longDescription },
  { name: "example_two", description: `${longDescription}END OF FULL DESCRIPTION` },
];

function nativeTransport(snapshotId: string, mutate?: (envelope: Record<string, any>, offset: number) => void) {
  const store = new Map<string, unknown>();
  const emittedSizes: number[] = [];
  const offsets: number[] = [];
  const fetch = async (offset: number) => {
    offsets.push(offset);
    const program = gatewayToolCatalogProgram({ offset: 0, limit: 50, excludedNames: [], snapshotId, refreshSnapshot: offset === 0, chunkOffset: offset });
    expect(program.startsWith('// @exec: {"max_output_tokens": 20000}')).toBe(true);
    const output: { type: "text"; text: string }[] = [];
    await new AsyncFunction("ALL_TOOLS", "store", "load", "text", program)(
      offset === 0 ? registry : [{ name: "changed_during_transfer", description: "Not in this snapshot" }],
      (key: string, value: unknown) => store.set(key, structuredClone(value)),
      (key: string) => structuredClone(store.get(key)),
      (text: string) => {
        const envelope = JSON.parse(text);
        mutate?.(envelope, offset);
        const serialized = JSON.stringify(envelope);
        emittedSizes.push(serialized.length);
        output.push({ type: "text", text: `Script completed\nOutput:\n${serialized}` });
      },
    );
    return { content: output };
  };
  return { fetch, offsets, emittedSizes };
}

test("large gateway catalogs cross native output limits in small verified chunks without shortening descriptions", async () => {
  const native = nativeTransport("long_catalog");
  const result = await readGatewayToolCatalog(native.fetch, "long_catalog:0:50", new Set());
  expect(result).toEqual({ tools: registry, total: registry.length });
  expect(native.offsets.length).toBeGreaterThan(3);
  expect(native.offsets).toEqual(native.offsets.map((_, index) => index * GATEWAY_CATALOG_CHUNK_CHARS));
  expect(Math.max(...native.emittedSizes)).toBeLessThan(GATEWAY_CATALOG_CHUNK_CHARS * 2 + 500);
  expect(result.tools[1]!.description.endsWith("END OF FULL DESCRIPTION")).toBe(true);
});

test("changed chunk identity, offsets, lengths and data reject the entire catalog", async () => {
  const changes = [
    (chunk: Record<string, any>) => { chunk.id = "different_page"; },
    (chunk: Record<string, any>) => { chunk.offset += 1; },
    (chunk: Record<string, any>) => { chunk.total_chars += 1; },
    (chunk: Record<string, any>) => { chunk.data = `${chunk.data.slice(0, 50)}…17002 tokens truncated…${chunk.data.slice(60)}`; },
    (chunk: Record<string, any>) => { chunk.data = `X${chunk.data.slice(1)}`; },
    (chunk: Record<string, any>) => { chunk.data = ""; },
  ];
  for (const change of changes) {
    const native = nativeTransport("damaged_catalog", (envelope, offset) => { if (offset === GATEWAY_CATALOG_CHUNK_CHARS) change(envelope.__codex_catalog_chunk_v1); });
    await expect(readGatewayToolCatalog(native.fetch, "damaged_catalog:0:50", new Set())).rejects.toThrow("no partial catalog was returned");
    expect(native.offsets.length).toBeGreaterThanOrEqual(2);
  }
});

test("missing, ambiguous and native-error chunks never return partial tool lists", async () => {
  for (const kind of ["truncated", "ambiguous", "error"] as const) {
    const native = nativeTransport("missing_catalog");
    await expect(readGatewayToolCatalog(async offset => {
      const result = await native.fetch(offset);
      if (offset === 0) return result;
      if (kind === "error") return { content: [{ type: "text", text: "Native tool failed" }], isError: true };
      if (kind === "ambiguous") return { content: [result.content[0]!, result.content[0]!] };
      return { content: [{ type: "text", text: result.content[0]!.text.slice(0, -100) }] };
    }, "missing_catalog:0:50", new Set())).rejects.toThrow(kind === "error" ? "Native tool failed" : "no partial catalog was returned");
    expect(native.offsets).toEqual([0, GATEWAY_CATALOG_CHUNK_CHARS]);
  }
});
