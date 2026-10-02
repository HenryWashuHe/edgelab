# Request body lifetime proof

Captured October 2, 2026, 09:46:09–09:46:31 UTC from final 3.12.5 sources. [Native evidence](evidence.json) and [raw TAP](verification.tap) pass seven proof groups/eight Node tests, with 41 recorded observations and zero failures or skips. Reproduce with `node --test scripts/request-body.test.mjs`.

The baseline replaces only `worker/index.ts` with exact bytes from `5d2f2714197d3c54f3f99f177ab6c511275ecce0`; identical reached dependencies remain maintained. This is a gateway comparison, not a full historical deployment. Both profiles execute actual local workerd, SQLite Durable Objects and delegated native rate limiters. The fixture uses a 60-second lab idle lease and 1,000/60-second admission lanes; it does not measure production policy thresholds. Origin calls remain zero.

The old gateway waits for held constructed-stream cancellation on both POST paths during a 250 ms observation. The maintained gateway returns 413 without awaiting held or throwing cleanup. Read errors and constructed pre/mid-read aborts return sanitized 400 before admission or actor lookup; supplying bytes after the observed abort does not dispatch work. Exact 4,096-byte input, tiny/empty chunks, split Unicode, ordinary JSON validation and persisted note/config controls preserve behavior.

Actual Node HTTP sends an unfinished chunked upload to the native workerd direct loopback listener. The old gateway remains pending during the observed 250 ms, then accepts a completed valid body and persists capacity 19. The maintained gateway returns 408 at 10,005.72 ms, despite an additional write completing at 6,002.39 ms, with zero admission/namespace/stub calls. An infinite constructed empty-chunk stream separately returns 408 at 10,002.66 ms. Late supplied bytes are directly tested after abort, not after timeout.

The wire test bypasses Miniflare's Node front transport. Earlier failed transport/timing attempts remain in ignored local preview TAP files; they are not passing evidence. No `enable_request_signal` flag was added, and constructed abort tests do not establish network disconnect signaling. Both native runtimes are disposed and both raw sockets close before success evidence is written. All 24 maintained graph inputs and four foundation pins remain stable after disposal; the old graph reaches 23 inputs. Installed runtime versions are identified; the workerd binary is not independently attested.

The separate [client build archive](client-build.json), measured at 05:43:33 UTC, matches all sixteen maintained output files against its captured source graph. Its historical 3.10.0 baseline is reproduced. Direct client edits change release strings; generated module filenames also change. Browser rendering/loading, production fault behavior, resource cost, external usefulness and unmet demand remain unverified. See [ADR 016](../../../adr/016-request-body-lifetimes.md).

Release source `c5b7727afa608f2db58b5359d90696949c8146fe` passes [complete CI](https://github.com/HenryWashuHe/edgelab/actions/runs/37007779868). Gateway `7ed6d99c-c0dd-40d9-a4d8-eaca6bdcda82` is deployed with the private origin unchanged. The separate [live record](../3.12.5-live-monitoring.json), 70,726 bytes / SHA-256 `b32d337b7b2587bb294fc85611fb931756569b2f0035cbfd265d1cfd8c7bb313`, passed at 13:59:02 UTC: two fresh autonomous good minutes per service, current budgets, healthy readiness and all sixteen exact assets. The local slow-input faults were not sent to production.

| File                |  Bytes | SHA-256                                                            |
| ------------------- | -----: | ------------------------------------------------------------------ |
| `evidence.json`     | 42,284 | `e551bc0605194368c3c2c8166d4a3b0294e15072e93cb52f2818bdd4114dd2d3` |
| `verification.tap`  |  2,279 | `402b3edc5009543c2da4c6061522bfd85ae62e915e660b0e7105cf83ea181dc2` |
| `client-build.json` | 71,678 | `e59bf3382e3ba8ce829208cd8284886e74e31a21434248bad0c87372c36bc10d` |
