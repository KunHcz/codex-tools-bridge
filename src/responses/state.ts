/** The local tool driver does not expand previous_response_id or load a
 * conversation cache. Its native host sends the input for each tool round.
 * Kept as the parser compatibility seam; no Web context is managed here. */
export function previousResponseReplayPrefixLength(_body: unknown): number {
  return 0;
}
