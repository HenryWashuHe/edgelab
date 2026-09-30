# Verification record

## EdgeLab 3.4.0

Gateway deployment: `3282aab8-dcb1-4fad-9cc3-2a0935ced406`. The private origin is unchanged. The public controlled brief explorer is available in Fieldnotes, including while monitor storage reports its daily quota failure. Native inference stays disabled with zero recorded native calls. Full autonomous production recovery remains pending; the last successful complete live monitoring verification is still 3.2.1.

Formatting, 104 unit tests, strict TypeScript, production assets and both deployment dry-run bundles pass. Monitor, incident and schema-upgrade runtime suites pass. The storage-failure suite now injects exceptions inside actual MonitorStore SQL: policy reads, a policy write that executes before throwing, and public incident-detail reads. These failures reach the sanitized503 boundary and cooldown. Real transaction rollback preserves policy, revision, streak state, captured versions and audit rows; no probes or inference start. Authentication401, normal-flow malformed/unsafe cursor400, invalid-policy400 and stale-revision409 remain verified. An existing gateway quota cooldown may return503 before a syntactically bad cursor reaches MonitorStore.

The new eight example tests verify exact full frozen snapshots/hashes against both the pinned 3.3.2 archive and current capture exports, preparation hashes/byte bounds/references/omissions, strict canned-response validation, immutable source evidence and altered-clone hash sensitivity. The presentation generator check runs in CI. Its client bundle contains only whitelisted example fields, with no raw prompts, provider envelopes, fixture-private data or backend/provider module dependency. This measures controlled evidence handling, not native model compatibility or quality.

The [browser record](releases/3.4.0-browser-qa.json) verifies the three native-select cases, inspectable citations, all snapshot hashes, an altered-copy comparison and explicit insufficient-evidence skipping. Direct Fieldnotes loading and these actions produce zero application API requests in the static fixture. Navigating from quota-failed Operations uses the always-visible examples link and adds no request after its initial failed status read. Actual390px viewport testing shows document width390px, a42px native selector, two-column facts and keyboard scrolling inside the320px table region; temporary viewport settings were reset. The deployed3.4.0 assets also pass citation/hash comparison and pinned-link checks, with no browser errors or warning logs.

The [live storage-boundary record](releases/3.4.0-storage-boundary.json) confirms current gateway liveness, sanitized monitor/lab quota503s, capability400 and operator401. It does not assert fresh cron samples, healthy readiness or successful AI. Public controlled examples contain no production/operator data and cannot replace those outstanding checks.

## EdgeLab 3.3.2

Gateway deployment: `a1bafe0a-f569-47d7-aa2e-217c42578bcf`. The private origin is unchanged. Production autonomous recovery remains pending the daily quota reset. AI generation remains disabled; no native inference has been performed. The last successful full live monitoring verification remains 3.2.1. The preceding 3.3.1 GitHub run failed at local server startup because the declared AI binding attempted to open a remote proxy without Cloudflare credentials; the offline unit and SQLite suites had passed. The development command now uses documented `wrangler dev --local` and forces inference off; it starts both local Workers without a remote AI session.

Formatting, 96 unit tests, strict TypeScript, production assets and both deployment dry-run bundles pass. The [brief admission evidence](releases/3.3.2-brief-admission.json) adds real SQLite concurrency, atomic rollback, independent daily/retained/UTF-8 limits, truthful one-time migration closure, completion headroom, no-refund rules and preserved retained UUID replay. The [offline evaluation report](releases/3.3.2-brief-evaluation.json) uses actual capture/preparation/validation exports with three controlled scenarios, two canned responses, one insufficient-evidence skip and six rejected adversarial outputs. It measures neither native provider compatibility nor model quality.

The actual Worker failure suite now covers laboratory storage exceptions after an initial successful touch. A mid-config read failure is sanitized; a save that executes before throwing rolls back the real transaction. Invalid configuration remains400. No private exception, invented decision or origin dispatch leaks through this boundary, and object eviction preserves the prior configuration.

The [local browser record](releases/3.3.2-browser-qa.json) verifies a committed configuration with a lost response, writes paused while unconfirmed, one reconnect state GET without replay, preserved cached history and unknown initial-load values. Brief storage and inference counts remain separate; daily record exhaustion disables new creation while existing requests remain inspectable. A virtual UTC rollover reopens admission without deleting retained evidence. This is desktop controlled QA, with no new mobile or production inference claim.

The [live boundary record](releases/3.3.2-storage-boundary.json) confirms deployed3.3.2 liveness, sanitized monitoring and lab quota503s, missing-capability400 and operator401 precedence. It records unavailable service rather than successful new cron minutes.

