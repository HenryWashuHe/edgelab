# Repeated monitoring deliveries: native cost and observation evidence

Measured October 2, 2026, 14:25:36–14:25:42 UTC against the unchanged 3.12.5 application. Four fresh local workerd/SQLite actors cover two and five targets, each with 4,320 seeded good historical minutes per service. The [maintained recipe](../../../scripts/monitor-duplicate-cost.mjs) passes with eight observations, four awaited disposals and all 28 source pins stable. An independent source and meter review found no remaining blocker.

| Targets | Accepted tick                   | SQL statements | Rows read | Rows written | New probes |
| ------- | ------------------------------- | -------------: | --------: | -----------: | ---------: |
| 2       | Ordinary current minute         |             53 |        57 |           32 |          2 |
| 2       | Finished same-slot duplicate    |             39 |        49 |           10 |          0 |
| 2       | Overlapping same-slot duplicate |             41 |        46 |           12 |          0 |
| 5       | Ordinary current minute         |            104 |       107 |           68 |          5 |
| 5       | Finished same-slot duplicate    |             69 |        87 |           13 |          0 |
| 5       | Overlapping same-slot duplicate |             74 |        81 |           18 |          0 |

The overlapping pair together uses 94 statements/107 reads/42 writes for two targets and 178/198/81 for five. These combined intervals subtract only the separately metered diagnostic read. The isolated duplicate intervals run while the original probes are held by a controlled local service binding; no additional probes occur.

Each finished duplicate preserves the saved check's original observation and completion times. During overlap, no current-minute check exists before release; the duplicate still completes its scheduler attempt, evaluates budgets and records cleanup. Readiness is healthy using fresh prior-minute checks. After release, the original tick saves exactly one current-minute check and completed job per service. Completion of an attempt therefore does not mean a new observation.

This measures direct native `MonitorStore /tick` requests with the actual actor implementation. It does not execute the gateway scheduled handler or provider Cron Trigger delivery. The optional fixture clock is never set: all ticks use the actual current minute, with explicit seed/start/completion fences. Setup may wait for the next real minute when less than fifteen seconds remain; this capture needed zero wait in all four profiles. No failed measured case was retried or replaced.

The native meter includes SQLite cursor and trigger/index row accounting. Constructor, schema/enrollment, manual seeding, projection warming and verification reads are excluded. All measured SQL succeeds; failed statements would have unknown cursor cost. Retention queues have no expiry candidates. This does not measure saturated cleanup, crash recovery, policy races, throughput, CPU, billing, account capacity or natural duplicate frequency. A prototype seed exceeded the native SQL variable limit before measurement; that failed setup record remains ignored, and the maintained recipe uses twelve-row batches.

Counts are observations of this workload, rather than fixed regression thresholds. The historical seven-day cost fixture has different expiry inputs: do not add these duplicate counts to it as though the workloads matched. Repeated live scheduler receipts establish repeated invocation handling, not multiple configured cron expressions or a confirmed retry cause. Cloudflare's [Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and [Scheduled Handler documentation](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) do not specify a delivery-count guarantee; the explicit at-least-once guarantee for [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) concerns a different mechanism.

Reproduce with `npm run test:monitor-duplicates`. It uses no account, production, browser, AI or external origin requests. App code, configuration and deployed service remain unchanged. The existing abandoned-lease proof in [monitor-integration.mjs](../../../scripts/monitor-integration.mjs) explains why a completed `duplicate-or-busy` result cannot permanently seal a slot: a later retry after lease expiry can still save its observation.

Frozen [evidence.json](evidence.json): 45,790 bytes, SHA-256 `fdef176a1655866d9fd0d5da170172f8fbc720a01d15c25a4b356e330319656d`. Frozen [verification.log](verification.log): SHA-256 `e335df780b2c58d4070329a77fbf063f7eda26893fbd3606a4f1819a9ffb9d43`. The report's base commit is `40ecede8da952c68421dd66398ce430a1031babc`; exact pins also cover the then-uncommitted maintained recipe and package script. Miniflare and Node versions are recorded; the workerd executable is not independently attested.
