# EdgeLab

[**Open the live demo**](https://edgelab-reliability.edgelab-henrywashuhe.workers.dev) · [CI checks](https://github.com/HenryWashuHe/edgelab/actions)

**Break things. Build resilience.** An interactive API reliability lab built with Cloudflare Workers, SQLite-backed Durable Objects, React, and TypeScript.

Send a concurrent traffic burst, inject an origin outage, and watch a coordinated token bucket, circuit breaker, and cached fallback protect the request path. Every request leaves an inspectable event. Inspect response payloads and request IDs, then export an experiment as JSON or CSV.

The gateway calls a **separate private origin Worker through a service binding**. The catalog data and injected failures are synthetic; the service-to-service requests, response cache, timeout handling, and persistence are real. This is an educational lab, not a general-purpose production proxy or a claim of Internet-scale capacity. Latency is measured server elapsed time, not browser RTT.

Version 2 adds actual cached payloads, configurable timeouts, automatic idle cleanup, a keyboard-accessible request inspector, CSV exports, cancellable guided experiments, and controls that stay available during steady traffic.

Storage failures return JSON503 with code `lab-storage-unavailable`, a sanitized reason and a known UTC reset time when available. The browser marks current state unconfirmed, pauses experiments, and retains cached logs as historical evidence. Reconnect performs one state read and never repeats an uncertain request, reset or configuration write. With no loaded snapshot, metrics and history remain unknown.

## Run locally

Requires Node.js 22.12+ and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:8787 and select **Run guided demo**. Wrangler starts both Workers, their service binding, SQLite storage, and Durable Objects locally. The local server needs permission to bind loopback ports. No Cloudflare account or API key is needed locally.

`npm run dev` builds the UI before starting Wrangler. Worker changes reload automatically; after frontend edits, run `npm run build` in a second terminal and refresh the browser.

## What to try

1. **Guided demo:** warms the cache, injects failures, opens the circuit, restores the origin, waits for cooldown, and probes recovery. Resets the current lab first; Stop demo cancels future requests and retains completed events.
2. **Traffic burst:** fires 24 concurrent requests against one shared token budget. With a full default bucket, an immediate burst admits 12 and rejects the rest with HTTP 429. Refill and timing can change the exact count.
3. **Failure without fallback:** disable the cache switch, take the origin offline, and send requests. The first failures return 502; once the circuit opens, new admitted traffic returns 503 without origin work.
4. **Steady traffic:** sends one request per second plus response time. Change origin health, cache policy, or timing while it runs. Stops after 60 requests or when you press Stop.
5. **Slow origin:** expand Timing & recovery settings. Set origin delay above the timeout budget. Without a populated cache, the gateway returns 504 and counts a circuit failure.
6. **Inspect a response:** click a request time. Compare the revision and generatedAt fields of a fresh and cached response. Request IDs, retry hints, cache age, and origin attempts are recorded.
7. **Export JSON / CSV:** JSON includes configuration and all-run counters. CSV includes chronological event rows. Both export the latest 180 events; the table shows 30 matching events and the chart shows 60.

## Architecture

```mermaid
flowchart LR
    B[Browser / API client] --> W[Cloudflare Worker]
    W --> D[Per-lab Durable Object]
    D --> T[Token bucket + circuit breaker]
    T -->|Service binding + timeout| O[Private catalog Worker]
    T --> C[Bounded-age cached fallback]
    D --- S[(SQLite state + event history)]
```

- **Worker:** serves the frontend through Workers Static Assets; validates API path, origin, body size, and session ID.
- **Durable Object:** one coordinator per opaque UUID session. Admission reserves tokens and the sole half-open probe in synchronous SQLite transactions before awaiting origin work. Completion uses another transaction.
- **Circuit breaker:** closed → open after three consecutive failures → one half-open probe after a four-second cooldown → closed on success, open on failure.
- **Generation fencing:** late completions from an older circuit generation cannot change the new circuit. A run ID invalidates requests admitted before reset. A ten-second persisted probe lease recovers interrupted probes.
- **Origin:** a separate Worker returns a versioned catalog response. Its workers.dev and preview routes are disabled; only the service binding is used. The gateway validates its response and applies a configurable timeout, including response-body consumption.
- **Cache:** the actual last successful catalog payload and its capture timestamp. Failures and circuit bypasses may serve it for up to 60 seconds. Rate-limited requests still return 429.
- **Storage:** state and a 180-row event ring survive object eviction. Counters cover the entire run, including admitted requests still in flight. Every API request renews a 24-hour idle deadline. A Durable Object alarm deletes SQL, KV, and alarm metadata after inactivity; late origin completions cannot resurrect the expired run. State created before v2 gains cleanup on its next API request.

See [the engineering walkthrough](ENGINEERING.md) for invariants, limitations, and extension ideas. The app also has Architecture and Field notes views.

## Verify

```sh
npm test                 # deterministic engine tests
npm run build            # strict TypeScript + production frontend bundle
npm run check            # formatting, tests, build, deployment dry-runs
npm run test:lifecycle   # actual eviction, idle alarms, and post-expiry recovery
```

With `npm run dev` running in another terminal:

```sh
npm run test:integration
```

Integration checks execute real HTTP requests against both local Workers and the SQLite-backed Durable Object: real payload caching, upstream timeout, concurrent admission, outage/fallback/recovery, isolated sessions, validation, reset fencing, and log retention. They use a new random session, never the browser's session. To test a deployed instance you own, explicitly set `BASE_URL`.

## Deploy to your Cloudflare account

```sh
npx wrangler login
npx wrangler whoami
npm run deploy
```

The deploy first creates the private `edgelab-origin` Worker, then the public `edgelab-reliability` gateway and its SQLite-backed Durable Object namespace. Wrangler prints your workers.dev URL. The repository includes the initial `new_sqlite_classes` migration and needs no manual database provisioning. If either Worker name already belongs to another project, update both config files and the ORIGIN service binding before deploying. A new Cloudflare account also needs a workers.dev subdomain; Wrangler or the Workers dashboard can register one.

Cloudflare supports SQLite-backed Durable Objects on the Workers Free plan, subject to current account limits. Check [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) before sustained traffic. No paid service is required by the code.

A public anonymous lab can be abused to create sessions and consume your account quota. The lab's adjustable bucket is an experiment, **not** a perimeter abuse control. For broad public access, add a separate admission boundary (such as Cloudflare Access for private demos, or session issuance with abuse controls). Idle cleanup limits retained session data but does not prevent users from creating new sessions. Do not put sensitive data in a lab. Knowing its UUID grants access; there are no user accounts.

## API

All lab endpoints require a UUID v4 `X-Lab-ID` header. Keep it out of public screenshots or URLs if you want your demo session private. Same-origin browser requests and non-browser clients with the capability are accepted. All API responses disable caching.

| Endpoint       | Method | Behavior                                                               |
| -------------- | ------ | ---------------------------------------------------------------------- |
| `/api/health`  | GET    | Worker health and actual edge colo, or `LOCAL`                         |
| `/api/state`   | GET    | State snapshot and latest 180 completed events                         |
| `/api/request` | POST   | Run one protected request; returns 200, 429, 502, 503, or 504          |
| `/api/config`  | POST   | Apply bounded configuration fields                                     |
| `/api/reset`   | POST   | Clear lab history and restore defaults; in-flight old work returns 409 |

```sh
LAB_ID=$(node -e 'console.log(crypto.randomUUID())')
curl -H "X-Lab-ID: $LAB_ID" -X POST http://localhost:8787/api/request
curl -H "X-Lab-ID: $LAB_ID" http://localhost:8787/api/state
```

Numeric bounds: capacity 1–50, refill 1–20 tokens/s, threshold 1–10, cooldown 1–15 seconds, origin delay 20–3000 ms, timeout 100–5000 ms. Origin mode is `healthy`, `flaky` (every third origin call fails), or `failing`. Bodies over 4 KB are rejected.

## Project layout

```text
worker/engine.ts          deterministic admission and recovery state machine
worker/index.ts           gateway, Durable Object, SQLite, expiry alarms
worker/origin.ts          private catalog Worker and response schema
worker/origin-client.ts   validated service call with bounded timeout
src/main.tsx             interactive dashboard and cancellable experiments
src/RequestInspector.tsx accessible request details dialog
src/reports.ts           report statistics and CSV/JSON export
src/Guide.tsx             architecture and interview walkthrough
src/style.css            responsive interface
scripts/integration.mjs  HTTP tests against the actual local runtime
scripts/lifecycle.mjs    actual workerd eviction and alarm tests
tests/                   state machine, origin client, and report tests
docs/ENGINEERING.md       design decisions and interview preparation
wrangler*.jsonc          gateway and private origin configurations
```

## Resume wording

> Built an interactive API resilience lab using Cloudflare Workers, SQLite-backed Durable Objects, and TypeScript; implemented coordinated token-bucket rate limiting, circuit breaking with single-probe recovery, bounded-age response caching, service-binding timeouts, and alarm-based idle cleanup.

Use this after you can explain and reproduce the behavior. Add numbers only from experiments you ran and saved. Do not claim production traffic, global latency, or performance at Cloudflare's scale based on a localhost demo.

A strong follow-up is to implement one extension yourself, publish an experiment with reproducible steps, and explain a tradeoff or bug you discovered. See [docs/ENGINEERING.md](ENGINEERING.md).

## Platform references

- [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
- [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [New SQLite namespace migration](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)

The dev tooling pins a patched Undici release through npm overrides to avoid the advisory affecting Wrangler's transitive dependency. The production Worker does not bundle Undici.
