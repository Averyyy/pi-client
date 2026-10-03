# @averyyy/pi-server

Server for `@averyyy/pi-client`. It stores session state and forwards client requests to upstream model providers.

## Install

```bash
npm i -g --ignore-scripts --legacy-peer-deps @averyyy/pi-server
```

## Start

```bash
pi-server
```

By default it listens on `http://127.0.0.1:4217` and stores sessions under `.pi/pi-server/sessions` in the current directory.

## Configure

Set provider keys in the server environment, then start the server:

```bash
OPENAI_API_KEY=your-key pi-server
```

Useful server settings:

```bash
PI_SERVER_HOST=127.0.0.1
PI_SERVER_PORT=4217
PI_SERVER_AUTH_TOKEN=your-token
PI_SERVER_SESSION_STORE_DIR=/path/to/sessions
PI_SERVER_UPLOAD_DIR=/path/to/upload_files
```

Received files default to `~/.pi/upload_files`.

## Connect A Client

```bash
PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```

With auth:

```bash
PI_SERVER_AUTH_TOKEN=your-token PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```

Use the same release version for client and server. The authenticated `/api/models` catalog reports chat, image, and classifier models with their precise availability. `/api/stream`, `/api/generate-images`, and `/api/classify` resolve server-side provider credentials or use credentials explicitly supplied by the client.

Image generation and classification stream heartbeat responses and journal completed results for recovery without repeating the provider operation. Cancellation is acknowledged after provider cleanup finishes. Oversized operation payloads use `/api/request/chunk`, including when clients set a 64 KiB request-body limit.
