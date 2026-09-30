# Verification record

## EdgeLab 3.2.1

Gateway deployment: `4f4abd2e-7004-466a-aaf2-577f2201b417`. The private origin implementation was unchanged.

Formatting, 73 unit tests, strict TypeScript, the production build, and both Worker dry-run bundles passed. The monitoring, incident, schema-upgrade, and original lab lifecycle runtime suites passed. Ten actual workerd/SQLite budget groups plus a pre-storage metadata guard cover retained policy context, legacy null context, target/assertion/objective replacement, 31-day source-record pruning, and persistence across eviction, alongside the existing signal invariants.

Browser tests used an isolated real Worker/SQLite fixture and a separate local fault proxy. A policy write committed and displayed its new revision while a failed audit read was reported separately. A note response was lost after the real commit; closing and reopening the investigation preserved the exact note and request ID. Retrying returned the already-recorded result, with two requests producing one additional persisted row. A concurrent acknowledgement preserved the later operator's unrecorded draft and accurately described the race. A real HTTP 409 preserved a policy draft; refreshing showed the newer saved revision and required explicit review before rebasing. Delayed private reads were aborted on Lock. A delayed committed write arriving after Lock could not restore private state or overwrite the locked notice. Earlier request timeouts and successes could not close, clear, or attach errors to a newer dialog. Retained warning details showed the original v3 timing objectives after the current policy had advanced to v8. Production history was not seeded for these tests.

After status refreshes failed for over three minutes, cached browser evidence expired while the actual upstream readiness endpoint still returned healthy. The UI stated that current monitoring could not be confirmed, instead of claiming the server scheduler had stalled. The deployed original resilience lab also passed its real HTTP integration checks in an isolated disposable session.

The [3.2.1 release evidence](releases/3.2.1-live-monitoring.json) records two new autonomous good observations per deployed service after verification began, with correct observation-start minutes, fresh persisted budget evaluations, healthy readiness, schema-4 export, and operator authentication/privacy checks. No manual scheduler endpoint was used for production verification.

## EdgeLab 3.2

Gateway deployment: `71751324-800c-40d7-aaa3-adaf5535c334`. The private origin implementation was unchanged.

Strict TypeScript, production build, formatting, and both Worker dry-run bundles passed, with 73 unit tests. Eight actual workerd/SQLite budget groups cover intermittent failures without an incident streak, warning evidence across eviction, unknown observations, qualified recovery, rule changes, stale evidence, policy generations, maintenance, and retention. Existing monitoring, incident, and migration suites also passed after integration.

Browser verification used actual local gateway/SQLite fixtures and a separate local proxy injecting HTTP 503 only for status refreshes. A fresh rapid signal showed 500× long-window and 600× short-window burn at full coverage. Keyboard disclosure revealed reconciled counts. After three minutes without successful refreshes, the cached monitor became stalled, the signal became stale, and retained firing was explicitly unconfirmed. Switching away and back could not renew evidence age. Mobile evidence stayed within the document and scrolled horizontally within its accessible table region. Production was not used for these failure fixtures.

The [3.2 release evidence](releases/3.2.0-live-monitoring.json) records new autonomous observations and persisted budget evaluations for both deployed services, with finished-minute window bounds and reconciled counts. Readiness, export format, authentication, and privacy are checked. Signals with immature long windows remain insufficient, independently of shorter qualified rules.

## EdgeLab 3.1

