<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## pi-client and pi-server fork install

This fork adds a `pi-client` CLI and a separate `pi-server`.

`pi-client` shares the same `~/.pi/agent` configuration, extensions, skills, prompts, themes, sessions, and project discovery behavior as the original `pi` CLI. It does not install a `pi` binary. The only request-path difference is that `pi-client` sends incremental requests to `pi-server`; `pi-server` reconstructs the full conversation by `sessionId` and forwards it to the client-selected LLM API.

### npm install

Install the client:

```bash
npm i -g --ignore-scripts --legacy-peer-deps @averyyy/pi-client
PI_SERVER_URL=https://pi.yreva.asia pi-client
```

Install the server only when you want to run your own `pi-server`:

```bash
npm i -g --ignore-scripts @averyyy/pi-server
pi-server
```

The npm fork releases use `0.80.6-piclient.N`, based on upstream Pi `0.80.6`.

`--legacy-peer-deps` prevents npm from replacing the forked prerelease peer with upstream stable Pi when both are installed globally.

### 1. Clone and install dependencies

Use Node through `nvm`:

```bash
git clone https://github.com/Averyyy/pi-client.git pi-client
cd pi-client
nvm install 22.19.0
nvm use 22.19.0
npm install --ignore-scripts
```

### 2. Install the global CLIs

```bash
npm run install:pi-client
npm run install:pi-server
```

This installs:

- `pi-client`: the forked client CLI. It does not overwrite an existing `pi` install.
- `pi-server`: the local HTTP proxy that stores session state and forwards upstream LLM requests using request metadata supplied by `pi-client`.

This fork is based on upstream Pi `0.80.6`.

### 3. Configure and start pi-server

Environment configuration:

```bash
export PI_SERVER_HOST=127.0.0.1
export PI_SERVER_PORT=4217
export PI_SERVER_AUTH_TOKEN="change-me"
export PI_SERVER_UPLOAD_DIR="$HOME/.pi/upload_files"

pi-server
```

`pi-server` also supports a JSON config file:

```json
{
	"host": "127.0.0.1",
	"port": 4217,
	"authToken": "change-me",
	"uploadDir": "/path/to/upload_files"
}
```

Start with:

```bash
PI_SERVER_CONFIG=/absolute/path/to/pi-server.json pi-server
```

Config precedence is: explicit runtime overrides, environment variables, config file, defaults.

### 4. Configure pi-client

In another terminal:

```bash
export PI_SERVER_URL="http://127.0.0.1:4217"
export PI_SERVER_AUTH_TOKEN="change-me"
export PI_CLIENT_MAX_REQUEST_KB=512

pi-client --provider opencode-go --model glm-5.1
```

Configure provider models, base URLs, API keys, and headers on the client side through the normal Pi `~/.pi/agent/models.json` and auth settings. For OpenCode Go, use the OpenAI-compatible base URL there, for example `https://opencode.ai/zen/go/v1`.

`PI_CLIENT_MAX_REQUEST_KB` caps every client-to-server JSON POST body. When a request is larger than this limit, `pi-client` splits it into multiple `/api/request/chunk` uploads and `pi-server` reassembles the original request before dispatching it. The default is `512` KB.

Send a file or folder through the same chunked transport:

```bash
pi-client send /path/to/file-or-folder
```

The server saves it under `PI_SERVER_UPLOAD_DIR`, which defaults to `~/.pi/upload_files`.

### Existing pi users

No config migration is needed. Keep your existing `~/.pi/agent` files in place:

- `settings.json`
- `models.json`
- `auth.json`
- `extensions/`
- `skills/`
- `prompts/`
- `themes/`
- `sessions/`

`pi-client` uses the same Pi config directory and original startup path, so existing extensions, skills, provider models, and auth settings still load normally. `pi-server` does not have provider-specific configuration; it receives the selected model and request auth from `pi-client`.

### New users without pi installed

Install `pi-client` and `pi-server` with the commands above, then start `pi-server` with host/port/auth-token settings. Configure providers in `pi-client` the same way the original Pi CLI does; `pi-client` will create/use `~/.pi/agent`.

