# Codex Tools Bridge

**对话留在 ChatGPT，把本地工具接进来。**

[English](README.md) · [安装说明](docs/SETUP.md) · [架构](docs/ARCHITECTURE.md) · [安全说明](SECURITY.md)

让 ChatGPT 网页通过 MCP 调用本地 Codex 的原生工具。**网页负责思考、调度和上下文，本地负责执行工具、返回结果。桥接层不再调用第二个模型。**

> 当前为实验版，优先面向 macOS。代码从实际使用中的个人部署拆出，独立仓库带有回归测试，但不代表所有 Desktop 版本、插件和平台都已验证。Desktop 完整冷启动仍需要手动启动一次专用工具宿主任务。

## 为什么做这个

起初我在用 [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)。用下来发现，对于我的使用方式，没必要让完整的 Codex 对话 harness 再来接管 ChatGPT 网页。网页本身的调度和上下文管理已经很好，我真正需要的只是把 Codex 的本地工具提供给它。

所以这个项目换了个方向：

**不是让 Codex 把 ChatGPT 网页当作模型后端，而是让 ChatGPT 网页把 Codex 当作本地工具宿主。**

这不只是“受到启发”：工具网关与部分 Responses 协议代码实际复用了上游 MIT 代码，并保留本地会话实现及修改。具体来源见 [NOTICE](NOTICE.md)、[上游许可证](LICENSES/upstream-MIT.txt) 和 [UPSTREAM.json](UPSTREAM.json)。

## 怎么工作

```text
ChatGPT 网页：思考、上下文、工具调度
              ↕
OpenAI 官方 Secure MCP Tunnel
              ↕
Codex Tools Bridge：MCP、聊天与本地任务关联
              ↕
Codex 原生工具宿主：命令、文件、浏览器、已安装 MCP/插件工具
              ↕
真实文本、图片、结构化结果和错误，返回网页
```

连接采用 [OpenAI 官方 Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，不要求把本机 MCP 服务开放到公网。这个仓库是独立项目，**不是 OpenAI 官方产品**；源码开源、连接私有插件，与公开插件商店上架是不同的事。

## 能干什么

- 在网页里直接让模型读本地项目、改代码、运行测试、查看真实结果，不再手动往返复制。
- 返回真正的图片内容，保留工具的结构化输出。浏览器和电脑操作复用宿主已有能力，不另写一套浏览器控制器。
- 发现本机实际注册的工具，再按真实名称和参数调用；已配置的 MCP/插件工具是否可用，以原生目录与权限为准。
- 自动关联不同网页聊天与本地任务，后续调用复用各自的执行上下文。支持保留连续调用所需的原生状态。

网关过滤已知的递归桥接入口和启动模型的入口，但**这不是安全隔离机制**。允许使用 Shell 就意味着能执行其权限范围内的程序；第三方工具也可能自行联网、调用模型或产生费用。

## 安装

```sh
git clone https://github.com/KunHcz/codex-tools-bridge.git
cd codex-tools-bridge
bun install --frozen-lockfile --ignore-scripts
bun run verify
bun src/cli.ts --help
```

测试基线为 Bun 1.3.11；本地开发环境使用 Codex CLI 0.153.4。Codex、Desktop 与官方 tunnel-client 需要自行安装，具体原生工具随宿主版本变化。

然后按 [完整安装说明](docs/SETUP.md) 初始化专用工作目录、准备 Desktop 宿主、配置 Tunnel，并在 ChatGPT 中连接私有插件。仓库不包含任何人的密钥、运行时配置、聊天记录或浏览器登录数据。

## 有意不做的事

不接管网页对话，不把完整提示词注入另一个浏览器会话，不复制 ChatGPT Cookie，不再跑一套模型推理循环。

**但仍然需要 Codex 的原生工具运行时。** 当前借助原生任务/工具回合提供真实权限与工具上下文，通过本机 Responses 协议驱动器收发工具请求。“不需要第二套对话 harness”，不是“完全不依赖 Codex”。

## 当前边界

Desktop 第一个工具宿主仍需手动启动；等待网页请求时，Desktop 可能显示任务正在运行。无状态任务可空闲释放，REPL、电脑操作状态以及执行结果未知的作业会保守保留。超时不等于操作没执行，不会自动重放结果未知的动作。

聊天映射分开不代表文件和物理桌面隔离。这个项目面向个人使用，不适合直接暴露成多人共享的远程电脑服务。工具结果会发送给 ChatGPT，不能把“工具在本地执行”理解成“所有数据永远不离开本机”。

自动化测试不等于每个 Desktop 版本、所有浏览器动作或新机器首次安装都已通过验收。详见 [已知限制](docs/SETUP.md#known-limitations) 与 [安全说明](SECURITY.md)。

## 开发与许可

运行 `bun run verify` 执行类型检查、回归测试与发布内容检查。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 [MIT](LICENSE)，保留上游署名；Codex、Tunnel 客户端和第三方插件另有各自的许可与使用条件。
