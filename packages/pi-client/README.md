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
PI_SERVER_URL=https://pi.yreva.asia pi-client web
```

The web UI listens on `http://127.0.0.1:1838` by default.

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
