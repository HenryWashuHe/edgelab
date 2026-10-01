# EdgeLab: repairing a monitoring system's storage cost

EdgeLab is a Cloudflare Workers project that runs scheduled service probes, preserves incident evidence, and evaluates sampled error-budget signals in a SQLite-backed Durable Object. During production verification of version 3.3, monitoring storage exhausted its daily row-read allowance. The repair replaced repeated history scans with a persisted projection derived from authoritative checks and made unavailable monitoring explicit to the operator.

The production failure is confirmed. The SQL-cost improvements below were measured in controlled local workerd fixtures. Separate live verification of release 3.6.0 confirmed autonomous monitoring recovery after the quota reset; no native Workers AI inference was performed.

## What failed and what the evidence establishes

On September 30, 2026, the gateway's liveness endpoint still answered, while monitoring status and readiness returned HTTP 500. A live Worker exception identified exhausted Durable Objects Free-tier row reads. The [verification record](evidence/VALIDATION.md) documents that failed release verification; at that point, the last successful full autonomous monitoring verification was version 3.2.1.

Cloudflare's documented Workers Free SQLite allowance is five million rows read and 100,000 rows written per day. Exceeding a Free limit makes further operations of that type fail until the daily reset at 00:00 UTC. Reads and writes are separate limits shared with other account activity. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

The original budget computation repeatedly scanned up to 4,320 finished checks per target. Dashboard reporting separately scanned history for counts, nearest-rank P95 latency, and hourly groups. Retention and incident-list queries added more work. Small JSON responses concealed those examined rows. Controlled measurements identified expensive query shapes, but do not attribute every production quota unit to an individual query or prove that dashboard traffic alone caused the exhaustion.

## Repair: preserve evidence, reuse derived work

Version 3.3.1 introduced a shared projection containing compact check tuples for at most 10,080 finished UTC slots per service, or seven days. It records the covered interval even where observations are missing. The initial load reads source checks; subsequent advancement appends newly covered observations and drops older projection entries. Budget evaluation selects its original 4,320-slot slice, and dashboard reporting computes the original statistics from the same projection.

The source `checks` table remains authoritative. SQLite insert, update, and delete triggers enqueue covered slots that need repair. This handles a late completion in a previously empty minute, deletion, corrected outcomes or timing, and moves between slots or services. A repair rereads the affected source positions; it cannot invent missing observations. Cache changes and dirty-slot cleanup occur in a storage transaction.

Persistence matters because a Durable Object can be evicted: a warm projection can be reloaded without rescanning its source history. Invalid projection data, an incompatible format, or clock rollback causes a rebuild. A source-schema migration invalidates only derived state. Removing a target prunes its projection separately from source retention. Reads never create probe evidence or refresh scheduler and alert timestamps. The [architecture decision](adr/005-bounded-monitoring-reads.md) records these contracts.

The repair also indexed retention and scheduler lookups. Incident listing now reads bounded resolved history per active service and merges the global latest 100 using stable opened-time/ID ordering, while preserving every active open incident. Private notes remain excluded from public results.

## Measured costs and correctness

The [3.3.1 cache fixture](evidence/releases/3.3.1-check-cache.json) used local workerd through Miniflare, two services with 12,000 synthetic source checks each, and actual consumed `SqlStorageCursor.rowsRead` counters. Cloudflare uses the cursor's final read and write values for SQL billing. [SQL cursor accounting](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

| Controlled operation                                                        | Examined SQLite rows |
| --------------------------------------------------------------------------- | -------------------: |
| Original 4,320-minute budget source scan, one service                       |                4,321 |
| Original seven-day dashboard scans, one service: counts, P95, hourly groups |               50,572 |
| Initial seven-day projection bootstrap                                      |               10,080 |
| Repeated projection read                                                    |                    1 |
| Projection read after actual object eviction                                |                    1 |
| Advance projection by one finished minute                                   |                    4 |
| Repair one covered late completion                                          |                    6 |

These helper measurements exclude the rest of a status request, JavaScript computation, probe writes, constructor/schema work, and other account activity. A one-row projection read still parses bounded stored data; it is not a one-row end-to-end dashboard claim or a CPU/latency benchmark.

The same fixture measured incident-list reads falling from 48,660 to 421, with identical output: 220 active open incidents and the global latest 100 resolved incidents. The baseline temporarily removed the new derived indexes only inside that isolated fixture.

