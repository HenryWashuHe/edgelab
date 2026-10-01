# EdgeLab resilience-lab engineering walkthrough

EdgeLab v3 also includes persistent service monitoring and incident response. See the [operator runbook](OPERATIONS.md), [monitor architecture decision](adr/001-monitor-coordination.md), and [measurement guide](MEASUREMENT.md). This document focuses on the isolated experimental gateway.

## Why this project fits the supplied internship role

The role emphasizes identifying familiar Internet problems, shipping independently, and learning Cloudflare's platform. Retry amplification and uncontrolled recovery are concrete reliability problems. This project demonstrates stateful coordination, failure handling, frontend controls, testing, and clear communication of limits. No project guarantees hiring priority; the useful signal is whether you understand and can improve what you built.

Cloudflare's [2026 internship announcement](https://blog.cloudflare.com/cloudflare-1111-intern-program/) described faster review for an AI-powered Cloudflare application submitted with the application. Its linked destination currently resolves to an [Agents platform overview](https://agents.cloudflare.com/), rather than a submission rubric. The supplied 2027 posting gives bonus points for personal projects and Cloudflare use but does not specify fast-track qualification. Verify instructions in the actual application portal. EdgeLab's controlled explorer and fake-provider tests demonstrate evidence handling; successful native inference remains a separate, unverified capability.

## Read the code in this order

1. `worker/engine.ts`: follow `admit`, then `complete`. Read each associated test.
2. `worker/lab-admission.ts` and `worker/index.ts`: distinguish the outer native lane before namespace lookup from the engine admission/persistence transaction before origin work; completion reloads current state afterward.
3. `src/main.tsx`: trace one button into the HTTP API and back into the event log.
4. `worker/origin-client.ts` and `worker/origin.ts`: trace the service binding, payload validation, and timeout boundary.
5. `wrangler.jsonc` and `wrangler.origin.jsonc`: explain the binding, private origin, SQLite migration, and asset routing.

## Invariants worth explaining

- At a fixed timestamp, at most `capacity` origin-admission candidates receive a token.
- Refill never exceeds capacity and a backward clock does not mint tokens.
- A half-open circuit admits one probe; other admitted requests use fallback or 503.
- Older circuit-generation results cannot change newer circuit state or refresh its cache.
- A reset changes the run ID. Old work returns 409 and does not add events or counters to the new run.
- State and log updates are transactionally coupled. The SQLite log never exceeds 180 rows.
- Cached fallback has a maximum age; a successful status does not imply fresh data.

The bucket is evaluated before the breaker. Circuit bypasses consume tokens too. That makes the budget apply to requests handled by the protected service, including fallback, rather than solely to origin calls.

## Explain a committed monitoring cleanup

The monitoring coordinator illustrates another transaction boundary: 3.4.2 writes its cleanup receipt through the existing completed scheduler event, inside the transaction that expires source rows, revalidates FIFO candidates and advances queues. A later deletion or event-write failure rolls back the cleanup and its receipt together. Read `worker/monitor.ts`, `worker/monitor-version-retention.ts`, `worker/incident-evidence.ts` and `worker/metadata-cleanup.ts`, then run `npm run test:retention`.

Each queue examines at most 32 candidates. Consumed `DELETE RETURNING 1` rows count direct source deletions; SQLite rowsWritten also includes index and trigger work. A bounded source-exists lookup distinguishes protected from already-missing rows, and their counts sum to examined. `mayRemain` is conservatively true for any full batch, even if it just emptied the queue. Eager age/expired-parent expiry and cold migration are excluded. Public results expose only version counts; one explicit authenticated audit request additionally reads private note counts. Legacy/malformed/null receipts stay unavailable, cached timestamps never renew, and opening a disclosure makes no request.

The [3.4.2 fixture](evidence/releases/3.4.2-retention-cost.json) measured unchanged steady costs of 94 reads/40 writes for two targets and 189/82 for five, with small or grown metadata. Full 32-version plus 32-note catch-up adds 128 reads, zero writes and zero statements over the [3.4.1 archive](evidence/releases/3.4.1-retention-cost.json). Explain the [retention design](adr/006-metadata-retention-work.md) and [receipt decision](adr/007-committed-cleanup-diagnostics.md) together: observable cleanup does not establish total account quota, production recovery or native inference.

