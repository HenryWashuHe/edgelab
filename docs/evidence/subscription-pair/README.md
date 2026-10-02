# Paired native storage and OT consumer proof

Captured October 2, 2026, 02:21:55–02:21:56 UTC from reviewed working-tree inputs based on `abcd46b6abbb18e1d32438d36be6cc79e4392565`. The [artifact](paired-boundary.json) pins those inputs, exact executed native/consumer bundles and the [raw TAP](verification.tap). All **10 checks passed with zero skips**: six native server checks and four paired cases. All four paired native runtimes and five clients were disposed with unchanged source hashes.

The [fixture](../../../examples/subscription-server/README.md) preserves 17 complete pinned source spans, including the full subscription replay/cleanup method, and unchanged typed-storage on real local SQLite Durable Object KV. Native synchronization and actual eviction retain the full controlled change payloads. Constructor instrumentation proves instance reconstruction independently of the upstream per-instance timestamp. Durable chat generation remains separate.

| Controlled observation                                               | Native chat generation / revision | OT model generation / revision | Existing client status          | Interpretation                                                                       |
| -------------------------------------------------------------------- | --------------------------------- | ------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| Base fetch held after a fulfilled facade callback enters `pushRow`   | 1 / 1                             | 0 / 0                          | Not ready, not fatal            | Initialization is pending; these generations cannot be compared.                     |
| Held base released and actual queue drained                          | 1 / 1                             | 1 / 1                          | Ready, not fatal                | Controlled quiescent OT model match.                                                 |
| Retained-row replay after actual eviction, then duplicate replay     | 1 / 2                             | 1 / 2                          | Ready, not fatal                | Existing replay reconstructs the model; duplicates add no consumer change callbacks. |
| Subscriber facade rejects its callback                               | 1 / 1                             | 1 / 0                          | Ready, not fatal                | Native row remains saved while this controlled consumer is behind.                   |
| Ordinary resubscription after that rejection                         | 1 / 1                             | 1 / 1                          | Ready, not fatal                | Existing replay recovers the model.                                                  |
| Downstream delegate throws, then native object is evicted and reread | 1 / 1                             | 1 / 1                          | Fatal; public `isReady()` false | Matching revisions do not establish successful downstream processing.                |
| Fresh consumer receives retained replay                              | 1 / 1                             | 1 / 1                          | Ready, not fatal                | Existing fresh-client replay succeeds; the original failed client remains fatal.     |

All observed clients are nondisposed at these samples. Native and consumer observation clocks are recorded separately; neither is a commit time. Native positions come from actual stored metadata, while the consumer uses the existing read-only internal probes and stable queue observer. `appliedRevision` denotes the upstream server-acked model position. A drained queue with ready/nonfatal/nondisposed status describes this controlled OT boundary, not editor processing or rendering.

This executes selected accepted-row/replay server paths and two pure client modules. Fixed accepted commands and base files, omitted validation/Git/user-DO activity propagation, identity message hydration, and subscriber/`NativeRpcStub` facades are disclosed. Real loopback HTTP transports the controlled rows; application RPC, UI callbacks, reconnection and rendering are not executed. No Cloudflare account, production mutation or full external application is involved.

Ordinary retained-row reads, the original client fatal/readiness signals and existing replay already expose the controlled answers. The result adds a reproducible regression proof and a bounded record of observations. It establishes no additional diagnostic answer, issue #305 reproduction, external integration, recipient benefit, demand, timing or billing improvement. See the [value assessment](../../PRODUCT_VALUE.md) and [pilot decision gate](../../WORKFLOW_PILOT.md).

To rerun from the repository root with Node 22.12+:

```sh
npm ci
npm ci --prefix examples/subscription-evidence --ignore-scripts --no-audit --no-fund
node --test --test-reporter=tap examples/subscription-server/server.test.mjs examples/subscription-server/paired.test.mjs
```

The final TAP diagnostic wraps actual post-disposal metadata in a `base64url-json-utf8` envelope to preserve literal characters through TAP escaping. Decoded byte count and SHA-256 bind it to the artifact; the nine individual observation diagnostics match the artifact. Hashes establish content consistency, not producer authenticity. This frozen capture is separate from the earlier [consumer-only proof](../subscription-boundary/README.md); those historical bytes remain unchanged.
