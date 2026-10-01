# ADR 013: Bound upstream consumption and settle deliberate demo stops

Status: accepted for 3.12.0. Local unit, actual workerd and lab protocol checks pass; complete CI and live verification remain pending.

## Context

A timeout race can finish while a response reader remains locked. A fetch that ignores abort can also resolve later and start consuming its body. Lab origin calls additionally await error-body cancellation and previously buffer JSON without a byte cap. Hanging cleanup can turn a known HTTP failure into a timeout. The published 3.11.0 source reproduces these failures in controlled workerd fixtures.

Guided-demo Stop aborts future checks and pauses while an already-dispatched POST can commit. Its former cancellation path skips the final state read and can leave the older snapshot marked confirmed.

## Decision

Share one JSON lifetime across monitoring probes and lab origin calls. It covers fetch, consumption, decoding and parsing, retaining at most 16,384 response bytes in a fixed buffer. Periodic cooperative yields let deadlines progress even through immediately resolved empty reads. Nonaccepted responses and oversized bodies are canceled without awaiting cleanup. Timeout requests active-reader cancellation and releases its lock; late responses are canceled before reader acquisition. One terminal result prevents late success.

Monitoring still requires HTTP 200, uses manual redirects and classifies its health/catalog contract after consumption. Lab origin calls still accept `response.ok` and validate the catalog. Malformed JSON and oversized lab bodies now classify as `invalid`; known HTTP failures remain errors even if cleanup hangs or rejects. Fetch/body timeouts remain timeouts. Policy durations and monitor latency accounting stay caller-owned.

Brand deliberate demo Stop separately from transport `AbortError`. Await dispatched work before unlocking. If the original owner-page epoch remains active and the action ends through that marker, mark cached evidence unconfirmed and make exactly one guarded authoritative state GET. Keep the busy lock through that read; failure leaves the cache unconfirmed. Abandoned pages make no follow-up, and obsolete reads cannot update a later page. Generic action/burst failures retain their failure identity and make no automatic follow-up or POST replay.

## Verification

The [runtime archive](../evidence/releases/3.12.0-async-lifetime.json) compares 12 samples from pinned published 3.11.0 source with 28 maintained samples. Actual workerd streams use controlled in-isolate fetch adapters that deliberately ignore abort. Tests cover pending and late bodies, hanging/rejecting cleanup, exact 16 KiB and one-byte overflow, split UTF-8, malformed JSON and empty-stream progress. The harness closes orphaned baseline sources only after recording their failing state.

Six protocol cases execute the actual run/batch helpers in Node against the real local gateway, SQLite lab and private origin. Held reset/request responses settle before one confirmation read; a controlled 503 leaves evidence unknown; page abandonment and transport loss make no follow-up. A controlled HTTP refusal plus a held successful origin sibling settles without a final GET or replay. HTTP POST attempt counts include preparation and refusals; they are not SQL write measurements. Source, config, lock and bundle hashes remain stable through disposal. Miniflare metadata fetching and telemetry are disabled.

## Consequences

Timeout bounds application waiting and acceptance. AbortSignal and stream cancellation are best effort; they do not prove upstream/provider work terminated. The byte cap bounds retained body bytes, not total heap, CPU or billing. Stop prevents future demo dispatch and does not undo earlier commits. A final read confirms current source state, not success of every earlier mutation. Existing run, generation and deadline fencing remains necessary.

No browser/DOM interaction, production fault injection, native inference, provider termination, production resource cost or exact production admission threshold is verified by these fixtures.

References: [Streams cancellation and locking](https://streams.spec.whatwg.org/), [Cloudflare streaming](https://developers.cloudflare.com/workers/runtime-apis/streams/), [Workers memory guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
