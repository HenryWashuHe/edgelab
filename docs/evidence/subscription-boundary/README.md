# Controlled OT consumer boundary proof

The [local recipe](../../../examples/subscription-evidence/README.md) executes two exact pure modules from Cloudflare OS revision `1ef6020a42fbabb6d27dd1063db3a075ba95c974`. The [frozen report](model-boundary.json) preserves the complete five-input build graph, original and adapted byte hashes, exact dependency versions/integrities, seven actual numeric/boolean observations, and post-execution source stability. The [actual TAP output](verification.tap) records all ten passing checks with no skips.

The archived run began at **2026-10-02 01:11:54.128326 UTC** and finished at **01:11:54.499394 UTC**, on Node 25.4.0/macOS with esbuild 0.28.1. The original client and code-change source bytes remain unchanged. The emitted temporary bundle was 173,942 bytes, SHA-256 `c9d0928be711d745bafdd56c00a0fb0c5cb65b07b393f47fc213b67d34f5db81`; only the in-memory client copy adds a read-only model snapshot and queue observer. The archive's base commit predates this experiment; exact working-tree input hashes identify the tested recipe.

| Controlled observation                              | Generation | Model revision | Raw ready | Fatal | Public `isReady()` |
| --------------------------------------------------- | ---------: | -------------: | --------- | ----- | ------------------ |
| `pushRow` returned while the base fetch was held    |          0 |              0 | false     | false | false              |
| Queue drained after releasing the base fetch        |          1 |              1 | true      | false | true               |
| Invalid text application failed                     |          1 |              1 | true      | true  | false              |
| Downstream callback, before its controlled throw    |          1 |              1 | true      | false | true               |
| Queue caught that downstream failure                |          1 |              1 | true      | true  | false              |
| Before the existing materialized-watermark recovery |          1 |              0 | true      | false | true               |
| After that recovery                                 |          1 |              2 | true      | false | true               |

These positions describe the internal OT model. The fourth and fifth observations show why an advanced revision cannot prove that the downstream callback finished successfully. The upstream public readiness/fatal notifications already expose the failure. The first observation proves only that `pushRow` returned with work still pending; actual RPC callback fulfillment was not executed. Generation 0 before initialization is constructor state, not a sampled server position.

The remaining checks preserve contiguous missing-row replay, duplicate delivery, future-generation gating, fresh-client reconstruction and disposal during a held fetch. Materialized snapshot and base-file inputs are synthetic; their input revision is coherent with the materialized watermark. Existing recovery is retained rather than disabled to create a gap. Every controlled client is disposed, the temporary bundle is removed, and all captured source input bytes remain unchanged after execution and disposal.

This is a preliminary technical boundary experiment. It does not execute the full application, persisted producer, Cap'n Web transport, editor or browser. It establishes no actual server commit, rendering health, reproduction or resolution of issue #305, novel diagnostic answer, user adoption, diagnosis speed improvement or unmet product need. The [product assessment](../../PRODUCT_VALUE.md#independent-application-assessment-stale-subscriptions) retains the paired server/consumer experiment and external workflow validation as outstanding work.
