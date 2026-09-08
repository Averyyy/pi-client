# Changelog

## [Unreleased]

### Added

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

### Changed

- Updated the upstream Pi base through commit `0e6909f0`, including the latest provider and compaction fixes.
- Rebased the server on upstream Pi `0.80.6`, including GPT-5.6 model metadata and `max` thinking support.
