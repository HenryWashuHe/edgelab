# Observer terminal patch: local verification

Version 3.12.2 independently attempts the native WebSocket close when a terminal send throws. Observer/replay summaries label evaluated requests without a saved outcome **Unsettled outcomes**, with an explicit warning that some may have finished. [ADR 015](../../../adr/015-observer-terminal-cleanup.md) explains both changes.

The [terminal comparison](terminal-runtime.json), measured October 1 at 19:16:25 UTC, runs four actual local workerd/SQLite/network cases. It compares exact old `worker/index.ts` from commit `a830b2622a4e00759099da295467b0e5b8aadf8f` with the maintained index, using identical maintained dependencies. This is not a full historical deployment. Both builds preserve two original network peers through forced native hibernation. A fixture throws JavaScript before one terminal send delegates to a still-open native socket; all close calls and the healthy send remain native.

| Terminal path | Old selected peer                            | Repaired selected peer                                  | Healthy peer, both builds      |
| ------------- | -------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| Unavailable   | No terminal or close; one membership remains | No terminal; native close 1011; zero memberships remain | Terminal and native close 1011 |
| Expired       | No terminal or close; one membership remains | No terminal; native close 4001; zero memberships remain | Terminal and native close 4001 |

Unavailable injects a JavaScript error after consumed native config-save SQL; the config rolls back, while the earlier owner touch remains committed. Expiry uses a shortened fixture deadline and the real alarm to clear source state/events/deadline. Exact allowlisted decoded frames and static close reasons pass privacy assertions. All runtimes are disposed before the final source check and success artifact. Each gateway build pins 23 loaded buffers; origin and protocol graphs plus four recipe/package/config foundations are recorded separately.

The [existing observer suite](observer-runtime.json), measured at 19:09:41 UTC, passes 26 proof groups. Its completion-save/event-insert cases finish with HTTP 503, then show one evaluated request and zero saved outcomes, directly supporting the revised label. This older recipe pins only three source files; it does not claim complete graph coverage. The separate [capture manifest](lab-runtime.json), recorded at 19:09:46 UTC, pins 29 graph/foundation sources, stable through capture, and produces a new 25-frame [recording](lab-recording.json) with producer 3.12.2. Its canonical hash is `1af3e7397b6f3ff344ad7a7ba8ae511e5f76b453164b1ffe7ba0c3be691fd551`. That capture checks source stability before disposal, not after it. The bundled historical 3.6.0 recording is unchanged.

The [client build archive](client-build.json), measured at 19:12:11 UTC, matches all 16 maintained output files and retains the pinned 3.10.0 baseline and historical recording. `_headers` is deployment configuration, separately present in the asset directory; it is not a seventeenth client artifact. Local validation passes 295 application tests/24 files, 22 counter codec Node tests, nine inspector distribution groups, eight asset-verifier Node tests, TypeScript, build and both deployment dry-runs. The terminal recipe is included directly in CI.

| Frozen file           |  Bytes | File SHA-256                                                       |
| --------------------- | -----: | ------------------------------------------------------------------ |
| terminal-runtime.json | 18,767 | `a008ffa61e28e78416400c58fc8861087fd2b40314664aa9e4235072f73ce11f` |
| observer-runtime.json |  9,893 | `1a95d8e4d9fb24c115e8a222f56a7937394230e03097090b3401e0091b8ac731` |
| lab-runtime.json      |  7,150 | `e59d375d397742c567a090856d5abc353c6209f4e6c133830a5ce938fb870682` |
| lab-recording.json    | 14,249 | `636a3edadd171b89283cc03191c90891af0c5bd4b2fc3bb7800d76f3133314e2` |
| client-build.json     | 71,469 | `def0292d831134c76cc5011739650afa1874c4d6a5bf1db3246583e4a2af04dc` |

These are exact copies of recipe outputs. Embedded paths retain their original destinations. The send/SQL exceptions are controlled fixture failures, not natural native failures or observed production incidents. Close remains best effort if it itself throws. No rendered interaction, client application acknowledgement, natural TCP teardown timing, production resource cost, external adoption or diagnostic speed is established. This maintenance patch is engineering evidence, not evidence of unmet demand. Deployment and live verification are recorded separately in [validation](../../VALIDATION.md).
