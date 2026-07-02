## [Unreleased]

### Added

- Initial `pi-client` package as a lightweight wrapper that exposes only the `pi-client` bin without `pi`.
- Global install wrapper that launches the local forked coding-agent entrypoint while sharing the original `~/.pi/agent` configuration.
- `pi-client update` command for updating the fork checkout and reinstalling both `pi-client` and `pi-server`.
- npm global package updates during `pi-client update`.
- `pi-client web` command that starts the PI WEB client GUI on port `1838` by default.
- Pi Server status, URL settings, client actions, project visibility, and global `AGENTS.md` editing inside `pi-client web`.
