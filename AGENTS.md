# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- After completing implementation work, add any reusable lessons from the task to this `AGENTS.md` so future agents do not rediscover the same rule.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## pi-client / pi-server Request Sync

- Default to incremental sync. Client-to-`pi-server` requests should send only the new messages or other minimal deltas needed for the current operation.
- If the server has messages the client does not have, the server may send those messages or the full server history back to the client. Client receive size is not constrained by the proxy POST-body limit.
- If client and server history diverge, server history is authoritative. Reconcile the client to the server history and refresh the UI/session state instead of uploading the divergent client history.
- When `pi-server` reports an existing `treeHash` and `entryCount`, treat that as the server-known prefix. If the local tree extends that prefix, append only the new tail entries; do not full-sync just because in-memory entry-id tracking was reset by resume/import/process restart.
- When `pi-server` reports the same full tree hash but a different `leafId`, switch the leaf with `/api/session/tree/switch`; do not resend entries.
- If `pi-server` reports a non-empty tree that is not a prefix of the local tree, fetch `/api/session/:id/history`, refresh the local tree from that snapshot, and stop the current operation. Do not overwrite the server with a client full-tree sync.
- If `/api/session/tree/append` or `/api/session/tree/switch` returns a recoverable divergence for a non-empty server tree, reconcile from `/api/session/:id/history`; do not treat it as permission to replace the server tree.
- If a client-to-server full-history upload is truly unavoidable, it must go through `ChunkRequest`. Never add a direct full-history POST path that can bypass the configured request-size limit.
- Keep request-size handling transport-local: normal callers should use the pi-server request abstraction and should not manually split or stringify large bodies at feature call sites.
- Keep provider request timeout inside serialized pi-server stream/compact options; `ChunkRequest` should only use the caller abort signal so chunk upload time does not consume LLM API timeout.
- Keep proxy acknowledgement in `ChunkRequest`: if a pi-server request receives a `proxycontrolwarn` warning, approve it there and retry the same request once instead of adding feature-level retries.
- Keep update-command proxy acknowledgement in the package updater wrappers: git checkouts approve the git remote and npm registry before `git pull` / `npm install`; npm global installs approve the npm registry before `npm install -g @averyyy/pi-client@latest @averyyy/pi-server@latest`.

## pi-client / pi-server Compact and Resilience

- Treat the session tree as durable full history. Compaction is branch-local: add a compaction entry on the active branch and let `buildSessionContext()` derive the compacted active context. Never physically prune sibling branches or old entries during sync.
- Server-side compaction is authoritative. `pi-server` should append the compaction entry, persist it, and return the updated tree snapshot; `pi-client` should replace its local tree from that snapshot instead of locally appending a compaction and syncing it back.
- Compact summarization must handle histories larger than the active summarizer model window by chunking summary input and recursively splitting only context-overflow chunks, including a single oversized serialized message/tool result; if one chunk still overflows, surface the provider error instead of hiding it.
- Tree/branch summaries are part of the same compaction family: use the shared chunked summarizer instead of pre-dropping old branch messages or sending a single oversized summary request.
- Before overflow retry after a terminal assistant message (`error`, `aborted`, or `length`), detach that terminal assistant from the active branch/context while preserving it in full history. Retrying from an assistant leaf will fail or resend the bad context.
- Do not clear pi-server sync tracking for normal retry. Keep the known server tree state so retry can append the detached terminal assistant entry and then append the successful assistant instead of full-syncing the tree again.
- Session tree append must be idempotent for identical duplicate entries from retries. Identical duplicates are no-ops; divergent duplicate ids should still throw.
- Do not mark pi-server sync as successful until the response is valid JSON. For proxy/network failures, report status, content-type, and a short body excerpt; stream responses must be `text/event-stream`.
- Keep Windows persistence recovery narrow: retry `rename` on Windows `EPERM`, but do not delete the target session file as a fallback.
- To reproduce pi-server flows locally, use `packages/coding-agent/src/pi-client-cli.ts`, not `pi-test.sh`; `pi-test.sh` runs the plain CLI and does not set `PI_SERVER_MODE`.

## pi-client Web UI

