# Share a persisted projection of finished monitoring checks

Status: accepted in EdgeLab 3.3.1. Production recovery after the shared daily quota reset remains pending.

## Problem

Live verification of 3.3 found an exhausted Free-plan Durable Objects row-read allowance. Monitoring storage threw an exception, while gateway liveness still answered. Repeated burn evaluation scanned 4,320 source checks per service per minute. Dashboard views added three scans for counts, P95 latency and hourly history. Correct metrics alone did not make that workload sustainable.

Cloudflare counts examined rows, including index work, rather than just returned JSON rows. Current Free limits are five million reads and 100,000 writes per day, shared across account activity and reset at midnight UTC. Changing a query to return fewer aggregate rows would not eliminate the underlying scans. [Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [SQL cursor accounting](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Decision

Persist a bounded seven-day projection per service as compact tuples. Its covered UTC slot interval includes gaps, with at most 10,080 finished slots. Initial construction reads authoritative source checks once. Advancing a minute appends only newly covered observations and discards older projection entries. Repeated reads and eviction reload one projection row. Corrupt metadata, an incompatible format or clock rollback rebuilds from source.

SQLite triggers enqueue changed covered slots for repair. Insertions into a previously missing slot, updates, deletion, and changes to a service or slot repair both old and new positions. Source checks remain authoritative and retain their original timing and policy history. Source schema migration invalidates the projection atomically with the legacy timing reset. Removing a target prunes its derived projection without deleting its source history.

Budget evaluation filters the shared projection to its original 4,320-slot maximum and runs the unchanged evaluator. Dashboard metrics compute the same counts, nearest-rank P95 and hourly groups over the selected finished window. Actual-source SQL parity is tested for both reporting windows, mixed outcomes, maintenance, legacy starts, invalid timing, policy changes, corrected evidence, pruning and eviction. Reads never create a check, recalculate an alert, or renew an evidence timestamp.

Index cleanup and active scheduler lookups. Resolve incident history per active service with a bounded latest-100 query, then merge the global latest 100 using stable opened-time/ID order. Preserve every active open incident.

## Failure and browser behavior

Catch storage exceptions at the gateway. Return sanitized JSON 503 with `monitor-storage-unavailable`, a fixed reason, and a next-midnight time only for a recognized daily row-limit exception. Keep gateway liveness separate from monitor readiness. Successful evidence and structured provider failures pass through unchanged. An isolate-local 60-second cooldown reduces repeated connections to a quota-exhausted object; it does not enforce a global quota. Authentication, Origin, method and body validation precede the forwarding boundary.

Visible dashboard polling uses a 60-second cadence and coalesces reads. Local evidence age still advances every 15 seconds. Mutation follow-ups force a new read, while audit-only actions do not reread the public dashboard. Server Date and reset time drive known-quota automatic backoff; explicit refresh stays available. Cached observations become unconfirmed and continue aging, and an initial failure cannot assert healthy services or zero incidents.

## Evidence and limits

Actual workerd cursor measurements are archived with the release. A repeated/evicted cache read examined one row; a one-minute append examined four; a covered late completion repair examined six. A controlled incident list dropped from 48,660 examined rows to 421 with identical output. Whole-monitor measurements include trigger and indexed write work. For two targets, the measured warm cron with steady retention used 78 reads and 40 writes; a dashboard view used 160 reads and no writes. Multiplying that cron shape by 1,440 minutes gives 57,600 writes/day. Five targets measured 118,080 writes/day, exceeding the Free write allowance, so the configured five-target maximum is not a Free-plan capacity claim.

These controlled measurements exclude other account applications, variable owner/lab traffic, large initial index migrations and arbitrary incident churn. They do not establish throughput, CPU limits, uptime or future provider pricing. The exhausted allowance cannot be restored by rollback or by deleting evidence; production recovery requires fresh autonomous checks after the reset.
