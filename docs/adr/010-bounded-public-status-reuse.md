# Bound public status reuse and expose materialization age

Status: accepted in EdgeLab 3.7.0. [Actual-runtime verification](../evidence/releases/3.7.0-status-cache.json) passes 28 proof groups against stable source hashes. [Live HTTP verification](../evidence/releases/3.7.0-live-monitoring.json) confirms response provenance, authoritative exports, deployed asset identity and two new autonomous good minutes per service. Browser rendering and production cost remain unverified.

## Problem

Browser request coalescing protects one tab, but every public monitoring view still synchronizes targets and assembles the SQL-backed snapshot. The controlled 3.4.2 fixture examines 162 rows for two targets or 369 for five per complete status view. Multiple viewers can repeat that work without any new source evidence. The daily quota incident makes this a practical remaining cost boundary.

[Cloudflare documents instance-owned memory](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/) as a way to reuse values without further storage calls. Eviction discards that memory. SQLite remains authoritative; reusable reporting data must be disposable and never acquire new observation credit.

## Decision

Reuse only the public status view in the existing MonitorStore instance. Retain at most the two canonical `24h` and `7d` windows and at most 1 MiB of combined serialized UTF-8 data, including the private projection envelope. This bounds retained serialized content, not measured JavaScript heap consumption. Oversized responses remain complete and uncached. Query-string variations must not create new cache entries.

An entry is valid only at a nonnegative age strictly below 10,000 ms, in the same UTC minute, with unchanged deployment configuration and mutation generation. The lookup precedes target synchronization and executes zero SQL, KV or alarm calls. Eviction, invalid/backward clocks, configuration changes and observed monitor-storage failures clear the retained entries. A UTC-minute change makes both entries ineligible for reuse; each stale entry is removed when accessed or replaced. No schema, persistent counter, timer or extra source write is added.

Public responses retain no-store/nosniff and add `read: { source, materializedAt, servedAt, ageMs, maxAgeMs }`. Source is `storage` or `memory`. `now` is delivery time; materialization time never renews on a hit. Preserve observation, policy, evaluation, warning, incident, scheduler and cleanup times. Project service status, budget evaluation freshness and monitoring readiness against delivery time. Within the keyed UTC minute, reporting-window counts and bounds retain their source meaning.

Budget projection must preserve the SQL row's revision and computation time in a private envelope. Reusing the decoded evaluation's corresponding fields would change the existing freshness contract when those values differ. No private envelope fields, target URLs, credentials or notes enter public output.

Use a distinct internal export route so public exports remain authoritative. `/ready`, incident detail, audit and brief routes also bypass this reuse. Browser disclosure adds no request or new polling behavior; the existing client evidence-aging rules still apply.

## Commit and failure boundaries

Invalidate after target changes, started/skipped scheduler events, each successful probe completion, persisted budget evaluations, completed retention/cleanup publication, policy changes and acknowledgements. Invalidation only at the beginning/end of a tick is insufficient: another request can populate a view while a probe awaits the origin. Its later commit must invalidate that intervening view. Transaction rollback must not publish phantom source changes.

Thrown storage failures immediately clear both entries. Conservatively clear on returned server failures as well, including private operations. Never use a retained success as an error fallback.

A zero-read hit cannot detect a storage outage that no operation has observed yet. It can reuse earlier materialized evidence for less than ten seconds. Disclose that age; projected healthy monitoring describes recent scheduler/probe evidence and is not a fresh storage check. The independent authoritative readiness endpoint remains available. This tradeoff is part of the contract, not a claim that caching prevents account exhaustion.

## Validation gates

- Actual workerd/SQLite fixtures compare source-derived public output and authoritative exports for both windows, with private sentinel exclusion.
- Two/five-target runs measure constructor/bootstrap, misses, eviction rebuilds, and 100 concurrent/repeated hits separately. Hits must perform literally zero consumed SQL statements/rows/writes, KV operations and alarm work. Private/ready/export reads must still execute their authoritative paths.
- Real policy/acknowledgement/probe commits invalidate a warmed view. A held probe permits an intervening status read, then its completion updates latest state immediately. Later budget and completed cleanup publication cannot remain hidden.
- Exact 180,000/180,001 ms freshness boundaries age service, budget and readiness on a hit without renewing source timestamps or reading storage.
- TTL, minute boundaries, backward/invalid clocks, oversized content, both windows and arbitrary query variations preserve correctness and bounds.
- Executed native SQL failures and transactional rollback after warming return the existing sanitized failure boundary, with no phantom state or stale-success fallback. Old-revision probe fencing remains intact.
- The fixture uses an in-memory clock during measured operations. Test-only SQL clock reads must not be hidden in a zero-operation claim. [Cloudflare's cursor accounting](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) is inspected after consuming the real cursor.

The gates pass in the pinned two/five-target fixture. Each window/profile executes 100 concurrent and 100 sequential warm reads with zero attempted/consumed SQL, KV or alarm operations. Mature misses/exports use 158 or 362 rows read, with a memory clock; the older 162/369 fixture includes separate SQL clock overhead. Neither result measures production billing, CPU or account capacity. Retain the separate cron write-limit and account-capacity caveats.