- `pi-client web` is the client GUI entrypoint and should build on `@jmfederico/pi-web`. Do not use `packages/pi-webui` for this command; that package is a pi-server session inspector/proxy.
- Keep `PI_SERVER_MODE=true` when launching the web runtime so browser sessions use the same pi-client-to-pi-server transport as the CLI.
- Keep pi-client-specific web UI additions in the `pi-client web` wrapper routes and bundled PI WEB plugin; do not fork or patch `@jmfederico/pi-web` unless the user explicitly asks.
- Global `AGENTS.md` web editing should use the coding-agent `getAgentDir()` path (`~/.pi/agent/AGENTS.md` by default) so the web UI and CLI share the same instructions file.
- Hidden project support in `pi-client web` should stay as a wrapper-layer visibility filter over PI WEB projects; do not fork PI WEB's project store format for client-only visibility.
- When publishing the standalone client package, publish `packages/pi-client` as `@averyyy/pi-client` and keep its runtime dependencies as registry versions, not workspace `file:` links.

## Averyyy npm Publishing

- Publish the scoped fork packages with `npm run publish:averyyy -- --version 0.80.3-piclient.N`. The version must use npm prerelease format: upstream Pi version plus `-piclient.N`, not four numeric segments.
- Dry-run locally with `npm run publish:averyyy:dry -- --version 0.80.3-piclient.N`. Use `--skip-build` only when existing `dist` output was already built for the same source.
- The script publishes `@averyyy/pi-ai`, `@averyyy/pi-tui`, `@averyyy/pi-agent-core`, `@averyyy/pi-coding-agent`, `@averyyy/pi-client`, and `@averyyy/pi-server` from temporary package directories. It rewrites internal runtime dependencies to exact `npm:@averyyy/...@version` aliases and does not mutate workspace package versions.
- The temporary package metadata must set `repository.url` to `https://github.com/Averyyy/pi-client`; npm provenance rejects packages whose repository points at upstream `earendil-works/pi`.
- Remote publishing is handled by `.github/workflows/publish-averyyy-npm.yml`. Creating or editing a draft release does not trigger GitHub Actions; publish the draft release, or run the workflow manually with `workflow_dispatch`.
- Scheduled Averyyy publishing lives in `.github/workflows/publish-averyyy-npm.yml`. Daily runs must derive the release prefix from the current upstream package version, increment the highest existing `v<base>-piclient.N` tag, and create the GitHub release only after npm publish succeeds so the next run can reliably skip when there are no commits since the latest release.
- The remote workflow uses npm trusted publishing through environment `npm-publish` with `--provenance`. Configure each package, not just `@averyyy/pi-client`, for that trusted publisher:
  `npx --yes npm@11 trust github @averyyy/<package> --file publish-averyyy-npm.yml --repo Averyyy/pi-client --env npm-publish --allow-publish`.
- Before relying on remote publishing, verify every package in the script has trusted publishing configured. A release-triggered publish can fail with `404 Not Found ... or you do not have permission` when the package lacks the trusted publisher. For a new package such as `@averyyy/pi-tui`, `npm trust github ... --allow-publish` can grant the workflow `createPackage` permission before the first publish.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- When coding-agent tests spawn `src/cli.ts` from source under Node 26, use `node --import <repo>/node_modules/tsx/dist/loader.mjs src/cli.ts` with `TSX_TSCONFIG_PATH` so workspace packages resolve through the repo TS path mappings instead of missing unbuilt `dist/*.js` files.
- Test debounce logic with direct scheduler calls and fake timers; keep real `fs.watch` tests for watcher wiring only, because OS watcher delivery is flaky under the full suite.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- After finishing workspace changes, commit and push only your own changes unless the user explicitly says not to.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Do not rerun the release script after a tag was pushed.

4. **CI publishes npm packages**: pushing the `vX.Y.Z` tag triggers `.github/workflows/build-binaries.yml`. The `publish-npm` job uses npm trusted publishing through GitHub Actions OIDC with environment `npm-publish`; no local `npm publish`, `npm whoami`, OTP, or WebAuthn flow is required.

5. **If CI publish fails**: inspect the failed `publish-npm` job. The publish helper is idempotent and skips package versions already present on npm, so rerun the tag workflow after fixing CI or transient npm issues. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
