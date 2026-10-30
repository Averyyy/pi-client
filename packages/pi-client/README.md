# @averyyy/pi-client

Client CLI for connecting Pi to a `pi-server` instance.

## Install

```bash
npm i -g --ignore-scripts --legacy-peer-deps @averyyy/pi-client
```

`--legacy-peer-deps` avoids npm peer override warnings when upstream Pi is already installed globally.

## Use

Connect to your server:

```bash
PI_SERVER_URL=https://pi-server.example.com pi-client
```

Send one prompt and exit:

```bash
PI_SERVER_URL=https://pi-server.example.com pi-client -p "Say exactly: ok"
```

Send a file or folder to the server:

```bash
PI_SERVER_URL=https://pi-server.example.com pi-client send /path/to/file-or-folder
```

The server saves it under its configured upload directory, which defaults to `~/.pi/upload_files`.

Start the browser UI:

```bash
pi-client install npm:@averyyy/pi-tau-codex
# or: pi install npm:@averyyy/pi-tau-codex
PI_SERVER_URL=https://pi-server.example.com pi-client web
```

The web command starts `pi-client` in Tau mirror mode. Install the standalone `@averyyy/pi-tau-codex` extension into the shared `~/.pi/agent` settings first. Tau listens on `http://127.0.0.1:1838` by default.

## Server Auth

If your server uses an auth token, set it on the client:

```bash
PI_SERVER_AUTH_TOKEN=your-token PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```

Use matching client and server releases. Ordinary provider credentials, environment overrides, and request headers are configured on the client and forwarded for inference. Devin and Google Antigravity accounts store and resolve their credentials on the server.

Ordinary built-in model catalogs come from pi-server's shared pi.dev cache. The client requests catalogs only for providers with configured authentication and determines chat, image, and classifier availability from its own credentials and configuration. OpenRouter's credential-specific model filtering runs on the client. Devin and Google Antigravity account catalogs come from the server. Extensions and codemode scripts use the normal model registry APIs; inference runs on the server. MCP connections, tools, and other provider logins remain in the client process.

`PI_CLIENT_MAX_REQUEST_KB=64` limits each client HTTP request body to 65,536 UTF-8 bytes. Larger prompts, tool definitions, images, operation payloads, and session trees use the shared chunk transport.

## Read-only Server Viewer

Open the server URL in a browser and sign in with its Bearer token to browse saved threads by project. The client publishes committed conversation history and live thinking/tool activity through an independent observation channel. Observer connection errors are reported in the terminal and do not interrupt prompts or tools. Reconnecting refreshes the server's read-only projection of the current branch.

The browser can view threads but cannot operate the client. Run and idle indicators follow the client lifecycle; an interrupted observation connection is shown explicitly. Both client and server must include the observer feature for live updates and project metadata.

Normal runtime shutdown waits up to ten seconds for the final observation update. A delivery failure is reported without changing the prompt result or exit status.

## Prompt Cache Warming

Cache warming replays eligible requests through pi-server with the original prompt, tools, model, and cache options, limiting output to one token. The default `streaming` mode warms during active agent runs. To also warm while waiting for input, set this in your global Pi settings:

```json
{
  "cacheWarming": "idle"
}
```

The server confirms the cache retention used by each request, and the client uses that policy for refresh timing and cost decisions. The model must declare a prompt-cache lifetime, and the expected savings must reach $0.05. `/session` shows the warming decision. Set `cacheWarming` to `"off"` to disable it. Refresh usage counts toward session totals without adding model messages; cancellation and changed model/context stop warming. Requests use the same 64 KiB transport limit.

## Devin Pro

Update both `@averyyy/pi-client` and `@averyyy/pi-server` to a version with native Devin support. Start `pi-client` with your server connection configured, then:

```text
/login devin
/model devin/swe-2-medium
```

Login displays Devin's browser authorization link. Complete sign-in and paste the full final redirect URL into the login prompt. PiServer exchanges the code and saves the session token in its account store. The account catalog loads after login; `pi-client --list-models swe-2` lists the discovered SWE-2 variants. Choose the exact variant (for example `swe-2-high` or `swe-2-max`) to change effort.

Authentication, account model discovery, and inference run on PiServer. The server restores the saved catalog on startup, refreshes it in the background and after login, and refreshes it every four hours. Discovery failures retain the saved catalog and report the error. Pi continues to own tools, agent loops, session history, and subagents. No Devin CLI installation or provider extension is needed. Remove conflicting Devin extensions before enabling the native provider.

The integration exposes concrete models, not Devin's Fusion/router harness. A revoked session requires `/login devin` again; no refresh endpoint or token lifetime is invented.

Protocol references: [pi-devin](https://github.com/mizorewww/pi-devin), [pi-devin-provider](https://github.com/fadlee/pi-devin-provider), and the [Devin protocol descriptors](https://github.com/can1357/oh-my-pi/tree/main/packages/ai/src/providers/devin/proto).

## Google Antigravity

Run `/login google-antigravity`, complete browser authorization, and paste the full redirect URL into the login prompt. PiServer stores the OAuth credentials and project, refreshes expiring tokens, and discovers the account's exact model IDs. `pi-client --list-models google-antigravity` reads the server's saved account catalog.

Both account providers use the server directory configured by `PI_SERVER_ACCOUNT_STORE_DIR`, defaulting to `~/.pi/pi-server/accounts`. `/logout` removes the selected server account and its catalog. Provider tokens stay on the server. Local Pi sessions use their local credential store.

## Update

`pi-client update` installs the latest client and server packages without stopping active client sessions. Existing sessions block new prompts until you run `/reload`; `/reload` restarts that session on the new runtime and resumes its persisted history.

## Related Package

Install the server separately:

```bash
npm i -g --ignore-scripts @averyyy/pi-server
```
