# @averyyy/pi-server

Server for `@averyyy/pi-client`. It stores session state and forwards client requests to upstream model providers.

## Install

```bash
npm i -g @averyyy/pi-server
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

Long-run safety limits are explicit and configurable:

```bash
PI_SERVER_SESSION_MAX_ENTRIES=250000
PI_SERVER_SESSION_MAX_LOGICAL_BYTES=268435456
PI_SERVER_SESSIONS_MAX_ENTRIES=500000
PI_SERVER_SESSIONS_MAX_LOGICAL_BYTES=536870912
PI_SERVER_MAX_LOADED_SESSIONS=1024
```

The server rejects a mutation with structured HTTP `507` before exceeding these limits. It does not truncate,
delete, or compact durable history to make room.

Transport and persistence watchdogs measure continuous lack of progress, not total operation duration:

```bash
PI_SERVER_REQUEST_BODY_NO_PROGRESS_TIMEOUT_MS=90000
PI_SERVER_STREAM_DRAIN_IDLE_TIMEOUT_MS=90000
PI_SERVER_STREAM_RUN_IO_NO_PROGRESS_TIMEOUT_MS=120000
PI_SERVER_COMPACT_RUN_IO_NO_PROGRESS_TIMEOUT_MS=120000
```

An active provider or compaction run has no short total-duration deadline; it continues while making progress and
remaining within configured capacity.

## Connect A Client

```bash
PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```

With auth:

```bash
PI_SERVER_AUTH_TOKEN=your-token PI_SERVER_URL=http://127.0.0.1:4217 pi-client
```