## Explain bounded public status reuse

Version 3.7.0 addresses a different cache boundary: multiple viewers can request the same monitoring view without any new source evidence. Read `worker/status-view-cache.ts`, `worker/monitor.ts`, `worker/budget-signals.ts` and [ADR 010](adr/010-bounded-public-status-reuse.md), then run `node scripts/status-cache.mjs` locally. This cache belongs to the monitor instance and is separate from the lab's cached catalog payload and the persisted seven-day check projection.

At most two canonical reporting windows share a 1 MiB serialized UTF-8 envelope cap, including private budget-row revision/time metadata used only for aging. The cap does not measure JavaScript heap. A hit requires age below 10,000 ms, the same UTC minute and unchanged source/configuration context; eviction loses only memory. Hits precede target synchronization and execute no storage work. Relevant commits invalidate reuse, including each probe completion after an asynchronous origin call: clearing only at the start and end of a tick could hide an intervening commit. Observed monitor failures clear both entries, while rollback must never publish phantom source changes.

Explain `read.source`, `materializedAt`, `servedAt`, `ageMs` and `maxAgeMs: 10000`. Response `now` is delivery time; source observation, budget, scheduler and cleanup times stay unchanged. Status, budget freshness and readiness are projected against delivery time. Export, readiness and private evidence bypass this cache; HTTP remains `no-store`. A zero-read hit cannot discover an outage that no operation has observed yet, so it can mask that failure for less than ten seconds. This is an explicit tradeoff, not a fresh storage-health claim or quota guarantee.

