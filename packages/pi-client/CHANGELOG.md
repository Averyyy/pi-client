## [Unreleased]

### Added

- Initial `pi-client` package as a lightweight wrapper that exposes only the `pi-client` bin without `pi`.
- Global install wrapper that launches the local forked coding-agent entrypoint while sharing the original `~/.pi/agent` configuration.
- `pi-client update` command for updating the fork checkout and reinstalling both `pi-client` and `pi-server`.
- npm global package updates during `pi-client update`.
- `pi-client web` command that starts the client backend in Tau mirror mode on port `1838` by default.
- `pi-client send <path>` command for chunked file and folder uploads to pi-server.

### Fixed

- Used `--legacy-peer-deps` for npm-global fork updates and documented installs so existing upstream Pi installs do not trigger peer override warnings for forked prerelease aliases.

### Changed

- Rebased the client on upstream Pi `0.80.6`, including GPT-5.6 model metadata and `max` thinking support.
- Changed `pi-client update` to update global packages without reinstalling the active checkout or stopping sessions; updated sessions require `/reload` to restart on the new runtime with their existing history.
