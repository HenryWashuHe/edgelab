# Preserve observation time and incident evidence

Status: accepted for EdgeLab 3.1.

## Problem

A delayed scheduled handler can probe the origin now and assign its result to a past minute. Replaying several delayed events in seconds can falsely complete a consecutive-failure or recovery streak and fill historical coverage gaps. A successful HTTP health response also says nothing about whether cron is still observing services.

Incident investigations need the original evaluation policy. A revision number in a check is insufficient when the only full policy is mutable. An incident list limited before selecting open incidents can also hide an unresolved incident behind newer recovered ones.

## Decision

Accept a scheduled minute only while it equals the current UTC minute. Skip older deliveries, preserve the gap, and persist the scheduling reason. Check the minute again immediately before claiming a probe. Persist its actual start time separately from completion time. A probe may finish in the next minute without moving its observation start. Cloudflare documents UTC cron execution and deployment propagation; treating delayed observations as gaps is our measurement choice, not a platform delivery guarantee. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

The additive SQLite upgrade preserves old checks with unknown start time. Reset both streak counters and their last-slot marker atomically with the new column; preserve open incidents. Legacy observations remain investigable but receive no verified metric credit. Capture immutable policy versions on creation and change. Preserve a migrated current policy with explicit recovered provenance; leave unavailable earlier versions unknown.

Persist scheduler start/completion evidence separately from checks. Readiness requires a completed run and a current-policy observation for every active service within three minutes. Paused services are excluded. Public reads only age this evidence. HTTP 503 identifies absent, partial, or stalled monitoring; it does not classify origin health. Same-provider readiness cannot independently detect a total provider outage.

Return every active open incident, plus the latest 100 active resolved incidents. Public investigation pages use descending exclusive slot cursors and contain 50 checks, their policy versions, and lifecycle timestamps. Private notes require operator authentication, remain separate from public evidence, and use a client-generated UUID for idempotent retries. Recovery remains automated by checks. Notes can be appended after recovery.

## Consequences and validation

Missed observations remain unknown even when the origin is healthy now. Tight timing admission can reduce coverage when scheduling is late, making the uncertainty visible. Legacy data does not retrospectively become trustworthy. Evidence older than retention has explicit limits, and public reports are bounded summaries rather than backups.

Actual workerd/SQLite tests cover a controlled clock, delayed schedules, optimistic policy fencing, persisted leases, private note concurrency, seek pagination under insertion, old open incidents surrounded by more than 100 newer records, eviction, retention, and a v3-shaped database upgrade. The test-only clock is a subclass in a separate bundle; production contains no clock override endpoint.
