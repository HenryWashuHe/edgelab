# EdgeLab resilience-lab engineering walkthrough

EdgeLab v3 also includes persistent service monitoring and incident response. See the [operator runbook](OPERATIONS.md), [monitor architecture decision](adr/001-monitor-coordination.md), and [measurement guide](MEASUREMENT.md). This document focuses on the isolated experimental gateway.

## Why this project fits the supplied internship role

The role emphasizes identifying familiar Internet problems, shipping independently, and learning Cloudflare's platform. Retry amplification and uncontrolled recovery are concrete reliability problems. This project demonstrates stateful coordination, failure handling, frontend controls, testing, and clear communication of limits. No project guarantees hiring priority; the useful signal is whether you understand and can improve what you built.

Cloudflare's [2026 internship announcement](https://blog.cloudflare.com/cloudflare-1111-intern-program/) described faster review for an AI-powered Cloudflare application submitted with the application. Its linked destination currently resolves to an [Agents platform overview](https://agents.cloudflare.com/), rather than a submission rubric. The supplied 2027 posting gives bonus points for personal projects and Cloudflare use but does not specify fast-track qualification. Verify instructions in the actual application portal. EdgeLab's controlled explorer and fake-provider tests demonstrate evidence handling; successful native inference remains a separate, unverified capability.

## Read the code in this order

1. `worker/engine.ts`: follow `admit`, then `complete`. Read each associated test.
2. `worker/index.ts`: identify every asynchronous boundary. Admission and persistence happen together before origin work; completion reloads current state afterward.
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
