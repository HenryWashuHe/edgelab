# Standalone counter inspector

This frozen **13,463-byte** [inspector](inspect-counter.mjs) can inspect the two pinned counter profiles with Node.js 22.12+ and a selected artifact. The recipient needs no repository, npm dependencies or Cloudflare account access:

```sh
node inspect-counter.mjs local-artifact.json
```

Building still requires the repository dependencies. Reproduce the build and distribution checks with:

```sh
node scripts/build-counter-inspector.mjs
node --test --test-reporter=tap scripts/counter-inspector.test.mjs
```

The [build manifest](manifest.json), measured October 1, 2026 at **18:33:37.716 UTC**, records the exact three source buffers supplied to esbuild, three recipe/package/lock foundation pins, explicit options and the generated file SHA-256. It disables implicit tsconfig loading, requires one ESM output and permits only `node:crypto`, `node:fs/promises` and `node:url` as runtime imports. All six pins remain stable after the build. This manifest describes a build only; its `dependencyFreeExecutionVerified: false` field is intentional.

The separate [actual Node test report](verification.tap), verified at **18:33:40.275 UTC**, passes nine groups on Node 25.4.0/macOS with zero skipped tests. It identifies the same bundled byte hash. Twenty-eight inspector subprocess cases run copied bytes outside the checkout with no `node_modules`, cleared Node search/options/output variables and a test-only denial preload. Six frozen artifacts cover both profiles; spaced and renamed filenames, an explicit directory symlink, pretty/reordered JSON and historical hashes retain their reports. Duplicate/escaped private aliases, unsupported sources/fields, altered content/hash, invalid UTF-8, missing/directory files and invalid arguments return only static errors. Exactly 32 KiB is accepted; one byte more is rejected. An actual unwritten POSIX FIFO fails safely before waiting for a writer. Every child leaves the fixture tree's names, types, modes, sizes and file hashes unchanged.

A separate control verifies 21 named network and child-process API denials. These are instrumented Node entrypoints, not an operating-system sandbox; unchanged-file checks cover the controlled fixture tree. Source review establishes read-only file access, not a general filesystem wall-clock deadline. The [verification source pins](verification-source-pins.json) separately identify the test recipe, six archive byte hashes and raw test-report hash, checked after verification. Bundle and artifact hashes detect changes against trusted references; neither authenticates the publisher or declared capture source.

Two real CLI defects were reproduced and repaired during this checkpoint: blocking FIFO open before the regular-file check, and silently skipping inspection when Node canonicalized a symlinked launch path. Nonblocking read-only open where available and a canonical entry check address them. Local builder CLI checks also verified static invalid-argument failure, removal of old success/temporary outputs and successful rebuild through a symlink with the same bundled bytes. These builder checks are separate from the frozen inspector test report.

| Frozen file                                                    |  Bytes | SHA-256 of file bytes                                              |
| -------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| [inspect-counter.mjs](inspect-counter.mjs)                     | 13,463 | `6c5bb2748725d0f31bdc0e320afc69e79755bac44b5a13a01cb0d6ef47e623bb` |
| [manifest.json](manifest.json)                                 |  3,368 | `691133a7a943f39a17f4d67f76545b4a6ebdb709d007274843f1bbabff4114be` |
| [verification.tap](verification.tap)                           |  3,372 | `72c976a180cf1cb32186302afbee8bfbf6e136f86c9b5c122005baeedd3367e4` |
| [verification-source-pins.json](verification-source-pins.json) |  1,857 | `d7da80666eefa71c3a9129f793f0aadb6c98f6b97dddd1b874fe6712f4f29121` |

The [experiment guide](../../../examples/counter-evidence/README.md) retains capture, clock and causality limits. Packaging reduces recipient prerequisites; it does not capture another application's state, measure setup time, establish adoption or show faster diagnosis. This checkpoint changes no production Worker or client asset, and preserves all earlier frozen evidence.

Local checks pass 295 application tests across 24 files, 22 counter codec tests, nine distribution groups, eight asset fault tests, formatting, TypeScript/build and both deployment dry-runs. All 16 rebuilt client assets match the frozen deployed 3.12.1 archive. No production deployment or rendered browser interaction was performed for this checkpoint.
