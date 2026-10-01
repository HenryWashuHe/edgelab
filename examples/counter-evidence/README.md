# Counter evidence portability experiment

This local experiment applies EdgeLab's bounded, allowlisted evidence approach to Cloudflare's independently authored [Build a counter example](https://developers.cloudflare.com/durable-objects/examples/build-a-counter/). Its mutation code is unchanged. The counter already supports read-only inspection; this experiment tests a small export and reproduction workflow, not a newly discovered counter defect or a general debugger.

With the repository dependencies installed, run:

```sh
node --test examples/counter-evidence/codec.test.mjs
node scripts/counter-portability.mjs
node examples/counter-evidence/inspect.mjs output/counter-portability/before-loss.json
node examples/counter-evidence/inspect.mjs output/counter-portability/after-loss.json
```

The recipe accepts no arguments. It starts three ephemeral local workerd runtimes and a local network proxy, disables optional metadata refresh/telemetry, uses no Cloudflare account and disposes its resources. It writes a passing manifest and two sample artifacts under the ignored `output/counter-portability/` directory. A failed run removes those success outputs. Inspection reads only the selected local artifact, with a 32 KiB bound before JSON parsing; it sends no network request and executes no recorded command.

## What the recipe establishes

| Controlled case                                                                | Client response | Initial sample | Sample after loss | Sample after forced eviction |
| ------------------------------------------------------------------------------ | --------------- | -------------- | ----------------- | ---------------------------- |
| Socket closed before delegation                                                | Unavailable     | 0              | 0                 | 0                            |
| Normal increment response consumed by the proxy, then downstream socket closed | Unavailable     | 0              | 1                 | 1                            |

Both clients observe uncertain delivery. The source meters independently show no storage calls from the first transport attempt, and exactly one logical `get` plus one `put` from the second. No retry is performed in either case. Read-only sampling reveals the resulting value without sending another increment.

The zero value uses the upstream counter's default and may represent an absent storage key. It is not evidence that a zero was written. The observed incremented value of one survives actual `unsafeEvictDurableObject()` eviction. A separate intentionally memory-only control returns one before eviction and zero afterward, demonstrating that the check distinguishes volatile state from retained state. This control is not passed through the upstream-pinned codec and is not an upstream defect.

## Adapter and overhead

[`adapter.mjs`](adapter.mjs) subclasses the original `Counter` and delegates normal Worker routes unchanged. A five-step bare-versus-adapted workload checks read, POST increment, GET increment, decrement and read parity. The upstream example permits GET mutations; the experiment preserves that behavior.

The local diagnostic routes add a fixed value-only storage read and a meter read. Bound native method delegates count attempted logical API calls while returning their original results/promises. They add no transaction, synchronization call, source write or alarm. Each recorded sample adds one logical KV `get`; the measured recipe also makes two separate meter RPCs around it. Those requests and normal output gating have overhead. These counts are not SQL rows, CPU, latency or billing measurements. The fixture is not deployed and has no production authentication interface.

[`codec.mjs`](codec.mjs) uses a distinct `edgelab-counter-samples` schema. It does not invent Lab circuit state, leases, source revisions or commit timestamps. Samples contain a recorder sequence, observation and receipt clocks, explicit null source revision/commit time, and one bounded integer. Names, IDs, URLs, requests, headers, arbitrary key-value data and raw errors are excluded. Failed appends preserve and close the valid prefix.

Capture holds at most 32 samples, each bounded to 1 KiB, with 1 KiB of finalization reserve and a 32 KiB finalized/import limit. Numeric-only valid captures remain well below the byte limit; that limit is an import/resource defense, not a measured reachable capture workload. Export clones and freezes before asynchronous SHA-256 hashing. Import rejects unknown fields, duplicate object names (including equivalent escaped spellings), mismatched source descriptors, invalid timestamps/sequences and content changes. Receipt clocks may regress; only recorder sequence orders samples. The [shared parser decision](../../docs/adr/014-unique-evidence-json.md) explains the decoded-name rule and resource bounds.

## Provenance and limits

The exact first JavaScript block is pinned to [cloudflare/cloudflare-docs commit `976c80e`](https://github.com/cloudflare/cloudflare-docs/blob/976c80e2120fdea5b4e1b1dd0eff2683802da981/src/content/docs/durable-objects/examples/build-a-counter.mdx). [`upstream/provenance.json`](upstream/provenance.json) records extraction and document/code/license hashes; [`LICENSE-CODE`](upstream/LICENSE-CODE) preserves Cloudflare's MIT attribution and original bytes. Formatting and Git whitespace rules exempt only the original code/license requirements. Every tested bundle input, the recipe, codec, inspector, package and dependency lock is hashed before the run and checked again after disposal.

Awaiting `storage.put()` alone does not prove that its write buffer reached disk. The normal [output gate](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) delays outgoing messages for pending writes. The proxy consumes the original normal response before withholding downstream delivery; the later eviction/read separately confirms retained state. `observedAt` is a time after a read, not a native commit timestamp. Differences between clocks are not network latency.

These are discrete samples in a controlled isolated workload. They cannot attribute a value to one request in arbitrary concurrent traffic, identify missed mutations, recover the original response, prove exactly-once execution, authenticate their producer or re-execute the program. A matching hash is an unsigned fingerprint of canonical validated data, not the original file bytes. Forced local eviction does not measure natural production lifecycle timing. This is one external-source adaptation; adoption, useful real-team integration and faster diagnosis remain unvalidated.

The [frozen local evidence](../../docs/evidence/counter-portability/manifest.json) records the measured source and environment. [Product value assessment](../../docs/PRODUCT_VALUE.md) defines the next user-validation gate.
