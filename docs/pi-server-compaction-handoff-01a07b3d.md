# pi-server compaction failure handoff

Date: 2026-09-09 Asia/Taipei  
Session: `01a07b3d-1136-730f-b728-457fe00650ba`

## Conclusion

The two displayed errors are one failure chain:

1. The first compaction request reached the client-side tree synchronization step. The local session tree did not match the non-empty server tree. The client deliberately fetched the server history, replaced the local tree with that authoritative history, and then threw:

   `pi-server history differed from local history; local session was reconciled to server history`

2. A second compaction request was then made against the reconciled tree. The server's active leaf is already a `compaction` entry, so `prepareLegacyCompaction()` returns no preparation. The server returned HTTP 400 with `Nothing to compact` before calling the summarizer. The client wrapped it as:

   `Server compaction failed (400 Bad Request; content-type: application/json; body excerpt: Nothing to compact)`

The second error is therefore a consequence of the first reconciliation, not a separate provider or WAL failure.

## Runtime and evidence

Live deployment inspected:

- Scheduled task: `PiServerAtStartup`, state `Running`.
- Global packages: `@averyyy/pi-client@0.85.1-piclient.3`, `@averyyy/pi-server@0.85.1-piclient.3`, and the nested `@averyyy/pi-coding-agent@0.85.1-piclient.3`.
- Server endpoint: `127.0.0.1:4217`.
- Active store: `C:\Windows\System32\.pi\pi-server\sessions`.
- Session file: `b3c5411e485ed9f02bcf74e0950f0bb1a7957fc54b015f99181385afdc376b11.json` and its `.wal`. The filename is the SHA-256 of the session ID.
- `pi-server.log` contains only listening messages. `pi-server.err.log` is empty. The current server does not emit request-level audit lines for normal 400 responses, so the exact failing request URL and request tree hash are not recoverable from serverlog alone.

The live authenticated API and WAL agree on the current state:

| Field | Value |
|---|---|
| revision | `11` |
| entry count | `3204` |
| active leaf | `e14997d7-cef4-4104-ad08-95c392a73e94` |
| tree hash | `a300756ae6c5269fb83d1a5f78b5ae5ed8e3502d69aedd8d96dde48c850b7c3b` |
| active-branch entries | `3116` |
| non-active branch entries | `88` |
| compaction entries | `5` |

The current history request with `entriesFrom=3204` and the live tree hash returned an empty tree patch, confirming that the server has no newer tree entries after the active compaction.

## Server WAL timeline

Payload contents were not printed. The table contains only entry counts, types, IDs, revisions, and timestamps.

| WAL line | Local time | Revision | Tree change | Leaf |
|---:|---|---:|---|---|
| 4 | 2026-09-07 23:00:22 | 1 | 1269 entries: message/custom/model metadata | `52b226a2` |
| 5 | 2026-09-07 23:03:00 | 2 | one compaction entry | `f8e96636-c88e-4a47-9c24-391a2daa6cd4` |
| 6 | 2026-09-08 00:08:04 | 3 | 396 message/custom entries | `12c0b2e4` |
| 7 | 2026-09-08 00:11:41 | 4 | one compaction entry | `a56cfeac-9f60-4859-8b2c-0299037ac056` |
| 9 | 2026-09-08 14:32:01 | 5 | 958 message/custom entries | `7d541195` |
| 10 | 2026-09-08 14:37:10 | 6 | one compaction entry | `8eddcf02-02c9-44ac-aa1b-b0e564016259` |
| 11 | 2026-09-08 17:41:42 | 7 | 517 message/custom entries | `c3365907` |
| 12 | 2026-09-08 17:47:38 | 8 | one compaction entry | `d19df186-3fe9-46f7-9ddb-7617f80f928d` |
| 13 | 2026-09-08 17:56:11 | 9 | 59 message/custom entries | `a3d30893` |
| 14 | 2026-09-08 18:02:19 | 10 | one compaction entry | `e14997d7-cef4-4104-ad08-95c392a73e94` |
| 15 | 2026-09-09 08:09:01 | 11 | no tree entries; static context update | unchanged |

All WAL lines parsed successfully. The historical line 8 has zero entries and repeats revision 4 while carrying a changed static-context payload; the next record advances to revision 5 with that context. It does not alter the tree hash or explain the `differ` error.

## Full code path

### 1. Client starts server-side compaction

`AgentSession.compact()` calls `compactPiServer()` with the full local session tree and registers `reconcilePiServerHistory()` as the reconciliation callback:

- `packages/coding-agent/src/core/agent-session.ts:2364-2385`
- `packages/coding-agent/src/core/pi-server-client.ts:918-944`

