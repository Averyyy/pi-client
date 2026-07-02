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
pi install npm:tau-mirror
PI_SERVER_URL=https://pi.yreva.asia pi-client web
```

The web command starts `pi-client` in Tau mirror mode. Tau listens on `http://127.0.0.1:1838` by default and uses the same shared `~/.pi/agent` extension install as local `pi`, so installing Tau with either `pi` or `pi-client` works.

## Server Auth

If your server uses an auth token, set it on the client:

```bash
PI_SERVER_AUTH_TOKEN=your-token PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```

## Related Package

Install the server separately:

```bash
npm i -g --ignore-scripts @averyyy/pi-server
```