Runtime parity tests compare cached rows and derived metrics with authoritative source SQL. They cover late inserts, updates, deletes, moved slots/services, gaps, source pruning, corrupt projections, clock rollback, migration invalidation, and eviction. Both dashboard windows and budget evaluation also retain parity across maintenance, legacy or invalid observation times, and policy revisions. The [validation record](evidence/VALIDATION.md) separates those runtime tests from live verification.

Reproduce the controlled resource fixtures with `npm run test:check-cache`, `npm run test:monitor-cost`, and `npm run test:retention-cost`. They use isolated local storage and do not query the Cloudflare account.

## Keep retained metadata from growing idle cleanup cost

Version 3.4.1 addresses policy versions and notes that remain useful. A controlled comparison against the pinned 3.4.0 source found two-target cron reads increasing from 79 to 3,354 when each target retained 720 referenced policy versions and 100 valid private notes. Those rows must remain available; removing them to make the test cheaper would change the evidence contract.

The [retention decision](adr/006-metadata-retention-work.md) replaces repeated eligibility scans with persisted FIFO candidate queues. Triggers record lost references and imports, while cleanup rechecks current source references before removing anything. Every completed cleanup examines at most 32 version candidates and 32 orphan-note candidates. Indexed age expiry and atomic deletion of all notes attached to an expired resolved incident remain eager. Runtime tests cover replacement, restored references, migration, eviction, faster new arrivals and transaction rollback.

The [whole-cron comparison](evidence/releases/3.4.1-retention-cost.json) measured 94 reads and 40 writes for both the small and grown two-target fixture across three consecutive minutes. Its five-target counterpart measured 189 reads and 82 writes for both sizes. Public summary and budget hashes matched the baseline, and protected source checks, versions, notes and open incidents stayed unchanged. The new queues add a small fixed idle cost while removing the measured growth dependence.

A backlog of 96 unused versions and 96 orphan notes was processed in three cleanups. Each two-target pass used 348 reads and 168 writes; five-target passes used 443 reads and 210 writes. Queue, trigger, index and AUTOINCREMENT work is included. Migration scans, true expiry, backlog churn and other account activity still consume resources; these fixtures do not establish unlimited capacity or explain every row charged in the production outage.

## Observe committed cleanup without a new scheduler write

Version 3.4.2 adds a receipt to the existing completed scheduler event, in the same transaction as source cleanup and queue progress. A cleanup or final event-write failure cannot leave a successful receipt. Its version and orphan-note batches report examined, deleted, protected and already-missing source rows. Direct source deletions are counted from consumed `DELETE RETURNING 1` output; using rowsWritten would wrongly include queue/index/trigger effects. Bounded primary-key lookups distinguish protection from an absent source without counting whole tables.

Each batch still examines at most 32. `mayRemain` is true for a full batch even when that batch emptied the queue, avoiding another query. Eager age expiry, all notes removed with an expired resolved parent and cold migration are outside the receipt. Public status and exports expose only version counts; authenticated audit adds private note counts through one indexed latest-completed lookup. Legacy/malformed/null receipts remain unavailable, cached timestamps never renew, and expanding a disclosure adds no polling. The [receipt decision](adr/007-committed-cleanup-diagnostics.md) extends [ADR 006](adr/006-metadata-retention-work.md) without changing its retention rules.

The [3.4.2 comparison](evidence/releases/3.4.2-retention-cost.json) repeats the same three-minute profiles and preserves the pinned 3.4.0 source/public-summary hashes. The historical 3.4.1 values above remain unchanged.

| Targets | Steady or grown metadata: reads/writes | Full 32-version + 32-note catch-up: reads/writes |
| ------- | -------------------------------------: | -----------------------------------------------: |
| 2       |                                  94/40 |                                          476/168 |
| 5       |                                 189/82 |                                          571/210 |

The counters add 128 reads to each full combined catch-up batch, with zero extra SQL statements or writes; empty queues and retained metadata growth have unchanged measured steady costs. The [3.4.2 seven-day fixture](evidence/releases/3.4.2-monitor-cost.json) measures 162 reads per complete dashboard view for two targets and 369 for five, with zero view writes and the same steady cron costs. These measurements describe controlled local SQLite work, not total account usage or evidence of production recovery. Native inference calls remain zero.