Before POSTing `/api/session/compact`, the client runs `syncPiServerTreeWithRequest()`.

### 2. Divergence is detected and server history wins

The sync code can attempt an incremental tree append or leaf switch. If the server rejects that operation with a structured tree-divergence code, `recoverPiServerTreeDivergence()` fetches server history. For a non-empty server tree it applies that history and throws the explicit reconciliation error:

- `packages/coding-agent/src/core/pi-server-client.ts:744-809`
- `packages/coding-agent/src/core/pi-server-client.ts:822-888`

`applyPiServerHistory()` updates the client-side tracking maps and invokes the callback. The callback replaces the local session tree and rebuilds the agent context:

- `packages/coding-agent/src/core/pi-server-client.ts:659-698`
- `packages/coding-agent/src/core/agent-session.ts:524-533`
- `packages/coding-agent/src/core/session-manager.ts:1111-1137`

The first attempt stops at this point; it does not reach the provider summarizer or commit another server compaction entry. The manual-compaction catch adds the outer `Compaction failed:` prefix:

- `packages/coding-agent/src/core/agent-session.ts:2512-2526`

### 3. The next compact request is rejected as empty/already compacted

On the reconciled server tree, the active branch ends at `e14997d7-cef4-4104-ad08-95c392a73e94`, whose type is `compaction`. `prepareLegacyCompaction()` explicitly returns `undefined` when the branch is empty or its last entry is a compaction:

- `packages/agent/src/harness/compaction/compaction.ts:1036-1043`

The server maps that result to HTTP 400 `Nothing to compact` before `completeSessionCompact()` is called:

- `packages/pi-server/src/server.ts:612-648`
- `packages/pi-server/src/server.ts:847-878`

The client reads the JSON failure and formats the status, content type, and body excerpt:

- `packages/coding-agent/src/core/pi-server-client.ts:418-449`
- `packages/coding-agent/src/core/pi-server-client.ts:944-960`

## Why the local and server histories differed

What is proven:

- At the first failing compact, the local tree sent by the client was not identical to the non-empty server tree known by pi-server.
- The client chose the safety path that makes server history authoritative; it did not overwrite the non-empty server tree with local data.
- The server's current tree contains branches and five committed compactions, with the active leaf at a compaction entry.

What the current artifacts cannot prove:

- The server has no request audit log, so the exact first divergence endpoint (`tree/append` versus `tree/switch`) and the local/server hash pair are not recorded.
- The local session file for this server session is not present on this host, so the pre-reconciliation local entry IDs cannot be compared directly.
- No run ID is stored in the compaction entry, and the server log does not correlate requests to WAL writes.

The strongest implementation-level explanation is a lost or aborted previous server-compaction result:

1. `completeSessionCompact()` persists the new compaction entry before writing the SSE result (`packages/pi-server/src/server.ts:674-742`).
2. `compactPiServer()` only calls `markTreeSynced()` after it has received and parsed the complete compaction result (`packages/coding-agent/src/core/pi-server-client.ts:962-985`).
3. Unlike ordinary `/api/stream` handling, the compact client path does not poll `/runs/:runId` after an interrupted compact response.
4. The server run record stores only `message` and `errorMessage`; it has no compaction result or updated tree to replay (`packages/pi-server/src/server.ts:137-150`, `271-280`).

Therefore, if the previous compact reached step 1 but the client lost the response, the server keeps the compaction entry while the local session keeps the pre-compaction tree. The next compact reaches the history-reconciliation path and produces the first error. This matches the observed server state: the latest tree mutation is a committed compaction, and there are no later message entries.

Other possible sources of the same mismatch are a second client/process reusing the session ID or a local resume/branch state older than the server tree. The available artifacts cannot distinguish those alternatives from the lost-result window. They are not server-side provider failures.

## Fix handoff

Recommended next implementation work:

1. Give compaction runs a durable result: persist the compaction entry/result or expose a run endpoint that returns the committed compaction tree/result. Make `compactPiServer()` recover the same `runId` after a response interruption before reporting history divergence.
2. Add redacted request audit fields for `sessionId`, `runId`, phase, status, error code, base tree hash, actual tree hash, entry count, and leaf ID. Never log prompts, responses, credentials, or provider tokens.
3. Add a regression covering: server commits compaction, client receives a truncated/aborted compact response, client retries, recovery applies the committed result, and no false `history differed` is shown.
4. Keep the current server-authoritative reconciliation behavior. Do not full-sync a different non-empty local tree over the server tree.
5. After successful reconciliation, make the UI report that the local session was updated and compaction is already complete, or suppress an immediate duplicate compact request. The server's 400 is correct for the reconciled state.

No source fix, build, or test was run in this investigation. No live session or server data was modified.
