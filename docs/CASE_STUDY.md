# EdgeLab: repairing a monitoring system's storage cost

EdgeLab is a Cloudflare Workers project that runs scheduled service probes, preserves incident evidence, and evaluates sampled error-budget signals in a SQLite-backed Durable Object. During production verification of version 3.3, monitoring storage exhausted its daily row-read allowance. The repair replaced repeated history scans with a persisted projection derived from authoritative checks and made unavailable monitoring explicit to the operator.

The production failure is confirmed. The SQL-cost improvements below were measured in controlled local workerd fixtures. Successful production recovery remains pending in the archived evidence; no native Workers AI inference was performed.

## What failed and what the evidence establishes

On September 30, 2026, the gateway's liveness endpoint still answered, while monitoring status and readiness returned HTTP 500. A live Worker exception identified exhausted Durable Objects Free-tier row reads. The [verification record](evidence/VALIDATION.md) documents that failed release verification; the last successful full autonomous monitoring verification remains version 3.2.1.

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

Reproduce the controlled resource fixtures with `npm run test:check-cache` and `npm run test:monitor-cost`. They use isolated local storage and do not query the Cloudflare account.

## A separate write limit remains

The [3.3.2 whole-monitor fixture](evidence/releases/3.3.2-monitor-cost.json) rechecked three consecutive warm cron minutes against synthetic seven-day history. It includes trigger/index work, one check/job per target, and two scheduler events expiring each minute.

| Targets | Reads per cron minute | Writes per cron minute | Projected writes per 1,440 minutes | Reads per complete dashboard view |
| ------- | --------------------: | ---------------------: | ---------------------------------: | --------------------------------: |
| 2       |                    79 |                     40 |                             57,600 |                               160 |
| 5       |                   168 |                     82 |                            118,080 |                               364 |

Both dashboard windows used the listed view cost and zero writes in that fixture. The measured two-target cron shape fits below the documented daily write allowance before other activity; the five-target shape exceeds it. The configured five-target maximum is therefore not a Free-plan capacity guarantee. These projections are arithmetic over a controlled workload, not measured production daily totals. Owner actions, lab traffic, incident churn, initial migrations, and other applications need their own allowance.

Version 3.3.2 also bounds a different storage source: brief creation, including deterministic records that never call AI. Its [local admission evidence](evidence/releases/3.3.2-brief-admission.json) verifies independent daily, retained-count, and record-byte limits, persisted reservations, and transactional rollback. The [offline evaluation report](evidence/releases/3.3.2-brief-evaluation.json) exercises real capture and validation with canned provider responses; it establishes neither native model compatibility nor model quality.

## Verify before declaring recovery

The deployed [3.3.1 boundary check](evidence/releases/3.3.1-storage-boundary.json) verified sanitized JSON 503 responses for unavailable status, readiness, and export, with authentication still taking precedence. Gateway liveness did not imply working monitoring. A [local browser fixture](evidence/releases/3.3.1-browser-backoff.json) observed no automatic status request for approximately 128 seconds after a recognized quota failure; displayed evidence continued aging and became unconfirmed.

The archived boundary check was taken at 07:11 UTC on September 30 and reported the next daily reset as October 1, 00:00 UTC. Recovery must be checked after that reset: observe genuinely new autonomous checks, verify their actual start minutes and policy revisions, confirm fresh scheduler completion and budget evaluations, and reconcile readiness, status, and export. Cached old evidence, a successful deployment, or a manual scheduler invocation cannot complete that verification. No production history was seeded, and no paid-plan change or native inference is part of the evidence here.

## Resume bullets supported by this evidence

- Implemented a persisted seven-day Cloudflare Durable Objects check projection with source-change repair and eviction recovery; a controlled local workerd fixture measured one SQLite row per repeated projection read versus 4,321 for the original budget source scan, with source-parity tests.
- Reworked incident-history queries to preserve all active open incidents and the latest 100 resolved incidents; a controlled local SQLite fixture reduced examined rows from 48,660 to 421 while returning the same 320 incidents.