The [final-source controlled runtime archive](evidence/releases/3.7.0-status-cache.json), measured at 2026-10-01 01:15:44 UTC, verifies 28 groups, including native SQLite failures and rollback. For both windows a mature two-target miss or export uses 27 statements/158 rows read, and five targets use 63/362, with zero writes. Each 100-request concurrent/sequential warm-hit group uses zero attempted or consumed SQL, KV or alarm work. Constructor/enrollment and mature-input bootstrap are separate profiles; native failed attempts that yield no cursor have unknown row cost rather than a claimed zero. [Implementation CI](https://github.com/HenryWashuHe/edgelab/actions/runs/36800527533) and [live HTTP verification](evidence/releases/3.7.0-live-monitoring.json) pass. The live check confirms both-window reuse provenance and authoritative exports, not production SQL/CPU/billing cost or rendered browser behavior. Explain the measurement boundary before using numbers on a résumé.

## Inspect the recorded runtime evidence

Open Architecture to compare the pinned 3.7.0 status-cache run for two or five targets and either reporting window. Read the shown request counts: one mature miss or export and 100 concurrent or sequential warm hits are separate measured groups. The controls read `src/data/status-reuse-evidence.json`, a small allowlisted projection checked by `npm run test:status-evidence`; they do not run a benchmark or call the application. Check out the linked artifact commit before attempting to reproduce that exact source. Runtime versions and source bytes are provenance, not authenticity or production-cost guarantees.

## Identify work that origin admission does not prevent

Run `npm run test:lab-storm` on the current checkout. It accepts no deployed URL or workload arguments, uses at most eight ephemeral local objects and delegates to the production gateway, native SQLite and the actual private origin Worker. The [3.8.0 manifest](evidence/releases/3.8.0-lab-storm.json) passes eight groups and ten samples with complete project-local build-input hashes captured before the tested builds and checked after disposal. The [frozen 3.7.0 baseline](evidence/releases/3.7.0-lab-storm.json) can be reproduced from commit `bf5d311`; its version and package hashes stay historical.

In the 3.8.0 local run, 24 existing empty-run state reads consumed 96 SQLite rows read and 24 written, with 24 KV puts and alarm sets and no origin requests. Eight circuit-denied requests consumed 64 rows read and 32 written, plus lease/alarm work, while making no origin requests. Eight state reads with 180 retained events consumed 1,464 rows read and eight written. A six-run fresh-capability sample includes constructor/enrollment work and used 54 rows read and 60 written. Constructor, initial enrollment, origin dispatch, diagnostics and later eviction are separately attributed. Successful cursor counts include index/trigger effects; method counters are not physical billing counts.

The per-run token bucket limits origin work. Version 3.9.0 adds separate native owner/observer lanes before namespace lookup, preserving envelope validation and capability boundaries. Its sanitized refusal is distinct from a committed lab decision; one fixed key per namespace spans rotating capabilities. The policies are permissive and location-scoped, so shared contention and approximate enforcement remain explicit tradeoffs. These local measurements do not establish production SQL usage, CPU cost, free traffic or account-wide protection.

## Questions and candid answers

**Why Durable Objects instead of KV?**

KV is not a coordinated atomic counter across locations. One Durable Object gives a per-session serialization point and colocated durable state. It introduces an extra network hop and per-object throughput limits. The lab does not measure those limits.

**Does single-threaded mean race-free?**

No. Requests can interleave across `await` boundaries. We reserve the token and probe synchronously, persist them, then await origin work. Completion reloads current state and verifies run and circuit generation. A probe lease handles interruption before completion.

**Can requests still hit the origin after the circuit opens?**

Already-admitted work can. The circuit prevents new origin admissions, not work already in flight. Failures are evaluated in completion order, so this is a consecutive-failure breaker, not a rolling-window error-rate detector.

**What happens after an eviction or crash?**

Admission state and events are persisted. Work interrupted after admission may leave total requests greater than completed outcomes. That is visible and intentional; this demo does not implement an exactly-once work queue. A persisted probe deadline prevents indefinite half-open lockout. Durable Objects persist a local replica in Wrangler; cloud deployment uses Cloudflare-managed storage.

**Is the cache a general HTTP cache?**

No. It caches the actual versioned catalog payload returned by a private origin Worker, with a 60-second maximum age measured from capture. It does not implement cache keys, Vary, authorization-aware caching, headers, or arbitrary payload storage. Extending it to real data requires those decisions.

**Is this a production gateway?**

No. There is no arbitrary origin proxy, authenticated tenant model, account-level abuse prevention, global load test, or production traffic evidence. The private controlled origin is reached through a real service binding, and idle labs are automatically deleted after 24 hours. UUIDs are bearer capabilities, not identities. A user can create new sessions and reset demo quotas. Do not use the experimental rate limiter as an account protection boundary.

**How is latency measured?**

`Date.now()` elapsed from the Durable Object handler through admission, the origin service call if admitted, and completion. Workerd timing resolution can produce zero-millisecond local bypasses. Origin P95 uses the nearest-rank method over origin attempts within the latest 180 completed events. Rate-limited requests and circuit bypasses are excluded; origin errors and timeouts are included. The chart still shows all outcomes. It is not the latency of successful requests alone, browser RTT, or a network-wide measurement.

## Alarm and upgrade behavior

The owner HTTP controls, including state refresh, renew the persisted 24-hour deadline and schedule an alarm. Live observer attachment, reconnect and idle sockets never renew it. The alarm runs inside a short concurrency block, checks the latest deadline, and deletes all storage only when expired. The next request recreates the schema. A completion checks the actual live deadline and the same run ID before writing. If an owner reaches an elapsed deadline before a delayed alarm, the touch transaction starts a new run and discards old events, fencing the old in-flight permit. Existing v1 state gains timeout defaults and clears its timestamp-only cache; old history remains available, while new response-payload metadata is recorded for v2 requests. Version 3.5 observer revision/commit metadata is added by real owner writes, never by observation. Previously idle v1 objects acquire alarms when next accessed.

`scripts/lifecycle.mjs` runs the deployed bundles in an isolated Miniflare runtime with a shortened test-only idle interval. It proves real SQLite state and cached payload survival across eviction, renewal past the old deadline, actual alarm deletion, schema recreation, and rejection of a late response after expiry. Production uses 24 hours; the short interval is never configured in Wrangler deployment files.

The timeout bounds how long the gateway awaits the origin; cancellation does not guarantee already-started upstream work stops. State updates after timeout use the timeout result and cannot later be replaced by a late successful response.

## Two-minute demo

- 0:00: Describe retry amplification during an outage.
- 0:20: Reset; run a 24-request burst. Show admitted and HTTP 429 outcomes.
- 0:45: Run the guided demo. Show the cache warming, circuit opening, origin bypasses, and recovery.
- 1:20: Explain the single probe, generation fencing, and test for a late response.
- 1:45: Explain the coordinator-hop and stale-data tradeoffs. Export the run and show how to reproduce it.

## Your next contribution

Choose one and implement it yourself before presenting the project as work you fully understand:

1. **Public session issuance.** Add a separate admission boundary to issue signed, expiring session capabilities. Keep demo policy controls separate from account-level quotas.
2. **Controlled A/B experiment.** Compare protected and unprotected requests against the same controlled origin. Measure success, origin invocations, and latency by outcome. Publish raw data and your hypothesis.
3. **Windowed error detection.** Compare the consecutive-failure breaker to a rolling-window failure rate under the same fault schedule.
4. **HTTP cache semantics.** Add per-resource cache keys, conditional requests, and explicit fresh/stale intervals. Decide how authorization and Vary affect cache eligibility.

## AI-assisted development disclosure

This initial implementation was built with an AI coding assistant. Be ready to explain the design, run the tests, identify limitations, and make changes without treating generated code as unquestionable. If asked, describe which parts you reviewed, modified, and validated. Do not imply that generated design decisions or measurements were independently yours.

## Committed live observation

The observer uses the existing coordinator through the Hibernation WebSocket API. Read `worker/lab-observer.ts`, `worker/index.ts`, `src/LabObserver.tsx` and [ADR 008](adr/008-live-lab-observer.md). Each real source write stores its revision and commit timestamp in the existing JSON state row; reset changes run identity while carrying the sequence forward. Initial attachment projects at most twelve events, while a mutation captures one allowlisted frame with at most one new event. Broadcast happens after successful source transactions and required alarm setup, without a storage query per viewer. A failed later action can follow an earlier committed owner touch. Rolled-back writes produce no frame; reconnect confirms stored state after an interrupted touch.

Explain the difference between a committed token balance and a simulated refill, between admitted and settled requests, and between connected transport and healthy origin. Reconnect is an authoritative snapshot with no command replay. Legacy commit time stays unknown. Browser upgrade rejection is opaque, so it cannot identify quota exhaustion or the fifth-connection limit. `npm run test:lab-observer` tests original sockets surviving a real workerd constructor restart, rather than manually reconstructing a mock object. SQL cursor rows, KV calls and alarm operations must be measured separately; these fixtures do not estimate a whole-account bill or prove production hibernation timing.

## Record coordination evidence for offline inspection

Published 3.6.0 captures the accepted observer stream in memory and adds `#replay`. Read `src/lab-recording.ts`, `src/LabReplay.tsx` and [ADR 009](adr/009-bounded-lab-recordings.md), then run `npm run test:lab-recording`. One initial snapshot and increasing updates preserve receipt order across reset. Recording stops at 256 entries or 192 KiB, reserving 1 KiB for final metadata; it retains a valid immutable prefix while the live observer can continue. Stop and Download are separate actions. Reconnect, leaving or reload replaces or discards browser memory, so download first.

The [controlled 25-frame recording](../src/data/lab-recording-example.json) uses a real local gateway, SQLite Durable Object and `worker/origin.ts` service binding. The recipe demonstrates overlapping pending work, settled results, a reset-fenced late response, an actual constructor restart with the original socket, and circuit failure/recovery. Its [separate manifest](evidence/releases/3.6.0-recording-runtime.json) pins source, recipe and bundle hashes. Content hash `ee884cdcefaedcd23c22eed275ec5088852beec2b6dd8ed323381d2cc908a082` identifies this bounded capture. Real timestamps and run identifiers vary across reruns; reproducibility does not require identical bytes. There is no seeded production history, fake clock, native inference or account call in this recipe.

Replay validates exact bounded shapes and the canonical SHA-256 locally. It makes zero application API requests or WebSocket messages, reads no capability and adds no browser persistence. Previous/Next and the slider select a recorded entry without executing a command, scheduling playback or simulating refill. Revision gaps identify unknown intermediate commits; the initial snapshot can already contain earlier outcomes. The displayed event list remains bounded to twelve per selected run, so it is not a complete history backup.

Keep three clocks distinct: the recorded commit timestamp, the server frame timestamp and the recorder receipt timestamp. Receipt times can regress without changing sequence order; their difference from server time cannot establish network latency. A terminal entry shows the last observed state, not a confirmed final outcome. A matching unsigned hash cannot establish authenticity, ownership or cause. CI passes 136 unit tests across 13 files, and local keyboard/mobile replay checks pass. The [final-source recording recheck](evidence/releases/3.6.0-recording-recheck.json) verifies package, producer and actual gateway version agreement; the pinned example remains unchanged. [Validation evidence](evidence/VALIDATION.md) distinguishes passing live HTTP verification from unverified live browser capture/download, file import and the new production UI. Native AI remains disabled with zero native calls and unverified entitlement. Neither this demonstration nor the supplied posting establishes a hiring guarantee.

## Explain admission before object work in 3.9.0

Read `worker/lab-admission.ts`, gateway routing and `src/lab-request-control.ts`, then run `npm run test:lab-admission`. The [12-group/19-sample local proof](evidence/releases/3.9.0-lab-admission.json) meters actual namespace dispatch, lab SQL, lease/alarm and origin work separately. Refused fresh UUIDs never cause diagnostic lookup; existing source hashes remain unchanged. Native-limiter overhead lies outside the lab meter. The actual scheduled handler remains operational with both lanes exhausted.

Trace a mixed burst: an outer refusal has no outcome/event, while an engine refusal is a real persisted decision. Every already-dispatched sibling promise settles before the UI unlocks, and a failed batch performs no automatic state refresh or write replay. Confirmed refusal concerns one request only; source may still contain earlier successful commits. Production uses nominal owner 120/minute and observer 20/minute policies, while the isolated fixture uses smaller native thresholds. Explain why these are not exact global budgets. [ADR 011](adr/011-pre-object-lab-admission.md) and [Cloudflare's binding contract](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) document the scope.

## Walk through recorded coordination in 3.10.0

Follow the replay link from Operations or Fieldnotes and load the built-in recording. Frame 7 shows two evaluated but unsettled requests; frame 15 shows a changed run with cleared totals; frame 24 shows a pending half-open attempt, followed by one recorded success in frame 25. Explain selected facts and labeled comparison frames separately. The producer remains 3.6.0, source links are pinned, and the unsigned hash provides integrity rather than authenticity. Late completion HTTP 409 and forced hibernation belong to the separate runtime manifest.

Read `src/replay-tour.ts` and its tests to explain why identical uploaded files remain generic and why milestones are derived only from a validated trusted load. No selector reconstructs missing states or executes an experiment. Run `npm run test:benchmark-compatibility` to verify a different boundary: actual native engine responses and persisted history must match the strict benchmark helper, and one pre-object refusal cannot let it return while sibling origin work remains in flight. The bounded local recipe is not a performance or production-cost benchmark.

## Explain section-loading boundaries in 3.11.0

Read the module-level lazy imports, keyed RouteBoundary and hash navigation helper. Explain why a new route must dispose the previous private operator/observer/replay instance while loading, why the owner lab remains in App and why rejected lazy imports need explicit full reload. ReplayRoute owns the unchanged pinned recording; download of static code is separate from application API or socket activity. Build-graph and HTTP asset checks do not prove rendered lifecycle or speed. See [ADR 012](adr/012-demand-loaded-sections.md).
