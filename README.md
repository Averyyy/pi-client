<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Pi Agent Harness Mono Repo

This is the home of the pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## pi-client and pi-server fork install

This fork adds a `pi-client` CLI and a separate `pi-server`.

`pi-client` shares the same `~/.pi/agent` configuration, extensions, skills, prompts, themes, sessions, and project discovery behavior as the original `pi` CLI. It does not install a `pi` binary. The only request-path difference is that `pi-client` sends incremental requests to `pi-server`; `pi-server` reconstructs the full conversation by `sessionId` and forwards it to the configured LLM API.

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
- `pi-server`: the local HTTP server that owns provider auth and upstream LLM forwarding.

This fork is based on upstream Pi `0.79.3` at commit `6f29450`.

### 3. Configure and start pi-server

Environment configuration:

```bash
export PI_SERVER_HOST=127.0.0.1
export PI_SERVER_PORT=4217
export PI_SERVER_AUTH_TOKEN="change-me"
export PI_SERVER_PROVIDER_BASE_URL="https://opencode.ai/zen/go/v1"
export PI_SERVER_PROVIDER_API_KEY="sk-..."
# Optional, comma-separated:
export PI_SERVER_PROVIDER_HEADERS="X-Header=value,Another-Header=value"

pi-server
```

For OpenCode Go, use the OpenAI-compatible root base URL:

```bash
PI_SERVER_PROVIDER_BASE_URL="https://opencode.ai/zen/go/v1"
```

`pi-server` also supports a JSON config file:

```json
{
	"host": "127.0.0.1",
	"port": 4217,
	"authToken": "change-me",
	"providerBaseUrl": "https://opencode.ai/zen/go/v1",
	"providerApiKey": "sk-...",
	"providerHeaders": {}
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

`PI_CLIENT_MAX_REQUEST_KB` caps every client-to-server JSON POST body. When a request is larger than this limit, `pi-client` splits it into multiple `/api/request/chunk` uploads and `pi-server` reassembles the original request before dispatching it. The default is `512` KB.

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

`pi-client` uses the same Pi config directory and original startup path, so existing extensions and skills still load normally. Provider API keys can move to `pi-server` via `PI_SERVER_PROVIDER_API_KEY`, which keeps large client requests small and centralizes upstream auth.

### New users without pi installed

Install `pi-client` and `pi-server` with the commands above, then start `pi-server` with provider settings. `pi-client` will create/use `~/.pi/agent` the same way the original Pi CLI does.

Optional directories for user resources:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/skills ~/.pi/agent/prompts ~/.pi/agent/themes
```

Project-local `AGENTS.md`, extensions, skills, prompts, and themes continue to use the original Pi discovery rules.

### Operational notes

- Update this fork with `pi-client update`. It updates the checkout with `git pull --ff-only`, refreshes dependencies with `npm install --ignore-scripts`, then reinstalls both `pi-client` and `pi-server`. The update stops if the checkout has uncommitted changes.
- `pi-server` stores session history in process memory. Restarting `pi-server` clears server-side session state.
- Run `pi-server` behind your own TLS/reverse proxy if accessing it over a network.
- Keep `PI_SERVER_AUTH_TOKEN` set when `pi-server` is reachable by anything other than local trusted processes.

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

- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.
- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

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

## License

MIT