The [whole-monitor measurements](releases/3.3.2-monitor-cost.json) include the additional admission-pruning read: two targets use79reads/40writes per warm minute (113,760reads/57,600writes across1,440identical minutes), while five targets use168reads/82writes and exceed the Free daily write allowance. Complete status views remain160reads for two targets or364for five, with zero writes. These are controlled cursor measurements and workload projections, excluding other account activity and migrations. The [case study](../CASE_STUDY.md) connects the confirmed outage to the measured repair and its limits.

## EdgeLab 3.3.1

Gateway deployment: `39e332e2-226f-40df-94f5-e85a6d0b5887`. The private origin is unchanged; AI generation stays disabled. Production autonomous recovery remains pending the Free-plan daily quota reset. The last successful full live monitoring verification remains 3.2.1.

Formatting, 95 unit tests, strict TypeScript, production assets and both Worker bundles pass. Actual workerd/SQLite monitoring, migration, budget, incident, brief and lab lifecycle suites pass after integration. Budget evaluations and both dashboard windows match the original source SQL across mixed outcomes, maintenance, legacy/invalid start times, policy revisions, gaps, corrections, retention and eviction. The gateway failure fixture verifies sanitized503 responses, liveness/readiness separation, failed exports, cooldown and auth precedence.

The [check-cache measurements](releases/3.3.1-check-cache.json) record actual cursor reads for original queries and persisted projections. Covered late inserts, updates, deletes, moved slots/services, empty gaps, corruption, rollback and migration repair preserve source equivalence. Bounded incident listing preserves all active open incidents plus the exact global latest100 resolved with stable ties and no private-note leakage. The [whole-monitor measurements](releases/3.3.1-monitor-cost.json) include trigger/index costs: two targets use78 reads/40 writes per warm minute with steady retention, while five targets use82 writes and exceed the Free daily write allowance when projected over a day. These controlled workloads exclude other account activity and initial migrations.

Browser checks showed cached service and incident states become unconfirmed on a structured quota failure. An initial failure showed no loaded snapshot and no invented zero-incident result. The [local browser backoff record](releases/3.3.1-browser-backoff.json) confirms no automatic status request for128seconds after the known limit, while local evidence continued aging.

The [live storage-boundary record](releases/3.3.1-storage-boundary.json) verifies the deployed gateway version, structured quota503s and auth precedence. This deliberately records unavailable monitoring; it does not claim new successful cron minutes or native inference. Full production verification must run after reset and observe genuinely new autonomous checks.

## EdgeLab 3.3

Gateway deployment: `2a626843-eb51-4a56-9424-b2629d4e22f6`. The private origin implementation was unchanged. The deployed Workers AI binding is present, while `AI_BRIEFS_ENABLED` remains `false`. No native inference was performed; model access, live output quality, and remaining shared AI allocation are unverified. The deployed runtime reports Free-plan storage enforcement.

Formatting, 92 unit tests, strict TypeScript, production assets, and both Worker dry-run bundles passed. The existing monitoring, incident, schema-upgrade, budget and resilience-lab lifecycle runtime suites passed. Nine additional actual workerd/SQLite groups cover private admission, disabled capability, immutable capture, insufficient evidence, UUID replay/conflicts, concurrency, independent cron progress, UTC quota rollover, latest-five listing, malformed/tool/oversized provider envelopes, sanitized failures, deadline ownership, replaced tokens, interruption, source-history pruning, orphan cleanup, service eligibility and 30-day retention.

The [local brief QA record](releases/3.3.0-brief-qa.json) uses the actual Worker/SQLite runtime with a controlled fake provider and a separate fault proxy. Browser checks cover frozen facts, inspectable citations and hash provenance, confirmed response loss with two same-UUID POST deliveries and one provider dispatch, pending completion after dialog closure, rejected model output, daily admission exhaustion, disabled generation with retained history, Lock aborting a private read, and insufficient evidence without inference. Escape restores focus to the incident trigger. Production incident history was not seeded. The mobile viewport control did not apply during this run; the new panel was verified at 1280px, and this release does not claim a new mobile browser check.

Production verification failed: status and readiness returned HTTP 500, and a live Worker exception identified exhausted Free-plan database row reads. No 3.3 autonomous verification artifact was produced. The last successful full production verification remains the 3.2.1 record. The quota failure led to a derived-check cache, indexed cleanup and explicit unavailable responses in 3.3.1. Stored source evidence was preserved.

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
