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

## Paired-window sampled-check signals

Version 3.2 adds fixed rule version 1. The thresholds follow the [Google SRE Workbook's 30-day-budget examples](https://sre.google/workbook/alerting-on-slos/), with a short window confirming that elevated long-window burn is still ongoing:

| Rule      | Long window            | Short window          | Trigger in both windows |
| --------- | ---------------------- | --------------------- | ----------------------- |
| Rapid     | 60 minutes             | 5 minutes             | At least 14.4×          |
| Sustained | 360 minutes / 6 hours  | 30 minutes            | At least 6×             |
| Gradual   | 4,320 minutes / 3 days | 360 minutes / 6 hours | At least 1×             |

For each window, burn rate = (verified bad / verified non-maintenance observations) / (1 − current target / 100). The selected 24-hour or 7-day report does not change the fixed signal windows or their 30-day budget basis. This does not assert that a full 30-day operating history has already been collected.

Windows include exactly their fixed number of finished UTC slots, ending at `floor(now / 60,000) − 1`. A slot is verified only when its check has the current revision, a known actual start in that same minute, and a start at or after the current policy's recorded time. Identical duplicate records count once; conflicting records make the slot unknown. Legacy, wrong-revision, incorrectly timed, and missing evidence remain unknown. This stricter signal eligibility is distinct from a report aggregating outcomes under historical revisions.

- Expected = the full window length in minutes.
- Observed = verified good + verified bad, excluding maintenance.
- Unknown = expected − observed − verified maintenance.
- Eligible = expected − verified maintenance.
- Coverage = observed / eligible × 100; an all-maintenance window has null coverage and burn.
- Mature = the entire window begins at or after the first complete minute under the current policy, `ceil(policyRecordedAt / 60,000)`.

EdgeLab's gates require mature long and short windows, at least 95% verified coverage in each, at least 20 non-maintenance observations in the long window, and five in the short window. These coverage, count, and full-policy-window gates are project choices, not canonical Google parameters. Maintenance cannot make sparse observations sufficient: a rapid five-minute window with one maintenance minute has four non-maintenance observations and fails the short-window count gate.

Each rule is `firing` when both qualified windows meet its threshold, `clear` when both qualify but do not both reach it, `insufficient-evidence` when either lacks qualification, and `maintenance` when paused or both windows contain only verified maintenance. Overall state gives any firing rule priority, ordered rapid, sustained, then gradual. Otherwise insufficient evidence takes priority over clear/maintenance. A rapid rule can qualify after its first complete hour while sustained and gradual await six hours and three days; longer-rule immaturity must not hide a rapid warning. Conversely, one qualified clear rule does not establish that every rule has enough evidence.

One bad check among 60 at a 99.9% target yields approximately `(1 / 60) / 0.001 = 16.7×` burn. It can fire the rapid signal if the recent window also qualifies. This is a coarse synthetic-check ratio, not a customer-request error rate, independent geographic measurement, uptime guarantee, or paging policy. Signals do not open/recover consecutive-failure incidents or send external notifications.

### Persisted evidence and freshness

The coordinator computes signal evidence after scheduled probes complete and stores one latest evaluation per service. Public status and schemaVersion 4 exports add `service.budget` with `evaluation`, `evaluationStatus`, and `lastFiring`. Reads never recompute evaluation or renew its `computedAt` timestamp. Status is `not-evaluated` before the first recorded evaluation, `policy-changed` when its revision differs from the current policy, `stale` when its age exceeds 180,000 milliseconds or timing is impossible, and otherwise `current`. The three-minute boundary is inclusive.

Only a current evaluation establishes a present firing or clear result. `lastFiring` retains the selected warning's rule, revision, recorded first firing, last confirmed firing, and paired-window evidence across insufficient observations, maintenance, policy changes, stale scheduling, and later qualified clear evaluations. One retained record is not a full alert history or proof of uninterrupted failure. The interface labels current firing evidence, a previous warning below its trigger, a warning under a previous policy, or a previous warning without confirmed clearance. A same-policy qualified clear result for the prior rule can establish that it was below its trigger at evaluation time; missing or stale data cannot.

Signal records for configured services survive prolonged gaps. Records for removed services become eligible for 30-day pruning. Policy changes restart maturity; retained historical warnings are never rescored as if they occurred under the replacement policy.

## Incident evidence and exports

Public incident lists retain all open incidents for active targets and their latest 100 resolved incidents. Detail pages return up to 50 retained checks in descending slot order, with an exclusive `before` cursor and policy context for that page. The evidence interval includes up to ten minutes before detection and the incident interval, subject to 30-day check retention. A retained open incident can outlive its earliest checks; `limitedByRetention` exposes that limit instead of implying a complete timeline.

Operations export `schemaVersion: 4` contains bounded service history, summaries, incident records, readiness, scheduler diagnostics, and the additive per-service budget evidence. Public exports exclude appended investigation and acknowledgement notes. Authenticated detail includes those private fields. Exported summaries and paginated investigations are not a complete storage backup.

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

Unit tests exercise deterministic state transitions and parsing. Synthetic signal timelines cover alternating failures, isolated recent failure, short-window recovery, inclusive trigger thresholds, 95% coverage boundaries, sparse maintenance, policy maturity, wrong timing/revision, duplicate ambiguity, and empty data. Runtime tests exercise workerd, SQLite transactions, real Durable Object eviction, alarm behavior, service bindings, schedule invocation, and persisted warning retention through gaps and revisions. Live tests verify deployed routing and bindings. Real autonomous scheduled samples prove the cron is operational. None alone proves all the others; CI and release evidence record them separately.
