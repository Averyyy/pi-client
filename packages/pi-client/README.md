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

Use matching client and server releases. Ordinary provider credentials, environment overrides, and request headers are configured on the client and forwarded for inference. Devin accounts store and resolve their credentials on the server. Google Antigravity uses `agy` on the PiServer host.

Ordinary built-in model catalogs come from pi-server's shared pi.dev cache. Server metadata takes precedence over bundled metadata for the same model type and ID, independently of the package build date. The client requests catalogs only for providers with configured authentication and determines chat, image, and classifier availability from its own credentials and configuration. OpenRouter's credential-specific model filtering runs on the client. The Devin catalog comes from PiServer and the Antigravity catalog comes from `agy`. Extensions and codemode scripts use the normal model registry APIs. MCP connections, tools, and other provider logins remain in the client process.

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

Install [Antigravity CLI](https://antigravity.google/docs/cli/tutorial/) on the PiServer host and sign in to `agy` as the OS user running PiServer. In Pi Client, use `/model` to select a model from the server CLI's catalog. `/login google-antigravity` checks the existing `agy` sign-in and reloads that catalog. PiServer also runs the ACP conversation with `agy`.

`agy` is the agent: it owns the account catalog, its instructions, context, inference, and native tool permissions. Each turn, Pi sends `agy` only the messages you entered since its last reply; Pi's system prompt, other models' replies, and Pi's summaries never reach it. Your global `~/.pi/agent/AGENTS.md` and the skills Pi loads reach `agy` as its own native files on the PiServer host: the global rule `~/.gemini/config/rules/avery-ui-agents.md` and skill declarations in `~/.gemini/antigravity-cli/skills/<name>/SKILL.md`, which point at the client's `SKILL.md` files. The client exposes `~/.pi/agent/skills` as `~/.avery-ui/skills` through a directory link. File reads and terminal commands use the same files. The host running `agy` tracks its generated declarations in `~/.avery-ui/antigravity-skills.json`. The latest session to start `agy` on the host sets these files. Models advertised by the CLI, including available Orchestrator variants, appear in `/model`. Tools from Pi extensions run in the Pi process and return results to `agy` over MCP; file and terminal requests from `agy` also run in the Pi workspace. Pi's compaction and session summaries use the `compaction.model` setting, never `agy`. In pi-server mode the read-only viewer can still show Pi's session activity.

Pi records the tool calls `agy` makes with its own tools as Pi's `read`, `edit`, `write`, and `bash` calls when ACP's standard fields say exactly what ran: a read of one file, a change to one file, or a command in a terminal Pi ran for `agy`. Other calls, such as searches and web fetches, become notes in `agy`'s reply. Another model can then continue the session without being shown tools it cannot call. After you switch back, `agy` continues its own conversation: it knows its own turns, your messages, and the files in the workspace, not what other models replied.

### Rules for a personal `agy` sign-in

Your `agy` account is governed by Google's [Antigravity Terms](https://antigravity.google/terms) (section 6), [FAQ](https://antigravity.google/docs/faq), and [ACP documentation](https://antigravity.google/docs/ide/extensions/acp). A [reply on the Google AI Developers Forum](https://discuss.ai.google.dev/t/tos-clarification-is-opencode-antigravity-acp-official-agy-acp-in-opencode-permitted-under-the-antigravity-terms-of-service/202970) reads them strictly. Under that reading, a consumer sign-in (`oauth-personal`) allows `agy acp` only behind a thin client in which a person sends the prompts. A client that injects system instructions, tool definitions, replayed cross-model context, or automated loops risks automated suspension. Others in the same thread dispute that the reply is official, and Google suspends accounts without warning. Pi does not enforce the following rules; following them is your responsibility:

- Type every `agy` prompt yourself in an interactive session. Do not use an Antigravity model in `pi-client -p`, RPC mode, scripts, scheduled jobs, or sessions that an extension, a subagent tool, or another model starts.
- Do not have another model or agent hand work to `agy`, and do not paste another model's replies into an `agy` prompt as context.
- One person per sign-in: do not share the PiServer that holds your `agy` sign-in, its tunnel, or the sign-in itself, and do not rotate accounts.
- Keep `agy` unmodified. Pi launches plain `agy acp` and never reads its credentials; do not wrap it, proxy it, or copy its sign-in.
- Pi writes your global `AGENTS.md` and skill declarations into `agy`'s own rule and skill directories, as you would configure them yourself; nothing goes into the prompt. To keep them out, start the session with `--no-context-files` and `--no-skills`.
- Pi offers your extension tools to `agy` over MCP, the ACP mechanism editors use for their tools. The forum reply counts a harness's tool definitions against `oauth-personal`; to stay within that reading, start Antigravity sessions with `--no-extensions`.
- For automation or multi-model workflows, use a model from Pi's `google` provider with a Gemini API key instead of `agy`.

## Update

`pi-client update` installs the latest client and server packages without stopping active client sessions. Existing sessions block new prompts until you run `/reload`; `/reload` restarts that session on the new runtime and resumes its persisted history.

## Related Package

Install the server separately:

```bash
npm i -g --ignore-scripts @averyyy/pi-server
```
