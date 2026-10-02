# Local persisted producer and replay fixture

This fixture runs selected exact Cloudflare OS server bodies from revision `1ef6020a42fbabb6d27dd1063db3a075ba95c974` on an ephemeral Miniflare SQLite Durable Object. It imports the unchanged typed-storage module, which uses native `storage.kv` and `transactionSync`. It does not replace durable storage with a Map.

From the EdgeLab repository root, after `npm ci` and the isolated consumer dependency installation:

```sh
node --test examples/subscription-server/server.test.mjs examples/subscription-server/paired.test.mjs
```

The fixture depends on root-pinned esbuild, Miniflare and workerd. Hardcoded byte spans with independently checked fragment lengths and SHA-256 values copy complete named methods and collection assignments, including the entire `subscribeToChat` catch-up, retained-row replay and cleanup body. Every selected source span, fragment hash, original source hash, runtime package version and emitted bundle hash is disclosed in execution metadata. Original upstream source bytes and the Apache license are retained under `upstream/`.

The wrapper supplies fixed synthetic already-accepted code rows. It does not execute the full agent/tool producer, Git reads, API validation, authorization or submission idempotency path. External user-DO activity propagation is a no-op; the original monotonic chat timestamp helper and indexed collections remain intact. Non-action message hydration is a controlled identity delegate; unsupported action hydration throws. Retire and message commands do not execute actual materialization or epoch transitions.

`NativeRpcStub` and subscriber are controlled facades. Callback fulfillment or rejection is an injected policy before a separate Node bridge feeds the real stored row to the actual OT client. It is not native RPC or an acknowledgement of completed consumer processing. Complete original rejection/unsubscribe and retained replay logic runs unchanged. All local controller calls use bounded Node HTTP fetches to a loopback-only Miniflare listener; automatic remote `cf` metadata and telemetry are disabled.

`storage.sync()` runs before responses and eviction. `unsafeEvictDurableObject` performs actual local eviction. A constructor-only persisted fixture ordinal independently demonstrates instance reconstruction. The original per-instance `streamGeneration = Date.now()` is separate from durable chat generation/revision; timestamp inequality is not used to prove eviction.

Internal bridge responses contain fixed controlled row content and the actual stored code-base snapshot for the paired consumer. Published observations must contain only numeric positions, booleans and fixed statuses, with no row content or identifiers. Successful persistence/replay in this selected path does not establish every rollback/output-gate failure, full application transport or rendering correctness, issue #305 reproduction, a novel diagnostic answer or unmet user need.
