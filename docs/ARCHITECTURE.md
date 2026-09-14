# Architecture

## Responsibility split

ChatGPT Web owns user intent, planning, context selection, and deciding which tool to call next. The bridge owns transport adaptation and chat-to-local-task association. Codex owns the native tool executor and its permission context. Installed tools own their external service interactions.

There is no browser automation component controlling the ChatGPT composer, no model API client, and no autonomous second reasoning loop in the extracted application. The native protocol still labels a task with a model identifier; its named provider is a randomized **127.0.0.1-only Responses endpoint**, not a remote inference service.

## Call path

1. `src/web-session/mcp.ts` receives MCP requests. Tool annotations describe read/write risk; they are not access control.
2. `conversation.ts` hashes host-provided `openai/session` metadata. Clients without it use explicit per-chat handles. Transport IDs are not substituted for chat identity.
3. `sessions.ts` resolves the persistent native task and tracks bounded jobs. Passive discovery uses the online seed without spawning a chat task.
4. `native-harness.ts` serves local Responses exchanges and forwards exact tool requests through the broker. Desktop tasks keep native context; a short-lived auxiliary App Server prepares task metadata and then releases its writer.
5. `adapters/chatgpt-web/mcp-server.ts`, `turn-broker.ts`, and `tool-events.ts` preserve the tested upstream gateway and convert text/media/structured results. These inherited directory names describe provenance, not an embedded browser controller.
6. `responses/` and `bridge.ts` implement native wire-format compatibility. Browser conversation reconstruction and the upstream on-disk response cache are excluded.

## Lifecycle

`prepare-desktop` is explicit installation work. It creates a task and owned configuration without starting a turn. The first seed must be started in Desktop. That seed can start subsequent **managed local-provider** tool tasks via a private lifecycle path, not an exposed general-purpose model-starting API.

The seed remains connected. Managed stateless tasks can idle after five minutes. Stateful REPLs, CUA kernels, and uncertain native jobs are pinned conservatively. Requests are bounded; unknown outcomes are not replayed. Closing and restoring a mapping is not evidence that the native executor is alive.

`doctor` does not create a task, read browser history, or restart the service. It distinguishes native driver health from tunnel connectivity.

## State and trust

Private state includes `desktop.json`, `sessions.json`, lifecycle journals, and operation metadata. It lives outside the public checkout. Legacy job output is not persisted in the bridge's job snapshot; native Codex task history and user tools can retain their own data. Do not interpret that implementation choice as a no-retention guarantee.

File helper paths are constrained to the chosen workspace and check symlinks and hashes. Native tools use their native permission boundaries; shell/desktop access is more powerful than these helpers. The no-second-model tool filter is not an adversarial sandbox. Arbitrary user-owned code and plugins may do more than the bridge itself.

The localhost provider route is a capability, and the native task ID selects routing inside that trust boundary. Neither the route nor a conversation hash authenticates an unrelated remote user. This release is intended for one trusted user's machine and authorized ChatGPT workspace.

## Extraction policy

Keep protocol compatibility code when it is needed by the real tool path; do not replace proven adapters just to reduce line count. Remove application-level components that would restore the old ownership model: browser conversation automation, full-context prompt assembly, model selection UI, launcher bundles, and browser cookies.

The package has two direct runtime dependencies: the MCP SDK and Zod. Their transitive dependencies still apply. Codex and tunnel-client are installed separately, not bundled.
