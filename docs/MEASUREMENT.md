# Measurement and reproducibility

## Monitoring SLI

A check is good only when HTTP status is 200, the response body satisfies the configured JSON contract within 16 KB, and full body consumption finishes within the latency objective. It is bad for HTTP failure, network failure, invalid body, timeout, or excessive latency. Maintenance records are a separate category and make no network request.

Reports use finished UTC minutes: from the later of the reporting-window start and the first complete minute after enrollment, through the minute before the snapshot. The current minute can appear in recent history but is excluded from aggregates until it finishes.

- Eligible minutes = expected minutes − recorded maintenance minutes.
- Coverage = observed good + bad checks / eligible minutes.
- Missing = expected minutes − all recorded checks (including maintenance).
- Good-check ratio = good / observed checks.
- Allowed bad observations = observed checks × (1 − current objective / 100).
- Error budget consumed = bad / allowed bad observations × 100.
- P95 = nearest-rank 95th percentile of non-maintenance observed probe durations, including failures.

Zero observations produce null metrics. Missing data never becomes successful observation credit. Coverage qualifies the SLO; a 100% good-check ratio at 20% coverage is weak evidence. Policy versions are stored with observations. Historical outcomes are evaluated using the historical policy, while budget uses the current target. The UI displays this distinction.

A probe samples one coordinator's network path. It is neither customer-request availability nor geographically independent monitoring. Scheduled checks can miss short outages. Incident timestamps are observation-driven, and the provider dependency is shared with monitored services.

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
