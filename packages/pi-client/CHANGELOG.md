## [Unreleased]

### Changed

- Based on upstream Pi 1.6.0, including GPT-6.2 models, Codex prompt-cache fixes, and tool results for every call in a cancelled batch.
- Routed Google Antigravity sign-in, models, and inference through the official local `agy` CLI.

### Fixed

- Applied server-provided public model catalogs regardless of the bundled catalog's build timestamp, including cached models and OpenRouter personalization.
- Read public model catalogs from pi-server's shared pi.dev cache only for providers with configured client authentication. Model availability and OpenRouter personalization remain client-owned; public catalog requests omit provider credentials. Transient catalog failures retain their cached models and ETag for the next refresh.
- Restarted updated runtimes through `/reload` with the current session, branch, and startup options. Shared update generations let each active session switch runtimes, and runtime lookup or handoff errors remain visible without relaunching the old runtime.
- Invoked npm through Node on Windows so global updates can start without a shell.
- Reported upstream Pi 1.0.0 and its full source commit in package metadata.
- Documented remote model operations, server-side credentials, and the 64 KiB UTF-8 request limit.
- Enabled remote prompt-cache warming with streaming and idle modes, bounded request bodies, and session usage accounting.
- Fixed automatic update checks to compare the installed `pi-client` version instead of the upstream `pi` version.
- Used `pi-client` in fork help and documented `web`, `send`, server configuration, global package updates, and `/reload` without changing upstream Pi help.
- Reported upload HTTP and connection failures with the target, response metadata, and a bounded, token-redacted body excerpt instead of JSON or network stack traces.
- Handled malformed `settings.json` when checking for the Tau Codex extension instead of crashing `pi-client web`.
- Used `--legacy-peer-deps` for npm-global fork updates and documented installs so existing upstream Pi installs do not trigger peer override warnings for forked prerelease aliases.
- Refreshed account model catalogs when opening the interactive model picker and reported refresh failures.

### Added

- Added automatic `pi` → `pi-client` command rewriting when running in `PI_SERVER_MODE`. The adapter installs a process-local PATH shim for subprocess execution and rewrites displayed commands for consistency.
- Initial `pi-client` package as a lightweight wrapper that exposes only the `pi-client` bin without `pi`.
- Global install wrapper that launches the local forked coding-agent entrypoint while sharing the original `~/.pi/agent` configuration.
- `pi-client update` command for updating the fork checkout and reinstalling both `pi-client` and `pi-server`.
- npm global package updates during `pi-client update`.
- `pi-client web` command that starts the client backend in Tau mirror mode on port `1838` by default.
- `pi-client send <path>` command for chunked file and folder uploads to pi-server.

### Changed

- Updated the upstream Pi base through commit `0e6909f0`, including the latest provider and compaction fixes.
- Rebased the client on upstream Pi `0.80.6`, including GPT-5.6 model metadata and `max` thinking support.
- Changed `pi-client update` to update global packages without reinstalling the active checkout or stopping sessions; updated sessions require `/reload` to restart on the new runtime with their existing history.

## [0.84.4]

- Fixed Cloudflare AI Gateway dispatch to match its supported generated model APIs.

## [0.80.7]

- Added `pi-client` server mode transport for sending incremental session/model/message deltas to `pi-server`.
- Added chunked `pi-server` request upload support controlled by `PI_CLIENT_MAX_REQUEST_KB`.
- Added a `pi-client` CLI entrypoint that preserves the original Pi config, extension, skill, prompt, and theme loading path.
- Reused matching `pi-server` tree hashes to avoid repeating full tree sync when the server already has the same persisted session tree.
- Added automatic first-turn session naming with the current model when no session name is set.
- Fixed large tool results from triggering compaction before the projected context reaches the model threshold.
- Fixed bash tool execution to run as a scheduler barrier so validation commands do not overlap with sibling tool calls.
- Fixed oversized bash tool timeouts to fail with a clear validation error instead of being clamped to an immediate timeout ([#6181](https://github.com/earendil-works/pi/issues/6181)).
