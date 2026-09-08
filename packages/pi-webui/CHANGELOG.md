## [Unreleased]

### Fixed

- Kept in-flight replies attached to their original session when switching sessions, including while the first append or a history load is pending.
- Preserved the authoritative final assistant message instead of persisting only streamed partial fields.
