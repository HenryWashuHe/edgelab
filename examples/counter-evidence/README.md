# Counter evidence portability experiment

This local experiment applies EdgeLab's bounded, allowlisted evidence approach to Cloudflare's independently authored [Build a counter example](https://developers.cloudflare.com/durable-objects/examples/build-a-counter/). Its mutation code is unchanged. The counter already supports read-only inspection; this experiment tests a small export and reproduction workflow, not a newly discovered counter defect or a general debugger.

With the repository dependencies installed, run:

```sh
node --test examples/counter-evidence/codec.test.mjs
node scripts/counter-portability.mjs
node examples/counter-evidence/inspect.mjs output/counter-portability/before-loss.json
node examples/counter-evidence/inspect.mjs output/counter-portability/after-loss.json
node examples/counter-evidence/inspect.mjs output/counter-portability/rpc-before-loss.json
node examples/counter-evidence/inspect.mjs output/counter-portability/rpc-after-loss.json
```

The recipe accepts no arguments. It starts four ephemeral local workerd runtimes and a local network proxy, disables optional metadata refresh/telemetry, uses no Cloudflare account and disposes its resources. It writes a passing manifest and four sample artifacts under the ignored `output/counter-portability/` directory. A failed run removes those success outputs. Inspection needs Node and this repository's inspector/codec/shared parser files, rather than installed npm dependencies; it reads only the selected local artifact, with a 32 KiB bound before JSON parsing, sends no network request and executes no recorded command.

## Share an inspector without the repository

The maintainer can build a standalone inspector with installed repository dependencies:

```sh
node scripts/build-counter-inspector.mjs
node --test scripts/counter-inspector.test.mjs
```

Copy `output/counter-inspector/inspect-counter.mjs` and a selected sample artifact to the recipient. With Node.js 22.12+ installed, the recipient runs:

```sh
node inspect-counter.mjs local-artifact.json
```

The recipient does not need the repository, npm dependencies or Cloudflare account access. The file includes the existing bounded codec and duplicate-name parser, supports only the two pinned counter profiles and retains their declared clocks and unsigned-hash limits. Building the inspector does not capture evidence or adapt another application.

The builder records SHA-256 hashes for the exact three bundled source inputs, its recipe/package/lock, build options and generated file bytes. These identify the inspected code against a trusted reference; they do not authenticate its publisher. The [frozen distribution proof](../../docs/evidence/counter-inspector/README.md) records copied and renamed execution outside the checkout, with test instrumentation denying network and child-process APIs. That instrumentation is not an operating-system sandbox. The CLI opens inputs read-only, rejects non-regular files, reads at most 32 KiB plus one byte and reports only a static error on failure. POSIX nonblocking open prevents an unwritten FIFO from stalling before the type check; filesystem operations are not given a general wall-clock deadline.

## What the recipe establishes

| Controlled case                                                                | Client response | Initial sample | Sample after loss | Sample after forced eviction |
| ------------------------------------------------------------------------------ | --------------- | -------------- | ----------------- | ---------------------------- |
| Socket closed before delegation                                                | Unavailable     | 0              | 0                 | 0                            |
| Normal increment response consumed by the proxy, then downstream socket closed | Unavailable     | 0              | 1                 | 1                            |

Both adapters run these two isolated cases, for four unavailable client responses in total. The metered adapter independently shows no storage calls from its first transport attempt, and exactly one logical `get` plus one `put` from its second. The RPC-only adapter has no storage meters. No retry is performed in any case. Read-only sampling reveals the resulting value without sending another increment.

The zero value uses the upstream counter's default and may represent an absent storage key. It is not evidence that a zero was written. The observed incremented value of one survives actual `unsafeEvictDurableObject()` eviction. A separate intentionally memory-only control returns one before eviction and zero afterward, demonstrating that the check distinguishes volatile state from retained state. This control is not passed through the upstream-pinned codec and is not an upstream defect.

## Adapter and overhead

Two fixed adapter profiles share the same pinned upstream source. A five-step workload compares the bare original with both adapters: read, POST increment, GET increment, decrement and read. The upstream example permits GET mutations; the experiment preserves that behavior. Both fixtures are local and have no production authentication interface.

| Profile                                 | Integration                                                                                                                                                                        | Observation clock                            | Diagnostic meter RPCs per captured sample |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| 1: [`adapter.mjs`](adapter.mjs)         | A separate `Counter` subclass wraps native storage delegates for local meters and adds a value-only read.                                                                          | Durable Object after the additional KV read. | 2                                         |
| 2: [`rpc-adapter.mjs`](rpc-adapter.mjs) | A Worker wrapper re-exports the original `Counter` unchanged and calls its existing `getCounterValue()` RPC. No new Durable Object methods, class, constructor or storage wrapper. | Gateway after the existing read RPC returns. | 0                                         |

Profile 2 samples the public getter result, whose upstream implementation defaults absent/falsy stored values to zero. It does not inspect arbitrary raw KV data. Ten extra samples preserve the observed numeric value; the final normal read remains one. Three locally constructed unsupported getter results (out-of-range integer, fraction and string) produce only a static 503 error with `no-store` and `nosniff` headers. Successful samples have the same headers; the local sample route requires GET and a name.

Profile 1's local diagnostic routes add a fixed value-only storage read and a meter read. Bound native method delegates count attempted logical API calls while returning their original results/promises. They add no transaction, synchronization call, source write or alarm. Each profile 1 recorded sample adds one measured logical KV `get`; the recipe makes two separate meter RPCs around it. Profile 2 makes one existing read RPC per sample, and source review shows one logical KV `get` inside that getter. The profile 2 recipe does not meter storage calls or establish key-set/alarm preservation. These requests and normal output gating have overhead. Neither profile measures physical SQL rows, CPU, latency or billing.

[`codec.mjs`](codec.mjs) uses a distinct `edgelab-counter-samples` schema. It does not invent Lab circuit state, leases, source revisions or commit timestamps. Samples contain a recorder sequence, observation and receipt clocks, explicit null source revision/commit time, and one bounded integer. Names, IDs, URLs, requests, headers, arbitrary key-value data and raw errors are excluded. Failed appends preserve and close the valid prefix.

Capture holds at most 32 samples, each bounded to 1 KiB, with 1 KiB of finalization reserve and a 32 KiB finalized/import limit. Numeric-only valid captures remain well below the byte limit; that limit is an import/resource defense, not a measured reachable capture workload. Export clones and freezes before asynchronous SHA-256 hashing. Import accepts only the two exact pinned source descriptors; the declared adapter version is part of the canonical hash. Existing profile 1 artifacts and hashes remain compatible. Import rejects unknown fields, duplicate object names (including equivalent escaped spellings), mismatched source descriptors, invalid timestamps/sequences and content changes. Receipt clocks may regress; only recorder sequence orders samples. The [shared parser decision](../../docs/adr/014-unique-evidence-json.md) explains the decoded-name rule and resource bounds.

## Provenance and limits

The exact first JavaScript block is pinned to [cloudflare/cloudflare-docs commit `976c80e`](https://github.com/cloudflare/cloudflare-docs/blob/976c80e2120fdea5b4e1b1dd0eff2683802da981/src/content/docs/durable-objects/examples/build-a-counter.mdx). [`upstream/provenance.json`](upstream/provenance.json) records extraction and document/code/license hashes; [`LICENSE-CODE`](upstream/LICENSE-CODE) preserves Cloudflare's MIT attribution and original bytes. Formatting and Git whitespace rules exempt only the original code/license requirements. Every tested bundle input, the recipe, codec, inspector, package and dependency lock is hashed before the run and checked again after disposal.

Awaiting `storage.put()` alone does not prove that its write buffer reached disk. The normal [output gate](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) delays outgoing messages for pending writes. The proxy consumes the original normal response before withholding downstream delivery; the later eviction/read separately confirms retained state. `observedAt` is a time after a read, not a native commit timestamp. Profile 2's gateway timestamp can follow intervening concurrent mutations; it is not the actor's read or linearization time. Differences between clocks are not network latency. The inspector reports the clock origin declared by the validated adapter profile; the unsigned artifact does not authenticate that declaration.

These are discrete samples in a controlled isolated workload. They cannot attribute a value to one request in arbitrary concurrent traffic, identify missed mutations, recover the original response, prove exactly-once execution, authenticate their producer or re-execute the program. A matching hash is an unsigned fingerprint of canonical validated data, not the original file bytes. Forced local eviction does not measure natural production lifecycle timing. This is one external-source adaptation; adoption, useful real-team integration and faster diagnosis remain unvalidated.

The [first frozen local evidence](../../docs/evidence/counter-portability/manifest.json) retains the original metered experiment. The [second frozen local evidence](../../docs/evidence/counter-portability/rpc/manifest.json) adds the smaller RPC-only wrapper alongside it. Zero Durable Object source changes are a structural setup improvement, not a measured setup-time or user-adoption result. This fixed recipe still does not attach to an existing deployed application. [Product value assessment](../../docs/PRODUCT_VALUE.md) defines the next user-validation gate.
