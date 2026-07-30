# Changelog

## [Unreleased]

### Added

- Initial pi-server package: HTTP proxy server that stores session state and forwards incremental LLM requests to upstream providers.
- `/api/session/init` endpoint for initializing session static context.
- `/api/session/update` endpoint for updating session static context.
- `GET /api/session/:id/history` endpoint for reading full server-side session history without a request body.
- `/api/stream` endpoint for streaming incremental LLM requests with delta messages.
- `/api/request/chunk` endpoint for reassembling oversized client requests before dispatch.
- `DELETE /api/session/:id` endpoint for removing one server-side session.
- `/health` endpoint for health checks.
- `pi-server update` command with npm global package updates.
- Configurable via `PI_SERVER_CONFIG` or environment variables: `PI_SERVER_HOST`, `PI_SERVER_PORT`, `PI_SERVER_AUTH_TOKEN`.
- Persistent session tree storage under `PI_SERVER_SESSION_STORE_DIR`, including exact tree hashes in session responses.
- `/api/receive` endpoint for chunked file and folder uploads under `PI_SERVER_UPLOAD_DIR`.

### Fixed

- Used `--legacy-peer-deps` for npm-global fork updates so existing upstream Pi installs do not trigger peer override warnings for forked prerelease aliases.
- Fixed provider streams that close without a terminal event and made duplicate `runId` requests single-flight, replayable, and bounded by count and retention time.
- Fixed static-context hashes to include canonical constrained-sampling tool configuration.
- Fixed Windows updates to invoke the validated npm CLI through the active Node executable and terminate stalled git or npm steps with actionable errors.
- Added durable provider-run journals with cursor replay, terminal acknowledgement, restart-uncertainty handling, bounded lossless persistence backpressure, and immediate provider cancellation.
- Reworked session persistence as checksummed append-only WAL records plus periodic snapshots, with strict revision/digest validation and narrow torn-write recovery.
- Made server-side compaction authoritative, replayable, heartbeat-streamed, branch-local, and compatible with native Pi compaction hooks and cancellation.
- Bounded session history, request, response, SSE, subscriber, run-journal, and upload resources with explicit structured failures instead of silent truncation, and reduced chunk reassembly peak memory with independently decoded base64 segments.
- Made session tree mutation and file receive retries idempotent while rejecting divergent duplicate IDs or destination contents.
- Added per-filesystem-operation no-progress watchdogs for durable run persistence and a bounded CLI fatal-shutdown grace, without imposing a total provider-run deadline or retrying indeterminate writes.
- Made compaction capacity admission exact and atomic before provider execution and journal settlement, serialized deletion against queued work, and enforced single-owner fail-stop persistence within and across processes.
- Removed provider-execution fingerprint admission checks so established custom-provider pi-client sessions are accepted again.

### Changed

- Updated the upstream Pi base through commit `0e6909f0`, including the latest provider and compaction fixes.
- Rebased the server on upstream Pi `0.80.6`, including GPT-5.6 model metadata and `max` thinking support.
- Added structured, secret-free provider-stream failure logs with response metadata preserved across the proxy.
