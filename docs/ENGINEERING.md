# EdgeLab engineering walkthrough

## Why this project fits the supplied internship role

The role emphasizes identifying familiar Internet problems, shipping independently, and learning Cloudflare's platform. Retry amplification and uncontrolled recovery are concrete reliability problems. This project demonstrates stateful coordination, failure handling, frontend controls, testing, and clear communication of limits. No project guarantees hiring priority; the useful signal is whether you understand and can improve what you built.

## Read the code in this order

1. `worker/engine.ts`: follow `admit`, then `complete`. Read each associated test.
2. `worker/index.ts`: identify every asynchronous boundary. Admission and persistence happen together before origin work; completion reloads current state afterward.
3. `src/main.tsx`: trace one button into the HTTP API and back into the event log.
4. `wrangler.jsonc`: explain the binding, SQLite migration, and asset routing.

## Invariants worth explaining

- At a fixed timestamp, at most `capacity` origin-admission candidates receive a token.
- Refill never exceeds capacity and a backward clock does not mint tokens.
- A half-open circuit admits one probe; other admitted requests use fallback or 503.
- Older circuit-generation results cannot change newer circuit state or refresh its cache.
- A reset changes the run ID. Old work returns 409 and does not add events or counters to the new run.
- State and log updates are transactionally coupled. The SQLite log never exceeds 180 rows.
- Cached fallback has a maximum age; a successful status does not imply fresh data.

The bucket is evaluated before the breaker. Circuit bypasses consume tokens too. That makes the budget apply to requests handled by the protected service, including fallback, rather than solely to origin calls.

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

No. It demonstrates freshness policy using a constant synthetic response and the timestamp of the last successful completion. It does not implement cache keys, Vary, authorization-aware caching, headers, or arbitrary payload storage. Extending it to real data requires those decisions.

**Is this a production gateway?**

No. There is no real origin proxy, authenticated tenant model, account-level abuse prevention, idle-lab deletion, global load test, or production traffic evidence. UUIDs are bearer capabilities, not identities. A user can create new sessions and reset demo quotas. Do not use the experimental rate limiter as an account protection boundary.

**How is latency measured?**

`Date.now()` elapsed from the Durable Object handler through admission, synthetic delay if any, and completion. Workerd timing resolution can produce zero-millisecond local bypasses. P95 uses the nearest-rank method over the latest 180 completed events, mixing outcomes. It is not the latency of successful requests alone, browser RTT, or a network-wide measurement.

## Two-minute demo

- 0:00: Describe retry amplification during an outage.
- 0:20: Reset; run a 24-request burst. Show admitted and HTTP 429 outcomes.
- 0:45: Run the guided demo. Show the cache warming, circuit opening, origin bypasses, and recovery.
- 1:20: Explain the single probe, generation fencing, and test for a late response.
- 1:45: Explain the coordinator-hop and stale-data tradeoffs. Export the run and show how to reproduce it.

## Your next contribution

Choose one and implement it yourself before presenting the project as work you fully understand:

1. **Owned origin via service binding.** Deploy a second Worker as the origin. Add explicit timeout handling and propagate a stable request ID. Never accept arbitrary target URLs.
2. **Controlled A/B experiment.** Compare protected and unprotected requests against the same controlled origin. Measure success, origin invocations, and latency by outcome. Publish raw data and your hypothesis.
3. **Expiration alarms.** Persist an idle deadline and delete expired lab data through a Durable Object alarm, including a test for activity racing with cleanup.
4. **Real cached payload.** Save a versioned origin response with explicit freshness and stale deadlines. Test that a late response cannot overwrite a newer version.

## AI-assisted development disclosure

This initial implementation was built with an AI coding assistant. Be ready to explain the design, run the tests, identify limitations, and make changes without treating generated code as unquestionable. If asked, describe which parts you reviewed, modified, and validated. Do not imply that generated design decisions or measurements were independently yours.
