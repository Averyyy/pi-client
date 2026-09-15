# @averyyy/pi-client

Client CLI for connecting Pi to a `pi-server` instance.

## Install

```bash
npm i -g --ignore-scripts --legacy-peer-deps @averyyy/pi-client
```

`--legacy-peer-deps` avoids npm peer override warnings when upstream Pi is already installed globally.

## Use

Connect to the hosted server:

```bash
PI_SERVER_URL=https://pi.yreva.asia pi-client
```

Send one prompt and exit:

```bash
PI_SERVER_URL=https://pi.yreva.asia pi-client -p "Say exactly: ok"
```

Send a file or folder to the server:

```bash
PI_SERVER_URL=https://pi.yreva.asia pi-client send /path/to/file-or-folder
```

The server saves it under its configured upload directory, which defaults to `~/.pi/upload_files`.

Start the browser UI:

```bash
pi-client install npm:@averyyy/pi-tau-codex
# or: pi install npm:@averyyy/pi-tau-codex
PI_SERVER_URL=https://pi.yreva.asia pi-client web
```

The web command starts `pi-client` in Tau mirror mode. Install the standalone `@averyyy/pi-tau-codex` extension into the shared `~/.pi/agent` settings first. Tau listens on `http://127.0.0.1:1838` by default.

## Server Auth

If your server uses an auth token, set it on the client:

```bash
PI_SERVER_AUTH_TOKEN=your-token PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```

## Devin Pro

Update both `@averyyy/pi-client` and `@averyyy/pi-server` to a version with native Devin support. Start `pi-client` with your server connection configured, then:

```text
/login devin
/model devin/swe-2-medium
```

Login opens Devin's browser OAuth flow and saves the session token in Pi's normal credential store. The account catalog loads after login; `pi-client --list-models swe-2` lists the discovered SWE-2 variants. Choose the exact variant (for example `swe-2-high` or `swe-2-max`) to change effort. Available models and limits come from Devin; there is no hardcoded fallback catalog.

Authentication and model discovery may contact Devin from the client. Model inference, including compaction, goes through `pi-client → pi-server → Devin`. Direct Devin inference rejects `PI_SERVER_MODE=true`. Pi continues to own tools, agent loops, session history, and subagents. No Devin CLI installation or provider extension is needed. Remove conflicting Devin extensions before enabling the native provider.

The integration exposes concrete models, not Devin's Fusion/router harness. A revoked session requires `/login devin` again; no refresh endpoint or token lifetime is invented.

Protocol references: [pi-devin](https://github.com/mizorewww/pi-devin), [pi-devin-provider](https://github.com/fadlee/pi-devin-provider), and the [Devin protocol descriptors](https://github.com/can1357/oh-my-pi/tree/main/packages/ai/src/providers/devin/proto).

## Update

`pi-client update` installs the latest client and server packages without stopping active client sessions. Existing sessions block new prompts until you run `/reload`; `/reload` restarts that session on the new runtime and resumes its persisted history.

## Related Package

Install the server separately:

```bash
npm i -g --ignore-scripts @averyyy/pi-server
```
