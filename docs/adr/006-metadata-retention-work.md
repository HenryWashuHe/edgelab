# Bound retention work as evidence metadata grows

Status: accepted for EdgeLab 3.4.1. Production recovery and native inference remain separate verification gates.

## Problem

The check projection bounds repeated history reads, but the previous completed-cron cleanup still scanned every captured policy version and private note. Retaining useful metadata therefore increased the cost of an otherwise idle cleanup. Controlled SQLite measurements found 1,440 reads for 720 referenced versions and 200 reads for 100 retained notes. These are per-statement fixtures, not proof of the deployed account's history or the cause of its quota failure.

## Decision

Keep source observations, current policy rows, immutable policy versions and valid private notes authoritative. Replace repeated full-table eligibility scans with two persisted FIFO queues. Every completed cron cleanup examines at most 32 version candidates and 32 orphan-note candidates. This bounds candidate examination per cleanup; retries or overlapping schedule deliveries can still perform additional cleanups. It is not an account-wide daily quota guarantee.

A version becomes a candidate when its last check or current-policy reference disappears, or when an unused version is imported directly. SQL triggers cover check deletion, old-key updates, replacement, service revision/deletion/replacement, and version insertion/key updates. Eligibility includes all retained checks, including legacy timing and maintenance, rather than only samples that qualify for SLO credit. A candidate is deleted only after an indexed recheck confirms that no retained check or current service policy refers to its key. Examined candidates are dequeued even when a reference has returned; losing that restored last reference queues a new candidate.

Note age expiry remains an indexed, eager `at < cutoff` deletion. Before an expired resolved incident is removed, an indexed parent-eligibility query deletes all its notes in the same cleanup transaction, independent of the orphan candidate limit. Parent deletion, parent-ID changes and replacement conflicts queue affected notes using the incident index. Direct note imports and identity/parent changes queue orphan candidates. Cleanup rechecks the current parent before removing a body. Restoring a parent or finishing a staged import therefore preserves valid notes. Deleting a note also removes its queue entry. SQLite replacement can omit implicit DELETE triggers, so narrowly scoped BEFORE INSERT/UPDATE guards capture replacement candidates without changing the database's recursive-trigger setting.

Queue IDs use [SQLite AUTOINCREMENT](https://www.sqlite.org/autoinc.html) and unique source keys. Repeated eligibility events preserve an existing FIFO position. Later arrivals cannot move ahead of already queued work. A fixed backlog of N entries is processed or removed within ceil(N/32) successful cleanup passes, even if later work arrives faster; continued new work can still grow the total backlog. Age-expired notes, notes belonging to expired resolved parents, and observations do not wait for that queue. Unused versions and recent orphan notes can remain physically stored until their candidates are examined; such orphan notes are inaccessible through incident APIs.

## Migration and transaction boundaries

Each helper atomically installs its queue, triggers and versioned marker, then makes one indexed-reference pass over its existing source metadata to discover legacy candidates. Migration queues work without deleting source bodies. Its scan and any queue writes are real startup costs, excluded from warm-operation projections. An unsupported future marker fails rather than silently downgrading it.

Source mutations and their trigger effects share the same SQLite statement/transaction. Completed-cron cleanup keeps expiry, candidate revalidation, deletion and queue progress in its existing synchronous transaction. Failure rolls back queue progress with the corresponding source deletion. Eviction preserves queued work; normal status and incident reads never drain it. Constructor migration can initialize derived metadata on first access, which is distinct from steady read-only behavior.

The helpers do not remove referenced historical policies, add observations, renew observation timestamps, change incident transitions or expose private notes. Frozen brief snapshots and retained warning policy context remain self-contained after unused source rows are eventually removed.

## Evidence and limits

`npm run test:retention` exercises the production helpers in actual workerd/SQLite with controlled source mutations, FIFO pressure, imports/replacements, reference restoration, eviction, migration failures and rollback. Existing incident, schema-upgrade, monitoring, budget and brief suites verify their application contracts independently. Whole-cron measurements must include trigger reads, index/queue writes, metadata growth and expiry; a cheap helper query alone cannot establish deployment capacity.

The [3.4.1 whole-cron comparison](../evidence/releases/3.4.1-retention-cost.json), reproducible with `npm run test:retention-cost`, compares the pinned 3.4.0 implementation with these helpers. For two targets, grown retained metadata changes the baseline from 79 to 3,354 reads, while the new implementation stays at 94 reads and 40 writes for either size. Five targets stay at 189 reads and 82 writes. The source and public-result hashes match. Processing 32 unused versions plus 32 orphan notes costs 348 reads/168 writes with two targets or 443 reads/210 writes with five. Each profile repeats across three consecutive minutes; these are controlled workload measurements, not account-wide production totals.

No source production history is seeded or manually deleted for this verification. Account usage, cold migration, owner traffic, public reads, laboratory traffic, backlog churn and provider retries remain outside an identical-minute workload projection. Five configured targets are still not a Free-plan capacity promise.
