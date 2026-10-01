# ADR 011: native lab admission before object lookup

Status: release candidate 3.9.0; local proof complete, publication pending.

## Context

The [3.8.0 controlled workload](../evidence/releases/3.8.0-lab-storm.json) showed that eight origin-circuit denials still consumed 64 SQLite rows read, 32 written and lease/alarm work. State reads and fresh UUID enrollment also perform object work. The adjustable lab token bucket therefore cannot protect that dispatch/storage path. A UUID is a bearer capability, not identity, and rotating it must not mint an independent outer allowance.

## Decision

Enable native Workers RateLimit bindings before every owner or observer `LABS` namespace lookup. Existing route, method, UUID, Origin, handshake and body-size guards precede the gate; configuration JSON/value validation remains inside the object. Independent namespaces carry the same fixed aggregate key, with nominal deployment owner 120/60 seconds and observer 20/60 seconds policies. Owner reads and writes share a lane; observer reconnects use another. No caller IP, UUID, personal identifier, query or payload determines the key. Health/assets, operations, readiness, exports and scheduled monitoring bypass both lanes.

Only exact `LAB_ADMISSION_ENABLED: "true"` invokes the selected binding once, preserving its native receiver. A boolean own `success` result permits or refuses dispatch. Missing, throwing or malformed bindings and malformed flags fail closed with sanitized503. Exact `false` or unset deliberately preserves legacy/local bypass; the development command sets false explicitly, and a separate native fixture tests true.

A native refusal returns429 `lab-admission-limited`; unavailability returns503 `lab-admission-unavailable`. The minimal body contains only `error`, `code` and `retryAfterSeconds: 60`; headers include no-store and fixed `Retry-After: 60`. This advice is neither the provider's reset time nor assurance of future admission. There is no engine outcome, source event, request ID, fabricated state, retry, provider text or lab dispatch. A confirmed refusal concerns only that request. Earlier or sibling writes may have committed; the UI waits for every dispatched promise before unlocking, marks current state unconfirmed and offers manual state reconnect without replay.

## Consequences and proof

Cloudflare documents [permissive counters scoped to a location](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), asynchronously updated through cached values. The policies are not globally coordinated accounting, identity, fairness, a daily account quota or a billing guarantee. Shared keys permit legitimate-peer contention. Separate namespaces avoid owner exhaustion directly consuming the observer lane but cannot guarantee service availability. Deployment changes no account plan.

The [final-source native local proof](../evidence/releases/3.9.0-lab-admission.json) passes 12 groups/19 samples with stable complete tested input hashes and version agreement. Smaller native cohorts verify zero lab namespace/SQL/KV/alarm/origin work on owner and observer refusals, preserved prior source, strict failure handling, validation precedence, genuine persisted engine refusal and control-plane bypass. With both lanes exhausted, the actual scheduled handler probes the private origin and persists a good check. Diagnostic controls are separate; limiter overhead and monitor storage are outside the lab meter.

Miniflare threshold behavior does not prove the deployed permissive counters. Release verification uses one disposable empty owner read and one network observer upgrade, interpreted with the reviewed enabled binding configuration. It submits no experiment/config/reset POST or socket command. Exact production thresholds, production SQL/CPU/billing and rendered browser behavior remain unverified. Historical benchmarks and pinned evidence retain their original source/version; the origin-policy benchmark aborts without saving partial results on an outer refusal.
