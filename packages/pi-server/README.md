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
PI_SERVER_ACCOUNT_STORE_DIR=/path/to/accounts
```

Received files default to `~/.pi/upload_files`.

## Account Providers

PiServer owns Devin and Google Antigravity account login, credential persistence, token refresh, and model discovery. Connect with `pi-client`, run `/login devin` or `/login google-antigravity`, and complete the browser authorization and redirect prompt. The client receives account status and model metadata; credentials remain on the server.

Account files default to `~/.pi/pi-server/accounts`. Set `PI_SERVER_ACCOUNT_STORE_DIR` to choose another directory. The server restores saved account catalogs on startup, refreshes them in the background, after successful login, and every four hours. Expiring OAuth tokens refresh when needed. Failed discovery keeps the saved catalog and reports the error. `/logout` cancels the selected account's pending work and deletes its credentials and catalog.

The authenticated `/api/accounts` endpoint exposes these two account snapshots. Their inference and compaction requests use `options.authSource: "server-account"`, which selects the exact saved account model and server credentials. Ordinary built-in catalogs come from upstream pi.dev; other client provider configuration and login remain client-owned.

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

## Request Timing

Set `PI_TIMING=1` on the client to print request latency diagnostics. The client requests an opt-in `event: timing` SSE frame from `/api/stream`; ordinary requests do not include that frame.

Client `clientPrepareMs` starts at the boundary named by `clientPrepareFrom`: an accepted run, the agent's tool-completion event, or a user-message start. The tool boundary includes subsequent extension handlers and request preparation, while excluding tool execution itself. `sessionInitMs` measures session initialization, and client `firstContentMs` measures the interval from starting the stream POST to receiving content.

Server fields are cumulative milliseconds from receipt of the HTTP request: `bodyReadyMs` marks parsed request data, `providerDispatchMs` marks the provider call, `upstreamRequestMs` marks the prepared upstream payload, `upstreamHeadersMs` marks the first upstream HTTP response, and `firstContentMs` marks the first nonempty text, thinking, or tool-call output. Final-only content also counts. Adapters without a lifecycle callback omit its field. For chunked uploads, server timing starts with the completing HTTP chunk. The client's `requestToHeadersMs` includes serialization, all upload chunks, server processing, and the response headers.

`providerDispatchMs` to `upstreamRequestMs` covers provider authentication, loading, and payload preparation on the server. `upstreamRequestMs` to `firstContentMs` includes HTTP setup, network transit, upstream queueing, retries, and model processing. `upstreamHeadersMs` separates the first upstream HTTP response from the remaining wait for content. These intervals do not measure model prefill separately. HTTP headers, heartbeat bytes, and empty stream events do not count as model content.

## Thread Viewer

Open the server's root URL and sign in with `PI_SERVER_AUTH_TOKEN`. The home page groups threads by their client working directory and lists running threads first. Threads are ordered by their latest activity; projects use their most recently active thread. The server records activity when it starts and finishes inference, compaction, image, classifier, and deferred operations. Reading history, reconnecting, synchronizing existing history, renaming, and replaying completed results do not advance that time. Archived sessions use their saved conversation timestamps until the server records a new operation. Cache warming uses the same provider request protocol and counts as activity. Sessions without activity appear last.

Project folders expand five threads at a time. Thread pages show the latest five conversation rounds; scrolling to the top loads five earlier rounds while keeping the current passage in place. Completed rounds expose the final answer; thinking and tool activity can be expanded separately, including while they stream.

Right-click a project to collapse or expand it, or to delete all its server conversations. Right-click a thread to delete that server conversation. The same menus are available through the context-menu key or Shift+F10. Deletion requires confirmation and includes saved history and observer records. Project deletion includes conversations beyond the currently loaded pages.

The server indexes projects once per process and updates only affected sessions as they change. Pagination reads the project's index without scanning every session. The browser loads visible expanded folders and keeps their pages in memory while the page remains open; unchanged folders reuse those pages. Offscreen changes are fetched when the folder becomes visible. JavaScript and CSS use build-versioned URLs and immutable browser caching, including across server restarts; HTML, authentication, and conversation responses remain `no-store`.

Viewer reads, writes, and notifications run asynchronously in order for each thread. Activity updates do not wait for viewer storage or notifications before dispatching inference. Observer updates publish their content index after storage commits; deletion waits for preceding operations, and server shutdown drains pending operations. Asset loading and authentication state I/O are also asynchronous.

Opening a thread reads its initial history and live updates through one event-stream request. A direct thread URL starts that stream alongside the project catalog. Unchanged session initialization and idempotent history writes do not resend the viewer's history snapshot.

The browser receives a separate, 12-hour `HttpOnly`, `SameSite=Strict` session cookie scoped to `/viewer`. That cookie authorizes only viewer reads and same-origin session deletion. Provider requests and ordinary session APIs retain bearer authentication. Configure HTTPS at the reverse proxy for public access; the proxy must preserve the request host and HTTPS protocol. The viewer requires a configured server token.

Ten failed token checks lock authenticated access, including correct tokens. The count persists across restarts and is shared by viewer login and requests that supply an incorrect API authorization header. Requests without API credentials do not consume attempts. A successful viewer login resets the count; ordinary client traffic does not. Unlock on the server, using the same configuration and session directory as the running process:

```bash
PI_SERVER_SESSION_STORE_DIR=/path/to/sessions pi-server viewer unlock
```

Unlocking takes effect without restarting the server. There is no HTTP unlock endpoint.

Matching `pi-client` releases publish a separate observation stream containing the current branch's committed messages, project directory, title, and explicit run/tool state. Tool execution remains running between model requests. A disconnected client is shown as disconnected, rather than idle. The observer does not modify the server's inference tree or provider context. Its history and authentication state live under `.viewer` inside the session directory.

Existing server sessions are read from the recovered snapshots and WAL records. Projects use the remote working directory declared in the effective system message or Pi's standard system-prompt directory field; only sessions without that metadata appear as unassigned archives. Saved branch history is available without a connected client, and successful session writes update open viewer pages.

The viewer displays history saved by the server or published by a connected client. A session containing only initialization metadata has no saved conversation body. System instructions are used for project metadata and excluded from the conversation display. Images are represented as attachment labels. Transcript Markdown does not execute HTML or load external images.

The frontend is maintained in `viewer/` and ships as static assets in `dist/viewer/`. Build it with `npm run build:viewer`; `npm run build` includes that step. This viewer is independent of the interactive Tau interface launched by `pi-client web`.