## Observe lab commits without repeated refreshes

Version 3.5 adds a hibernating WebSocket observer to the existing resilience-lab Durable Object. It shows committed admission, pending work, outcomes and reset revisions in another tab without polling or renewing the run's idle lease. Frames omit cached bodies, request identifiers and capabilities. Transaction failure cannot publish a phantom event, and elapsed deadlines fence late origin work even before a delayed alarm executes.

The [runtime record](evidence/releases/3.5.0-lab-observer.json) verifies original network sockets through forced hibernation and 26 groups of ordering, isolation, quota, rollback and expiry behavior. Its fixed owner workload uses 28 SQL rows read and 16 written with zero, one or four viewers; handshakes and constructor work are measured separately. This is controlled local resource evidence, with no claim of natural production hibernation timing or successful live observation during the quota outage. [ADR 008](adr/008-live-lab-observer.md) records the contract and limits.

## Preserve a coordination trace for offline review

Published 3.6.0 adds bounded in-memory observer recording and `#replay`. Stop freezes a valid captured prefix while live observation can continue, and Download exports at most 256 entries and 192 KiB. Import and stepping make zero application API requests or WebSocket messages, read no capability and execute no experiment. This gives reviewers inspectable evidence when live storage is unavailable.

The [bundled 25-frame capture](../src/data/lab-recording-example.json) comes from real isolated workerd, the production-exporting Durable Object/gateway fixture and the actual private origin Worker. It records concurrent pending admissions, settled results, reset fencing of a late response, original-socket forced hibernation, and circuit failure/recovery. The [separate runtime manifest](evidence/releases/3.6.0-recording-runtime.json) pins source, recipe and bundle hashes. Content hash `ee884cdcefaedcd23c22eed275ec5088852beec2b6dd8ed323381d2cc908a082` identifies this controlled recording; it is not production incident history or native AI output.

Revision gaps remain unobserved, server and recorder clocks remain separate, and the selected prefix reconstructs at most twelve outcomes for its current run. No refill, intermediate decision or later outcome is invented. SHA-256 detects changes to an unsigned file; it cannot authenticate its source, establish causality, provide a whole-run backup or re-execute the experiment. CI passes 136 unit tests across 13 files, and local keyboard/mobile offline inspection makes zero application API requests. The [final-source recheck](evidence/releases/3.6.0-recording-recheck.json) verifies package, producer and actual gateway version agreement; its real timestamps and identifiers produce a different hash without replacing the pinned capture. Live browser capture/download, browser file import and the new production UI remain unverified in the [validation record](evidence/VALIDATION.md). [ADR 009](adr/009-bounded-lab-recordings.md) records the design boundaries.

## Version 3.7.0: reuse views without renewing observations

The persisted check projection reduces repeated history scans, but identical public status requests still materialize the complete view. Version 3.7.0 adds disposable instance reuse before target synchronization. At most the two canonical `24h`/`7d` windows share a 1 MiB serialized UTF-8 envelope cap, including private budget-row revision/time sources used internally for aging; this is not a measured heap bound. A hit requires age below 10,000 ms, the same UTC minute and unchanged configuration/mutation context. Oversized views stay complete and uncached. Eviction loses only memory, while SQLite and the seven-day projection remain authoritative.

The additive `read` provenance discloses `source: "storage" | "memory"`, `materializedAt`, `servedAt`, `ageMs` and `maxAgeMs: 10000`. Response `now` equals delivery time. Source observation, evaluation, warning, incident, scheduler and cleanup times remain unchanged; current service status, budget freshness and readiness age against delivery time. Export, readiness and private evidence bypass reuse; HTTP remains `no-store`. Relevant writes invalidate both entries, including every probe completion after asynchronous origin work. The [design decision](adr/010-bounded-public-status-reuse.md) explains why a tick-boundary-only fence could hide an intervening commit.

A zero-read hit cannot discover a storage outage not yet observed by another monitor operation and can mask it for less than ten seconds. Observed monitor failures clear both views, and a cached success is never an error fallback. The dashboard exposes original UTC materialization and delivery times; authoritative readiness/export reads remain necessary for a fresh storage check. This tradeoff does not add quota or prove upstream health.

