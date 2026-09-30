# Record committed metadata cleanup in the existing scheduler event

Status: accepted for EdgeLab 3.4.2. Local runtime and cost evidence are available; deployment, autonomous production recovery and native inference remain separate verification gates.

## Problem

[ADR 006](006-metadata-retention-work.md) bounds policy-version and orphan-note work with persisted FIFO queues. Operators need to inspect what a completed cleanup did without running eligibility scans on every dashboard read, exposing private note activity publicly, or publishing a success record for rolled-back work. SQL rowsWritten cannot supply direct deletion counts because it includes index and trigger effects.

## Decision

Reuse the existing `completed` scheduler event as a receipt. Its detail includes cleanup schemaVersion 1, the expiry cutoff and two `CleanupBatch` objects. The event is written inside the same synchronous transaction as source expiry, candidate revalidation, source deletion and dequeue. No additional scheduler event or storage write is introduced. An exception, including failure to write the completed event, rolls back source/queue progress and prevents publication of its receipt. Earlier probe observations and budget evaluations can already have committed; the cleanup transaction does not undo them.

Each queue's existing selection remains bounded to 32 candidates. A primary-key LEFT JOIN over that bounded selection records whether the source exists. Each guarded source deletion synchronously consumes `RETURNING 1 AS removed`; returned rows count direct source deletions without source keys or note bodies. The existing dequeue statement still runs for examined candidates. The receipt reports:

- `limit: 32` and `examined`, between zero and 32.
- `deleted`: directly deleted source rows.
- `protected`: an existing source retained because a reference was present at revalidation.
- `missing`: a queued source already absent; this does not describe missing monitoring observations.
- `mayRemain`: true exactly when examined equals 32. A full batch can have emptied its queue; this conservative signal avoids another query and is never a measured backlog count.

Deleted, protected and missing sum to examined. These are FIFO candidate counts only. Eager check/note age expiry, removal of every note from an expired resolved parent, cold migration and account quota usage are excluded. Retention bounds, source-reference guards and queue fairness remain those of ADR 006.

## Reading and privacy

Public status and schemaVersion 4 exports project only version counts from their existing latest-20 scheduler query. Supplying a bearer token to either route does not add private note counts. The public disclosure can be unavailable if no completed event lies in that bounded window.

An explicit authenticated `GET /api/ops/audit` adds `lastCleanup`, using one indexed latest-completed-event lookup and including the private orphan-note batch. Aggregate note activity remains private even though no note body or key is returned. No new endpoint, browser polling loop or queue-draining read is added. Expanding a disclosure is local rendering only.

Allowlisted readers validate schema, counts, category sums, timestamps and conservative `mayRemain`. Old completed events, malformed counters and null diagnostics remain unavailable rather than fabricated zeros. A cached receipt keeps its original completion time and slot, and a failed refresh leaves it unconfirmed historical evidence. Reads cannot renew that timestamp, prove continuing cleanup or establish monitoring recovery.

## Validation and cost

`npm run test:retention` exercises actual local workerd/SQLite: batches of 0, 1, 31, 32 and 33; mixed missing/protected/deleted sources; exact32 drained with conservative mayRemain; restored references; and failures after a consumed source deletion and at receipt publication. Source/queue progress and the receipt roll back together. Public status/export privacy, authenticated audit, legacy/malformed diagnostics, read-only behavior, eviction and clock rollback are checked separately from production verification.

`npm run test:retention-cost` uses current tracked source and compares source/public-summary hashes with the pinned 3.4.0 JSON fixture. Its default supports shallow CI without old Git objects. Optional `--baseline` replay requires the pinned commit locally. The [3.4.2 evidence](../evidence/releases/3.4.2-retention-cost.json) records source and bundle hashes and preserves the [3.4.1 archive](../evidence/releases/3.4.1-retention-cost.json).

Across three consecutive cron minutes per profile, steady costs remain 94 reads/40 writes for two targets and 189/82 for five, for both small and grown retained metadata. A full 32-version plus 32-note catch-up costs 476 reads/168 writes or 571/210. Compared with 3.4.1, the counters add 128 reads to that full combined batch with zero added statements or writes. Empty queues retain their prior cost. This is bounded lookup/RETURNING work under controlled fixtures, not total account quota or an unlimited daily capacity claim.

The separate [3.4.2 seven-day monitor fixture](../evidence/releases/3.4.2-monitor-cost.json), run with `npm run test:monitor-cost`, measures complete status views at 162 reads/zero writes for two targets and 369/zero for five. Its steady cron matches the values above. Cold migration, backlog churn, owner traffic, laboratory activity and other account workloads remain additional costs; five targets are not a Free-plan write-capacity guarantee. Both fixtures make zero production requests, account calls and native inference calls. Billing and AI preflight gates remain unchanged, and a cleanup receipt does not establish production recovery.
