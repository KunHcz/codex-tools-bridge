# Installation / 安装说明

This is an experimental developer setup, not a one-click desktop installer. The commands below create a new instance; **do not point them at an existing live bridge's state or tunnel profile**.

这是独立实例的安装流程。不要覆盖正在运行的旧版本；先用新工作目录、新状态目录和独立 Tunnel 验证，再自行安排迁移。

## 1. Prerequisites

Install Bun, Codex, a compatible Desktop host, and [OpenAI's tunnel-client](https://github.com/openai/tunnel-client/releases/latest). Start with the [official onboarding guide](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md) for transport installation and credentials. Tunnel access and ChatGPT developer-mode access are separate requirements; account eligibility must be checked in your own workspace.

```sh
bun --version
codex --version
tunnel-client help quickstart
```

The tested local baseline is Bun 1.3.11 and Codex CLI 0.153.4. Desktop-only tools need the Desktop-compatible Codex binary that provides those tools; a separately installed CLI may not expose the same registry. Use `--codex-bin` to select it explicitly. On the author's macOS installation the host binary is supplied by the installed desktop app, not distributed in this repository.

## 2. Clone and prepare a dedicated local host

Run this block from a shell after choosing your Codex binary. All paths are absolute. These directories contain private runtime state and must stay out of the public checkout.

```sh
git clone https://github.com/KunHcz/codex-tools-bridge.git
cd codex-tools-bridge
bun install --frozen-lockfile --ignore-scripts

export BRIDGE_REPO="$PWD"
export BRIDGE_WORKSPACE="$HOME/CodexToolsWorkspace"
export BRIDGE_STATE="$HOME/.local/state/codex-tools-bridge"
export BRIDGE_CODEX="$(command -v codex)"
export BRIDGE_BUN="$(command -v bun)"
export BRIDGE_REGISTRY="${CODEX_HOME:-$HOME/.codex}/config.toml"
mkdir -p "$BRIDGE_WORKSPACE" "$(dirname "$BRIDGE_STATE")" "$(dirname "$BRIDGE_REGISTRY")"

bun src/cli.ts doctor --workspace "$BRIDGE_WORKSPACE" --codex-bin "$BRIDGE_CODEX"
bun src/cli.ts prepare-desktop \
  --workspace "$BRIDGE_WORKSPACE" \
  --state-dir "$BRIDGE_STATE" \
  --codex-bin "$BRIDGE_CODEX" \
  --desktop-provider-registry "$BRIDGE_REGISTRY"
```

**Read before running `prepare-desktop`:** it creates a native task, writes the dedicated workspace's `.codex/config.toml`, and adds one owned `codex_web_sessions` provider definition to the registry path you explicitly supplied. It does not change the global default provider, model, or approval policy, and does not start a model turn. It refuses existing state and existing project configuration. Use a dedicated workspace, not your home directory or a running project's configured root. A fresh setup also refuses an already registered `codex_web_sessions` provider, so it cannot overwrite another instance. Separate workspaces alone do not isolate a shared native registry; use a separate supported native profile or plan an explicit migration.

首次初始化会创建专用原生任务、写入专用工作目录配置，并向你明确指定的 Codex 配置文件添加一个有所有权标记的 provider 定义。默认采用原生按需审批和 workspace-write；不会复制原作者机器上的宽松权限设置，也不代替用户点击 Desktop 审批。

The returned task is named **Codex Tools Bridge · local tool host**. `desktop.json` and `sessions.json` stay in the private state directory. They contain installation-specific paths and task identity, not reusable public examples. Do not edit their IDs to point at unrelated tasks.

If initialization fails after writing provider configuration, it leaves that configuration pointing at the offline local driver rather than silently falling back to a remote model. Inspect the error, the dedicated workspace, and the marked registry block before retrying with fresh state. Never delete unrelated user settings.

## 3. Connect the official tunnel

Create/select a tunnel and runtime credential using the official guide. Associate it with the ChatGPT workspace you will use. Supply `CONTROL_PLANE_API_KEY` through your normal local secret-management workflow; do not paste secrets into this repository, chat messages, or public issues. Do not use an admin key for the long-lived runtime.

With the runtime key and `CONTROL_PLANE_TUNNEL_ID` already present in your terminal environment, this profile runs this project's **stdio MCP entry point**:

```sh
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile codex-tools-bridge \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-command "\"$BRIDGE_BUN\" \"$BRIDGE_REPO/src/cli.ts\" mcp --workspace \"$BRIDGE_WORKSPACE\" --state-dir \"$BRIDGE_STATE\""

tunnel-client doctor --profile codex-tools-bridge --explain
tunnel-client run --profile codex-tools-bridge
```

This is an intentionally foreground launch: keep the terminal running. For managed persistence, use the official client's `runtimes` workflow and check its status, rather than adding an ad-hoc shell supervisor here. Proxy, credential storage, and tunnel lifecycle options are owned by the official client and can differ across its releases.

Only run one active consumer for a given tunnel. Do not run a second bridge against the tunnel currently carrying an important session. Source code can be upgraded separately from the running service.

## 4. Start the first Desktop tool host once

While the MCP service is running, locate **Codex Tools Bridge · local tool host** in Desktop. Start that existing dedicated task with:

> Start the configured local tool driver and wait for ChatGPT Web tool requests. Keep the codex_web_sessions local provider; do not switch to another provider.

不要新建普通模型任务来代替它，也不要改成其他 provider。宿主必须支持读取并使用这个任务已经保存的本地 provider。若当前 Desktop 版本不支持该流程，停止在这里并报告版本，不要强行改全局默认配置。

Handle the native approval prompt in Desktop. Once connected, new web chats are associated automatically; users should not manage session IDs. Only the first seed's cold start requires this manual step. After a full Desktop restart it may be necessary again.

In another terminal, run the read-only diagnostic with the same paths:

```sh
bun "$BRIDGE_REPO/src/cli.ts" doctor \
  --workspace "$BRIDGE_WORKSPACE" \
  --state-dir "$BRIDGE_STATE" \
  --codex-bin "$BRIDGE_CODEX"
```

Check native driver state as well as tunnel readiness. A healthy tunnel alone does not prove that Desktop's tools are connected.

## 5. Connect in ChatGPT and verify harmlessly

Create a private/developer-mode MCP plugin connection using **Tunnel** as the connection type, then select your tunnel. See [OpenAI's current connection instructions](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for the workspace-specific UI. This is not a public plugin-store submission.

Send a harmless request first:

> 使用 Codex Tools Bridge 查看本地工具目录，然后运行 pwd。不要修改文件，报告真实输出。

Then create a disposable text file in the authorized workspace and verify read/write, followed by a small test image. Test browser interactions only on a disposable page you control. Verify the returned pixels, not just a success message. Never use destructive operations to test connectivity.

Configured MCP/plugin tools come from the actual native registry. The bridge does not auto-install plugins or grant OS permissions. A missing tool may indicate the wrong native host, a missing plugin, or missing permissions, not a tunnel failure.

## Advanced standalone mode

`mcp --workspace ABS --state-dir ABS` without a `desktop.json` uses the standalone App Server path. **In this release, passive `codex_tool_inventory` requires the Desktop seed and therefore reports offline in standalone mode.** Fixed file/job operations can still be used, and explicitly initialized native sessions can invoke known native tools. Standalone is not the recommended full-registry onboarding path; do not treat it as interchangeable with Desktop browser support.

The explicit `--tool-access all` switch broadens native approval handling for this bridge instance. It does not bypass operating-system protections or administrators. The default is `configured`. Use existing native policies and only grant apps/commands you trust.

## Known limitations

- macOS-first. Windows named-pipe, desktop, and full installation support are not claimed. Linux protocol tests alone would not establish Linux Desktop support.
- The initial Desktop host still needs a manual start, and its native build must support the required App Server/provider APIs. A clean-machine, fully unattended install has not been established.
- A waiting tool host can appear as a running task. Idle cleanup is conservative around REPL state, browser state, and unknown jobs. Closing a browser chat does not mean its local runtime has ended.
- Separate chat/task mappings are not filesystem, credential, or physical-desktop isolation. Do not expose the bridge to untrusted users.
- Native prompts and timeouts can outlive an outer MCP request. An unknown outcome must be inspected rather than automatically repeated.
- A local test suite and a working source deployment are not fresh end-to-end acceptance of the extracted release on every host. The maintainer's running bridge is not automatically switched by publishing this repository.

## Updating / stopping

Install updates in a separate checkout and rerun verification. Do not overwrite private state, install another copy over a live checkout, or stop the tunnel merely to remove Desktop's running indicator. Stop a foreground tunnel with its normal terminal interrupt after checking active work; use the official runtime command for a managed tunnel. Preserve task mappings and the owned provider configuration for intentional recovery. No automatic migration from the original project is performed.
