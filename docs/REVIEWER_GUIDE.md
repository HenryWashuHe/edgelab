# Review EdgeLab in a few minutes

EdgeLab is a Cloudflare Workers reliability monitor and experiment lab. Scheduled probes preserve incident and policy evidence in SQLite Durable Objects. An isolated gateway demonstrates token admission, circuit recovery, reset fencing and durable observation. The [case study](CASE_STUDY.md) starts with a real monitoring quota failure and follows its repair.

Start with the [recorded tour](https://edgelab-reliability.edgelab-henrywashuhe.workers.dev/#replay). It needs no operator login, local setup or AI inference. The bundled example is historical controlled local workerd evidence, not a production incident or customer-traffic recording.

## Two-minute recorded review

Choose **Load built-in recording**, then inspect these three bookmarks:

| Bookmark             | Selected observation                                          | Separate comparison                                |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Two pending requests | Frame 7: two evaluated requests, no settled outcomes.         | Frame 9: two recorded origin successes.            |
| A new run            | Frame 15: changed run identity, cleared totals.               | Frame 14: the earlier run has one pending request. |
| A half-open attempt  | Frame 24: one pending recovery attempt after an origin error. | Frame 25: one origin success and a closed circuit. |

Previous/Next and the slider select captured entries without executing commands, API requests or WebSocket messages. Static application assets still download. The comparison panel describes another recorded frame; it does not change the selected state or simulate missing work. A matching SHA-256 establishes content integrity, not authenticity, causality or a complete run history. Late completion HTTP 409 and original-socket forced hibernation are checked by the [pinned runtime recipe](https://github.com/HenryWashuHe/edgelab/blob/3b0851c3b2c3e8b4ad5892be9bfb933215de7dc0/docs/evidence/releases/3.6.0-recording-runtime.json), not established by an absent frame.

## Three engineering facts to inspect

1. **A real failure led to a measured repair.** Monitoring exhausted its production row-read allowance. Source-authoritative projections and reference-aware retention replaced repeated scans. A controlled two-target cron fixture with grown policy/note history measured 3,354 reads before the retention repair and 94 afterward. The [case study](CASE_STUDY.md) separates this local comparison from production failure and subsequent live recovery; the [frozen comparison](https://github.com/HenryWashuHe/edgelab/blob/d224983d6242b7621f7c8af1811bf39f75315c5a/docs/evidence/releases/3.4.1-retention-cost.json) records workload and source hashes.
2. **Coordination is observable without rerunning commands.** The 25-frame capture uses a real local gateway, SQLite and private origin. Its three bookmarks distinguish pending admissions, a changed run and a recovery attempt. The [pinned capture and recipe](https://github.com/HenryWashuHe/edgelab/blob/3b0851c3b2c3e8b4ad5892be9bfb933215de7dc0/docs/evidence/releases/3.6.0-recording-runtime.json) and [frozen tour tests](https://github.com/HenryWashuHe/edgelab/blob/d224983d6242b7621f7c8af1811bf39f75315c5a/tests/replay-tour.test.ts) support different parts of that evidence.
3. **Frontend optimization includes shared dependencies.** The [3.11 build archive](https://github.com/HenryWashuHe/edgelab/blob/d224983d6242b7621f7c8af1811bf39f75315c5a/docs/evidence/releases/3.11.0-client-build.json) reproduces published 3.10 asset bytes under the same dependencies. Complete first-route JavaScript closures have 19.58% fewer gzip bytes for Operations and 27.99% fewer for Replay. These are sums of independently compressed build files, not measured download time or rendered browser performance. The archive is build evidence; current release verification is recorded separately in [Validation](evidence/VALIDATION.md).

For another credential-free view, [Architecture](https://edgelab-reliability.edgelab-henrywashuhe.workers.dev/#architecture) exposes pinned status-reuse workloads. [Fieldnotes](https://edgelab-reliability.edgelab-henrywashuhe.workers.dev/#notes) contains controlled brief examples with canned model responses; successful native inference is not claimed.

## Source map and interview claims

- [engine.ts](../worker/engine.ts) and [index.ts](../worker/index.ts): reserve before awaiting origin work; reload and fence completion by run and circuit generation.
- [monitor-check-cache.ts](../worker/monitor-check-cache.ts) and [monitor-version-retention.ts](../worker/monitor-version-retention.ts): keep source rows authoritative, repair changed slots and recheck references before deletion.
- [lab-observer.ts](../worker/lab-observer.ts), [lab-recording.ts](../src/lab-recording.ts) and [replay-tour.ts](../src/replay-tour.ts): project committed frames, validate a bounded capture and derive the trusted built-in tour.
- [ENGINEERING.md](ENGINEERING.md): invariants, tradeoffs, local reproduction and AI-assisted development disclosure.

Two resume bullets supported by the evidence:

- Implemented reference-aware retention in Cloudflare SQLite Durable Objects; a controlled two-target cron fixture reduced reads from 3,354 to 94 with grown policy/note history, preserving referenced evidence through rollback tests.
- Built a hibernating Durable Object WebSocket observer and bounded offline replay; captured a 25-frame real local Worker trace and tested reset fencing and original-socket recovery through forced hibernation.

Use claims for work you can explain and reproduce. The supplied 2027 internship posting emphasizes independent iteration, personal projects and Cloudflare use; it does not establish fast-track qualification. This guide makes no hiring, production-cost, native-AI or rendered-browser claim. Current deployment and verification boundaries remain in [Validation](evidence/VALIDATION.md).
