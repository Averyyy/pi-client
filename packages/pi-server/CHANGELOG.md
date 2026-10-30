# Changelog

## [Unreleased]

### Added

- Added an authenticated public pi.dev catalog cache with on-demand fetching, shared concurrent requests, version-specific persistence, and four-hour ETag revalidation. Clients retain provider authentication and model availability decisions.
- Added server-side Anthropic OAuth subscription request shaping for chat, compaction, and cache warming while retaining client-owned login and token refresh.
- Added opt-in request timing that separates server preparation, upstream response headers, and first content, with client preparation and transport timings enabled by `PI_TIMING=1`.
- Added a collapsible parent-thread sidebar for tintinweb subagents, grouped by active and completed task state with live updates and persisted session links.
- Displayed the pi-server package version on the viewer login and conversation pages.
- Added a browser viewer with project folders, five-item pagination, conversation folding, live thread activity, and persistent token lockout with local CLI unlock.
- Added project and thread context menus for folding and confirmed server deletion, automatic history loading at the top, and project ordering by the latest thread activity.
- Added an independent observer store and streaming endpoints without changing provider requests or authoritative session trees.
- Reported the resolved cache-retention policy before provider dispatch and retained it for same-run recovery and replay, without returning server credentials or environment values.
- Added an authenticated mixed model catalog and image/classifier endpoints with heartbeat streaming, completed-run recovery, and acknowledged cancellation.
- Added correlated provider lifecycle callbacks so client extensions can inspect responses and replace request payloads before provider dispatch.
- Added remote deferred response fetch and cancellation with server credentials and the same callback and recovery transport.
- Added native Devin inference dispatch for proxy streams and server-side compaction.

- Initial pi-server package: HTTP proxy server that stores session state and forwards incremental LLM requests to upstream providers.
- `/api/session/init` endpoint for initializing session static context.
- `/api/session/update` endpoint for updating session static context.
- `GET /api/session/:id/history` endpoint for reading full server-side session history without a request body.
- `/api/stream` endpoint for streaming incremental LLM requests with delta messages.
- `POST /api/session/:sessionId/runs/:runId/abort` for explicit cancellation with acknowledgement after provider cleanup. Matching late-arriving stream or compaction requests cannot restart a cancelled operation.
- `/api/request/chunk` endpoint for reassembling oversized client requests before dispatch.
- `DELETE /api/session/:id` endpoint for removing one server-side session.
- `/health` endpoint for health checks.
- `pi-server update` command with npm global package updates.
- Configurable via `PI_SERVER_CONFIG` or environment variables: `PI_SERVER_HOST`, `PI_SERVER_PORT`, `PI_SERVER_AUTH_TOKEN`.
- Persistent session tree storage under `PI_SERVER_SESSION_STORE_DIR`, including exact tree hashes in session responses.
- `/api/receive` endpoint for chunked file and folder uploads under `PI_SERVER_UPLOAD_DIR`.

### Fixed

- Reclaimed idle request-chunk caches, bounded completed request bodies, and retained chunk checksums without duplicate Base64 payloads.
- Reclaimed expired viewer login cookies and deleted-session metadata, and coalesced background viewer updates while preserving committed message order.
- Made viewer persistence, history and asset reads, and authentication state I/O asynchronous. Viewer notifications run outside inference dispatch, with ordered per-thread operations, committed history indexes, and shutdown draining.
- Loaded committed viewer tool outputs on expansion and parsed large event-stream frames incrementally to reduce thread-opening transfer size and browser CPU work.
- Ordered threads and projects by server-recorded operation activity, preserving order across reconnects, metadata changes, history synchronization, and completed-result replay without requiring client activity timestamps.
- Loaded thread history directly from its event stream in parallel with the catalog, cached build-versioned assets across reloads and restarts, and suppressed unchanged persistence snapshots.
- Cached the viewer's project index and static assets, loaded visible project folders on demand, and refreshed only changed project pages.
- Accepted weak ETags when revalidating assets compressed by a reverse proxy.
- Grouped archived remote-client sessions by their saved working directory, including snapshot/WAL metadata and incremental system sections, without requiring an observer connection.
- Refreshed viewer pages after successful session persistence and excluded system instructions from archived conversation content.
- Rejected newer WAL records that overlap the session snapshot instead of silently dropping them, while continuing to ignore revisions already included in the snapshot.
- Removed repeated leaf and compaction-run checks after the same synchronous checks had already succeeded.
- Registered the OpenAI Decisions API for custom classifier providers, including image inputs over chunked requests.
- Preserved native provider authentication and raw/simple dispatch through the request adapter, including server-side bearer and federation credentials.
- Preserved sampling parameters, tool choice, deferred controls, environment overrides, API-specific options, parsed provider events, and authoritative failed assistant messages in proxy streams.
- Included constrained tool sampling declarations in static-context hashes and registered operation payloads with the chunk transport for bounded request bodies.
- Made compaction of an active compaction leaf idempotent and exposed completed compaction results for same-run recovery after response interruption.

- Rejected stale compaction results after concurrent session changes instead of attaching summaries to the wrong branch.
- Preserved authoritative final assistant messages in healthy proxy streams, including redacted thinking and provider response metadata.
- Persisted static-context-only updates across restarts by advancing session revisions.
- Handled IPv6 request routing and printed bracketed IPv6 listening addresses with the actual bound port.
- Removed quadratic array prepends from long session-branch reconstruction.
- Made help, version, and unknown CLI arguments exit without starting the server or loading sessions.
- Forwarded compaction request timeouts to the summarizer provider without changing cancellation or upload-time budgeting.
- Recovered and truncated torn WAL tail records without hiding complete invalid records or allowing one corrupt session file to prevent server startup.
- Preserved complete authoritative tool-call metadata through proxy streams and completed-run replay.
- Bounded stream-run journals with TTL cleanup, final-message-only storage, same-run recovery, and session-delete cleanup.
- Returned structured error codes for session/tree recovery and removed the obsolete assistant-error deletion endpoint.
- Updated pi-server runtime dependencies to the current lockstep fork packages.
- Used `--legacy-peer-deps` for npm-global fork updates so existing upstream Pi installs do not trigger peer override warnings for forked prerelease aliases.
- Increased the pending chunk budget to 1 GiB so large session-tree appends do not fail at the previous 64 MiB Base64 limit.
- Reused authoritative prompt prefixes for eligible server-side compaction summaries while retaining chunked handling for mismatched or oversized contexts.

### Changed

- Updated the upstream Pi base through commit `0e6909f0`, including the latest provider and compaction fixes.
- Rebased the server on upstream Pi `0.80.6`, including GPT-5.6 model metadata and `max` thinking support.
