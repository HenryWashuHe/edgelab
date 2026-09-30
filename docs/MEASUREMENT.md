# Measurement and reproducibility

## Monitoring SLI

A check is good only when HTTP status is 200, the response body satisfies the configured JSON contract within 16 KB, and full body consumption finishes within the latency objective. It is bad for HTTP failure, network failure, invalid body, timeout, or excessive latency. Maintenance records are a separate category and make no network request.

The scheduled slot is a UTC minute, not an observation timestamp. Only a tick for the current minute can start a check. A delayed tick is recorded as `skipped-late` without probes or historical observations. The worker rechecks the minute before starting each probe. A check started in its correct minute may finish in the next minute: `observedAt` is the actual probe start, `at` is completion, and `slot` remains the starting minute. Completion time never relabels current evidence as an earlier scheduled observation.

[Cloudflare's cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/) describes UTC execution and up to 15 minutes for trigger changes to propagate. That configuration propagation delay is distinct from the timing of an individual invocation; neither permits historical backfill in EdgeLab.

Reports use finished UTC minutes: from the later of the reporting-window start and the first complete minute after enrollment, through the minute before the snapshot. The current minute can appear in recent history but is excluded from aggregates until it finishes.

- Verified observations are retained checks with a known actual `observedAt` start timestamp.
- Eligible minutes = expected minutes − verified maintenance minutes.
- Coverage = verified good + bad checks / eligible minutes.
- Missing = expected minutes − all recorded checks (including maintenance).
- Unverified = recorded legacy checks with `observedAt: null`; these are separate from missing rows.
- Good-check ratio = verified good / verified non-maintenance observations.
- Allowed bad observations = verified non-maintenance observations × (1 − current objective / 100).
- Error budget consumed = verified bad / allowed bad observations × 100.
- P95 = nearest-rank 95th percentile of verified non-maintenance probe durations, including failures.

Zero verified observations produce null ratios, budget, and percentiles. Missing and unverified data never become successful observation credit. Legacy maintenance rows cannot reduce the eligible denominator. Coverage qualifies the SLO; a 100% good-check ratio at 20% coverage is weak evidence. A report for a finished minute can acquire a valid result when a probe started in that minute completes later; snapshots are observations at their stated snapshot time.

New observations retain their policy revision, with the policy, assertion, transport, and service name captured for that version. Incident evidence pages include context for the revisions used by their checks. Newly captured versions have `recorded` provenance. Migration can preserve the currently stored v3 policy as `recovered-current`; it cannot recreate older policies or prove when that recovered context was first applied. A missing historical version remains unknown. Historical outcomes are not rescored by the current policy, while the budget calculation uses the current target. Migrated observations with unknown actual start time are preserved but excluded from verified SLO calculations.

A probe samples one coordinator's network path. It is neither customer-request availability nor geographically independent monitoring. Scheduled checks can miss short outages. Incident timestamps are observation-driven, and the provider dependency is shared with monitored services.

## Monitoring freshness

`GET /api/ready` returns 200 only for healthy monitoring readiness; `starting`, `partial`, and `stalled` return 503. A scheduler completion and each active service's latest current-revision observation start must be no more than three minutes old, inclusive. Invalid or future scheduler timestamps are stalled evidence. Missing, stale, or impossible active-service observations make a fresh scheduler partial. Paused services are excluded. When all services are paused, a fresh scheduler is healthy with an explicit pause reason.

The clock advances on a read, but the persisted heartbeat does not. Dashboard activity cannot keep a stopped scheduler healthy. The latest 20 scheduler diagnostics expose persisted events; they are not independent uptime observations. Fresh failed upstream probes can produce healthy monitoring readiness: this signal describes whether monitoring is operating, not whether monitored services are successful. Same-provider readiness still needs an independent observer to detect correlated provider failure.

## Incident evidence and exports

Public incident lists retain all open incidents for active targets and their latest 100 resolved incidents. Detail pages return up to 50 retained checks in descending slot order, with an exclusive `before` cursor and policy context for that page. The evidence interval includes up to ten minutes before detection and the incident interval, subject to 30-day check retention. A retained open incident can outlive its earliest checks; `limitedByRetention` exposes that limit instead of implying a complete timeline.

Operations export `schemaVersion: 4` contains bounded service history, summaries, incident records, readiness, and scheduler diagnostics. Public exports exclude appended investigation and acknowledgement notes. Authenticated detail includes those private fields. Exported summaries and paginated investigations are not a complete storage backup.

## Concurrency benchmark

Run against a server you own:

```sh
BASE_URL=http://localhost:8787 ROUNDS=3 npm run benchmark
# Or your deployed URL, which writes benchmark-live.json:
BASE_URL=https://YOUR-WORKER.workers.dev ROUNDS=3 npm run benchmark
```

The script creates a random, isolated lab per trial. It configures capacity 12, refill 1 token/second, a 250 ms controlled origin delay, and a 1,000 ms timeout. It launches bursts of 1, 12, 24, and 48 requests, three trials each by default. Each event is recorded at the real gateway and SQLite coordinator; the origin Worker uses a real service binding.

Assertions verify all responses are expected, no request disappears from counters, and admissions stay below capacity plus the maximum possible refill across the measured wall time. The script records client p50/p95 including response body reading, observed origin calls, accepted/rejected counts, timestamp, Node version, endpoint, and methodology. Runtime tests separately cover the circuit, cache, concurrency, and reset invariants.

The local results are in [benchmark-local.json](evidence/benchmark-local.json); deployed results, when collected, are in [benchmark-live.json](evidence/benchmark-live.json). Lower rejection latency is not faster origin performance. Do not average rejected requests into an origin-latency claim. These short bursts do not establish sustained throughput, internet-wide latency, or production capacity.

## Evidence hierarchy

Unit tests exercise deterministic state transitions and parsing. Runtime tests exercise workerd, SQLite transactions, real Durable Object eviction, alarm behavior, service bindings, and schedule invocation. Live tests verify deployed routing and bindings. Real autonomous scheduled samples prove the cron is operational. None alone proves all the others; CI and release evidence record them separately.