The [final-source controlled runtime archive](evidence/releases/3.7.0-status-cache.json), measured at 2026-10-01 01:15:44 UTC, passes 28 proof groups with source hashes stable during the run. It verifies source/export parity, exact freshness aging on a hit, timing/configuration fences, probe/policy/ack interleaving, cleanup/budget invalidation, eviction, combined-byte limits and native SQLite failure rollback. The recipe is `node scripts/status-cache.mjs`.

| Targets | Mature miss/export: SQL statements | Rows read | Rows written | Warm hits: SQL/KV/alarm operations |
| ------- | ---------------------------------: | --------: | -----------: | ---------------------------------: |
| 2       |                                 27 |       158 |            0 |                                  0 |
| 5       |                                 63 |       362 |            0 |                                  0 |

Both reporting windows use those mature miss/export costs. Each profile/window runs 100 concurrent and 100 sequential warm hits, with literally zero SQL attempts, rows read/written, KV calls and alarm operations. The fixture has 10,080 finished slots per target, 9,756 retained checks, a complete latest hour, older gaps/legacy timing/maintenance and twenty scheduler events; no incident participates in baseline profiling. Constructor, enrollment, mature-input bootstrap and eviction are measured separately. The older 162/369 view-read counts above come from a different clock/control fixture; their difference from 158/362 is not a further query optimization.