Gateway deployment: `4ab32ee0-dc19-484d-812b-5595b60a3156`. The private origin implementation was unchanged. Public URL: [EdgeLab](https://edgelab-reliability.edgelab-henrywashuhe.workers.dev).

Verified locally with strict TypeScript, production Vite build, Prettier, both Wrangler dry-run bundles, and 58 passing unit tests. Actual workerd/SQLite suites cover controlled-clock scheduling, missing and stale readiness, concurrent probe retries, policy/lease fencing, incident pagination, private-note retries, retention, eviction, and a persisted v3 schema upgrade. The original resilience lab's lifecycle suite also passed.

Browser verification used an isolated real Worker/SQLite fixture, including 71 observations and policy history. Verified keyboard opening, Escape and focus restoration, 50-to-71-row pagination, unavailable historical policies, private note submission, loss of private access after reload, bounded evidence-table scrolling, mobile layout without document overflow, and no browser errors. These incident fixtures were never inserted into production.

Production verification uses the [3.1 release evidence](releases/3.1.0-live-monitoring.json) for two new autonomous good observations per service, observation-start/minute agreement, healthy monitor readiness, schema-4 export, operator authentication, and public privacy. No manual scheduler endpoint is invoked. The production HTTP integration suite separately passed origin/cached-payload recovery, timeout, 24-request concurrency and isolation, input validation, reset fencing, and bounded history in a disposable lab session.

Migration deliberately preserves old observations as unverified, excludes them from verified reliability metrics, and resets streaks while retaining open incidents. Reliability ratios therefore start with new timed observations; the preserved legacy rows do not acquire retrospective credit.

## EdgeLab 3.0

Release verification performed 2026-09-29 UTC. This is evidence of a newly deployed application, not a long-term reliability claim.

This record predates the stricter observation-time model. Version 3.1 supersedes the original past-minute replay tests; preserved earlier checks are explicitly unverified. The original production snapshot is archived in the [3.0 release evidence](releases/3.0.0-live-monitoring.json).

| Requirement                                   | Evidence                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autonomous monitoring without browser traffic | `live-monitoring.json`: two new distinct good scheduled minutes for both the private catalog and public gateway, captured without invoking a manual tick                                                             |
| Persistent state and incidents                | `npm run test:monitor`: real workerd/SQLite eviction preserves checks and incidents; `test:lifecycle` covers the separate lab                                                                                        |
| Idempotent scheduling                         | Twelve concurrent deliveries produce one upstream call and one check; duplicate/open-incident invariants verified in runtime tests                                                                                   |
| Crash and stale-result handling               | Persisted active/expired lease test, replaced-token test with a real in-flight request, and policy-revision race test                                                                                                |
| Incident response                             | Three bad observations open once; two good recover; acknowledgement is idempotent and private note does not appear publicly                                                                                          |
| Honest metrics                                | Missing fixture slots reduce coverage; zero/bounded window tests; current incomplete minute excluded; SLO method documented in `MEASUREMENT.md`                                                                      |
| Owner controls                                | Runtime auth, bad credentials, Origin mismatch, malformed JSON, oversized body, stale revision, and private audit tests; browser verified local login, maintenance save, invalid timeout rejection, resume, and lock |
| Export                                        | Real downloaded `edgelab-operations.json` parsed as schema version 3; runtime verifies attachment headers, selected window, and target-URL exclusion                                                                 |
| UI                                            | Desktop and 390px layout checked; no horizontal document overflow; console error inspection; legacy lab remains available                                                                                            |
| Regression coverage                           | 47 unit tests, strict TypeScript/build, both Worker dry-runs, lab lifecycle suite, monitoring runtime suite, local and deployed HTTP integration                                                                     |
| Reproducible performance                      | `benchmark-local.json` and `benchmark-live.json`: three trials each at concurrency 1, 12, 24, 48; no missing events or token-budget violations                                                                       |
| Operating documentation                       | OpenAPI contract, operator runbook, measurement guide, coordinator ADR, and trust-boundary document                                                                                                                  |
| Published revision                            | Git history and the matching GitHub Actions run provide exact commit identity and CI outcome                                                                                                                         |

The benchmark's 250 ms controlled origin delay is intentional. In all three deployed 48-request trials, 12 reached the origin and 36 were limited. This shows the configured burst boundary under those test conditions, not sustained throughput or a global latency guarantee.

The runtime probe fixtures inject failure only in isolated tests. Production incident history has not been seeded with invented incidents. Local preview history can contain maintenance changes made during UI validation; this is separate from the deployed monitor's state.
