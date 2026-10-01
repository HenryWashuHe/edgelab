# Existing-RPC counter proof

Measured October 1, 2026 at **18:14:59.803 UTC** using the exact sources pinned in [manifest.json](manifest.json). These five files are byte-for-byte copies of the passing local recipe outputs; the recipe's output filenames remain logical names within its original ignored output directory. This checkpoint adds the RPC-only wrapper and preserves the earlier [metered checkpoint](../manifest.json) and [3.12.1 parser patch](../../releases/3.12.1-evidence-json/README.md) unchanged.

Four ephemeral native workerd/SQLite runtimes run the bare original, metered adapter, RPC-only adapter and intentionally memory-only negative control. The original Counter is re-exported unchanged in the RPC wrapper, with the same class binding and existing read RPC. Both adapters preserve five normal-route outcomes and separately exercise actual network response loss before delegation and after the ordinary mutation response is consumed. Their samples show `0→0→0` and `0→1→1`, including a read after actual forced eviction. The separate memory control loses its value after eviction.

The RPC-only adapter adds no Durable Object methods, class, constructor or storage wrapper. Ten extra samples preserve the observed numeric value; three unsupported getter values are safely rejected. This is a structural setup reduction, not measured setup time. Profile 2 explicitly declares the gateway observation clock after the existing read RPC returns; profile 1 retains its DO-side clock. Native revision and commit time remain null, and an unsigned hash does not authenticate the declared source. Concurrent changes may occur between the sampled read and gateway timestamp.

All four artifacts pass strict import and inspection in a network-blocked Node subprocess. The manifest pins twelve project/tool/dependency inputs, checked again after all runtimes are disposed. All 22 codec tests pass; historical profile 1 hashes remain compatible. The original getter defaults absent/falsy values to zero, so its result is not arbitrary raw KV inspection. Storage meters and exact logical-call counts belong only to profile 1. SQL work, key-set/alarm preservation, latency, billing, production lifecycle timing, per-command attribution, external adoption and faster diagnosis are not established.

| Frozen file                                  | Bytes | SHA-256 of file bytes                                              |
| -------------------------------------------- | ----: | ------------------------------------------------------------------ |
| [manifest.json](manifest.json)               | 8,675 | `76726f072350ff71379fb78197ee085c2cdaca269bf4a61e186ac0b46b1c9f0f` |
| [before-loss.json](before-loss.json)         |   913 | `8646693509e62bccd78f554a416afd3057841fa948308328cb116442a33dfe9b` |
| [after-loss.json](after-loss.json)           |   913 | `52a313ae97af9f9f1096b39f3aac2c4ce7f61ac1d055da561facba7105ac9fbe` |
| [rpc-before-loss.json](rpc-before-loss.json) |   913 | `6af55fa0ece8328db2a37b654a7577e1f1ec83f828dfea463b700997556b6af2` |
| [rpc-after-loss.json](rpc-after-loss.json)   |   913 | `35a61ae5fc94d0d40ab0e74463050f60c38123c8526032a8d8dcf56984f7461f` |

File hashes above describe original bytes. Each artifact also contains its distinct unsigned hash of canonical validated contents. Reproduction commands and privacy limits are in the [experiment guide](../../../../examples/counter-evidence/README.md).

Implementation `13d10724e22a5e17c21ed00a927c83286c0d07da` passes [complete Linux CI](https://github.com/HenryWashuHe/edgelab/actions/runs/36905783792), including the four-runtime recipe, 22 counter codec tests, all application runtime regressions and actual local HTTP asset verification. Local checks also pass 295 application tests across 24 files, eight asset fault tests, TypeScript/build and both deployment dry-runs. All 16 rebuilt client assets match the frozen deployed 3.12.1 release; no production deployment was performed for this checkpoint.