Optional directories for user resources:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills ~/.pi/agent/prompts ~/.pi/agent/themes
```

Project-local `AGENTS.md`, extensions, skills, prompts, and themes continue to use the original Pi discovery rules.

### Operational notes

- Update this fork with `pi-client update`. It updates the checkout with `git pull --ff-only`, refreshes dependencies with `npm install --ignore-scripts`, then reinstalls both `pi-client` and `pi-server`. The update stops if the checkout has uncommitted changes.
- `pi-server` stores session history in process memory. Restarting `pi-server` clears server-side session state.
- Read full server-side history with `GET /api/session/:id/history`. This is a response-only large payload path; the client POST size cap still applies only to client-to-server request bodies.
- Run `pi-server` behind your own TLS/reverse proxy if accessing it over a network.
- Keep `PI_SERVER_AUTH_TOKEN` set when `pi-server` is reachable by anything other than local trusted processes.

## pi-client 和 pi-server 中文安装指南

这个 fork 增加了两个独立命令：

- `pi-client`：基于原始 Pi coding agent 的客户端。它仍然读取和复用 `~/.pi/agent`，所以已有的配置、extension、skill、prompt、theme、session 和项目发现逻辑保持不变。它不会安装或覆盖 `pi` 命令。
- `pi-server`：本地或远程 HTTP 服务。它按 `sessionId` 保存完整历史，把 `pi-client` 发来的增量消息拼回完整请求，再转发到真正的 LLM API。

npm fork release 使用 `0.80.6-piclient.N` 版本格式，基于 upstream Pi `0.80.6`。

### npm 安装

安装客户端：

```bash
npm i -g --ignore-scripts --legacy-peer-deps @averyyy/pi-client
PI_SERVER_URL=https://pi.yreva.asia pi-client
```

只有需要运行自己的 `pi-server` 时才安装服务端：

```bash
npm i -g --ignore-scripts @averyyy/pi-server
pi-server
```

`--legacy-peer-deps` 用来避免 npm 在本机已安装 upstream Pi 时，把 forked prerelease peer 替换成 upstream stable Pi。

### 1. 克隆仓库并安装依赖

建议用 `nvm` 切到项目要求的 Node 版本：

```bash
git clone https://github.com/Averyyy/pi-client.git pi-client
cd pi-client
nvm install 22.19.0
nvm use 22.19.0
npm install --ignore-scripts
```

### 2. 全局安装 pi-client 和 pi-server

```bash
npm run install:pi-client
npm run install:pi-server
```

安装后会得到：

- `pi-client`：客户端命令，使用原始 Pi 的启动逻辑和配置目录，但 request 走增量发送。
- `pi-server`：服务端命令，负责保存 session 历史、拼接完整上下文，并使用 `pi-client` 传来的 model/request auth 转发请求。

### 3. 配置并启动 pi-server

最简单的方式是用环境变量：

```bash
export PI_SERVER_HOST=127.0.0.1
export PI_SERVER_PORT=4217
export PI_SERVER_AUTH_TOKEN="change-me"
export PI_SERVER_UPLOAD_DIR="$HOME/.pi/upload_files"

pi-server
```

也可以使用 JSON 配置文件：

```json
{
	"host": "127.0.0.1",
	"port": 4217,
	"authToken": "change-me",
	"uploadDir": "/path/to/upload_files"
}
```

启动：

```bash
PI_SERVER_CONFIG=/absolute/path/to/pi-server.json pi-server
```

配置优先级是：运行时显式参数、环境变量、JSON 配置文件、默认值。

### 4. 配置并启动 pi-client

另开一个终端：

```bash
export PI_SERVER_URL="http://127.0.0.1:4217"
export PI_SERVER_AUTH_TOKEN="change-me"
export PI_CLIENT_MAX_REQUEST_KB=512

pi-client --provider opencode-go --model glm-5.1
```

provider 的 model、base URL、API key 和 headers 仍在 client 侧按原始 Pi 的方式配置，也就是 `~/.pi/agent/models.json` 和 auth 相关配置。比如 OpenCode Go 的 OpenAI-compatible base URL 应该配置在 client 侧：`https://opencode.ai/zen/go/v1`。

`PI_CLIENT_MAX_REQUEST_KB` 用来限制 `pi-client` 到 `pi-server` 的单次 JSON POST 大小，单位是 KB。超过限制时，`pi-client` 会把请求拆成多次 `/api/request/chunk` 上传，`pi-server` 收齐后再还原原始请求。默认值是 `512`。

文件和文件夹使用同一套分块传输：

```bash
pi-client send /path/to/file-or-folder
```

服务端保存到 `PI_SERVER_UPLOAD_DIR`，默认是 `~/.pi/upload_files`。

### 已经安装过原始 Pi 的用户

不需要迁移配置。继续保留现有 `~/.pi/agent`：

- `settings.json`
- `models.json`
- `auth.json`
- `extensions/`
- `skills/`
- `prompts/`
- `themes/`
- `sessions/`

`pi-client` 仍然使用原始 Pi 的配置加载和资源发现路径，所以已有 extension 和 skill 会正常加载。唯一差异是：请求链路从直接请求 LLM 变成 `pi-client -> pi-server -> LLM API`，客户端只把最近增量消息、model 信息和 `sessionId` 发给 `pi-server`。

上游 provider 的 API key、base URL 和 headers 保持在 client 侧配置。`pi-server` 定位是无 provider 配置的 proxy，只接收 `pi-client` 每次请求带来的 model 和 request auth。

### 没有安装过 Pi 的新用户

按上面的步骤安装 `pi-client` 和 `pi-server` 即可。第一次启动时，`pi-client` 会按原始 Pi 的行为创建和使用 `~/.pi/agent`。

如果你想提前放置资源目录，可以创建：

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills ~/.pi/agent/prompts ~/.pi/agent/themes
```

项目里的 `AGENTS.md`、extension、skill、prompt 和 theme 仍按原始 Pi 的规则发现。

### 更新 pi-client

`pi update` 只更新原始 Pi，不会更新这个 fork。

这个 fork 使用：

```bash
pi-client update
```

它会：

1. 输出当前 `pi-client` 版本以及基于哪个 upstream Pi 版本和 commit。
2. 检查当前 checkout 是否有未提交修改；如果有，会停止更新。
3. 执行 `git pull --ff-only`。
4. 执行 `npm install --ignore-scripts`。
5. 重新安装全局 `pi-client` 和 `pi-server`。

### 运行注意事项

- `pi-server` 的 session 历史保存在进程内存里，重启后会清空。
- `GET /api/session/:id/history` 可以读取服务端完整历史。这是只读的大响应路径；`PI_CLIENT_MAX_REQUEST_KB` 仍只限制 client 到 server 的请求体大小。
- 如果 `pi-server` 不只暴露给本机可信进程，请务必设置 `PI_SERVER_AUTH_TOKEN`。
- 如果跨机器访问 `pi-server`，建议放在你自己的 TLS 或反向代理后面。
- `pi-client` 不会覆盖本机已有的 `pi` 命令，两者可以同时存在。

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --platform linux-x64 --out "$PWD/out"
```

The script installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
