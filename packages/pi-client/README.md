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

## Update

`pi-client update` installs the latest client and server packages without stopping active client sessions. Existing sessions block new prompts until you run `/reload`; `/reload` restarts that session on the new runtime and resumes its persisted history.

## Related Package

Install the server separately:

```bash
npm i -g --ignore-scripts @averyyy/pi-server
```