Native fault proofs execute real SQLite missing-table failures after consumed source operations, verify atomic rollback and sanitized 503 responses, and reject a stale-success fallback. A failed attempt that yields no cursor has unknown row cost rather than an asserted zero. These controlled counters do not measure CPU, account billing, production savings or capacity. [Full implementation CI](https://github.com/HenryWashuHe/edgelab/actions/runs/36800527533) passes 154 unit tests and runtime regressions. The published 3.6.0 recovery and recording remain separate evidence.

Version 3.7.0 is deployed as gateway `1b60639f-12f2-41f0-9761-7313a72144e3` from implementation commit `565ea3504eadfd0b85e682ddf5922dfb0454bc17`, with the private origin unchanged. [Live HTTP verification](evidence/releases/3.7.0-live-monitoring.json) began at 2026-10-01 01:37:43 UTC and passed at 01:39:44 UTC: two new autonomous good minutes per service, healthy readiness, current budget evaluations and schemaVersion 4/authentication/privacy boundaries. Both windows showed memory reuse with unchanged original materialization/observations and storage-source exports. The deployed asset hashes matched the final build. This establishes the deployed behavior at that time, without production SQL/CPU/billing measurements or rendered browser validation.

## A separate write limit remains

The historical [3.3.2 whole-monitor fixture](evidence/releases/3.3.2-monitor-cost.json) rechecked three consecutive warm cron minutes against synthetic seven-day history. It includes trigger/index work, one check/job per target, and two scheduler events expiring each minute. Its read counts predate the retention queues; the 3.4.1 comparison above records their additional work.

| Targets | Reads per cron minute | Writes per cron minute | Projected writes per 1,440 minutes | Reads per complete dashboard view |
| ------- | --------------------: | ---------------------: | ---------------------------------: | --------------------------------: |
| 2       |                    79 |                     40 |                             57,600 |                               160 |
| 5       |                   168 |                     82 |                            118,080 |                               364 |

Both dashboard windows used the listed view cost and zero writes in that fixture. The measured two-target cron shape fits below the documented daily write allowance before other activity; the five-target shape exceeds it. The configured five-target maximum is therefore not a Free-plan capacity guarantee. These projections are arithmetic over a controlled workload, not measured production daily totals. Owner actions, lab traffic, incident churn, initial migrations, and other applications need their own allowance.

Version 3.3.2 also bounds a different storage source: brief creation, including deterministic records that never call AI. Its [local admission evidence](evidence/releases/3.3.2-brief-admission.json) verifies independent daily, retained-count, and record-byte limits, persisted reservations, and transactional rollback. The [offline evaluation report](evidence/releases/3.3.2-brief-evaluation.json) exercises real capture and validation with canned provider responses; it establishes neither native model compatibility nor model quality.

## Verify before declaring recovery

The deployed [3.3.1 boundary check](evidence/releases/3.3.1-storage-boundary.json) verified sanitized JSON 503 responses for unavailable status, readiness, and export, with authentication still taking precedence. Gateway liveness did not imply working monitoring. A [local browser fixture](evidence/releases/3.3.1-browser-backoff.json) observed no automatic status request for approximately 128 seconds after a recognized quota failure; displayed evidence continued aging and became unconfirmed.

The archived boundary check was taken at 07:11 UTC on September 30 and reported the next daily reset as October 1, 00:00 UTC. Recovery requires genuinely new autonomous checks, their actual start minutes and policy revisions, fresh scheduler completion and budget evaluations, and consistent readiness, status and export. Cached old evidence, a successful deployment, or a manual scheduler invocation cannot complete that verification. No production history was seeded, and no paid-plan change or native inference is part of the evidence here.

That reset was September 30, 2026 at 8pm Eastern Daylight Time. The [3.6.0 live verification](evidence/releases/3.6.0-live-monitoring.json) began at 2026-10-01 00:44:20 UTC and passed at 00:46:21 UTC: both services recorded two distinct new autonomous good minutes after verification began, readiness was healthy, budget evaluations were current and schemaVersion 4 public/private boundaries held. Gateway deployment `fe4a90e7-67f6-4a93-a62f-e799bd6d570f` uses source commit `3b0851c3b2c3e8b4ad5892be9bfb933215de7dc0`, whose [CI run](https://github.com/HenryWashuHe/edgelab/actions/runs/36797743493) passes; the private origin was unchanged. This confirms monitoring recovery at that time, not a long uptime history or a measured account-wide quota reduction. Native calls remain zero, inference is disabled and account entitlement is unverified.

## Version 3.8.0: make runtime evidence inspectable

Architecture presents the pinned 3.7.0 status-cache proof with native selectors for target count and reporting window. A strict artifact hash and allowlisted projection preserve the measured request counts, source times, unknown failed-attempt costs and runtime provenance. Selecting a workload makes no application API calls. Eight tests verify exact artifact parity, supported selections, immutable data, native fault values and the client dependency boundary; the complete backend archive is not bundled.

The [3.8.0 lab workload record](evidence/releases/3.8.0-lab-storm.json) separately measures the actual gateway, native SQLite coordinator and private origin Worker. Eight circuit-denied requests make no origin calls but consume 64 SQL rows read and 32 written, plus lease/alarm work. Repeated state reads and fresh capabilities also incur object work. The origin bucket is therefore insufficient as a storage perimeter. Full project-local build-input hashes remain stable across the test, and actual eviction preserves complete persisted source hashes. These are local measurements, not a production-cost or exact global-budget claim.

Gateway deployment `1defd512-1403-4e77-aee2-2d0caa9adefe` uses implementation commit `08fae9921f7d783b584c5757cf31ca9071e68d38`. The [full CI](https://github.com/HenryWashuHe/edgelab/actions/runs/36803822857) passes 162 unit tests and runtime regressions. [Live HTTP verification](evidence/releases/3.8.0-live-monitoring.json) at October 1, 02:07:52 UTC confirms deployed asset identity, two new autonomous good minutes per service, readiness and privacy/provenance boundaries. Rendered browser behavior remains unverified.

## Resume bullets supported by this evidence

- Built a hibernating WebSocket observer on Cloudflare Durable Objects with committed revisions, bounded privacy projections and deadline fencing; 26 actual workerd proof groups cover original-socket eviction recovery, ordering, rollback and expiry, with unchanged SQL work for one or four viewers in a controlled workload.
- Captured and validated a 25-frame real local Worker coordination trace through concurrent admission, reset fencing and original-socket hibernation; added bounded offline inspection with zero application API calls or command execution.
- Implemented a persisted seven-day Cloudflare Durable Objects check projection with source-change repair and eviction recovery; a controlled local workerd fixture measured one SQLite row per repeated projection read versus 4,321 for the original budget source scan, with source-parity tests.
- Reworked incident-history queries to preserve all active open incidents and the latest 100 resolved incidents; a controlled local SQLite fixture reduced examined rows from 48,660 to 421 while returning the same 320 incidents.
- Implemented persisted, reference-aware retention queues in Cloudflare Durable Objects; a controlled two-target cron fixture reduced reads from 3,354 to 94 with grown policy/note history, preserving source evidence and public summary hashes across cleanup and rollback tests.
- Shipped bounded public-view reuse on Cloudflare Durable Objects with explicit provenance and authoritative bypasses; local workerd tests measured zero SQL/KV/alarm operations across 100 concurrent and 100 sequential warm requests per reporting window, with live HTTP verification of deployed reuse.
