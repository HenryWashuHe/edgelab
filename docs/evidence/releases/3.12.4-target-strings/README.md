# 3.12.4: require string monitor target identities and URLs

The target parser previously let JavaScript coerce IDs through a regular expression and URLs through `new URL()`. A numeric target ID could pass enrollment even though policy updates require an exact string identity. IDs and URLs now require JSON strings before normalization and duplicate checks. Valid string IDs, HTTPS normalization and existing transport restrictions are preserved.

The [native comparison](evidence.json) substitutes only the exact old parser from commit `69a27ee153dace7dd7dde86d83ceb271a2ac0db2`. Both variants execute the same maintained MonitorStore and its dependencies on actual local workerd SQLite. Numeric `7` becomes a stored TEXT identity `"7.0"`; policy updates using `7`, `"7"` or `"7.0"` all return 400. This is an unaddressable configured target, not a demonstrated numeric/string collision or revision churn. A single-element URL array was also accepted through coercion.

The strict parser rejects both malformed configurations before creating service, policy-version or audit rows. Two valid string targets retain their IDs and revision 1 through repeated authoritative exports and actual object eviction; a valid policy update returns 200 and advances revision 2 in both variants. The [raw TAP](verification.tap) passes both native groups with no skips. Six controlled object/configuration cases run in two disposed runtimes, with zero origin probes or account calls. Actual build-time project input buffers, the recipe and package/lock are pinned and remain stable through disposal. Installed native binaries are described by dependencies rather than independently hashed.

The unit regressions also reject omitted, null, numeric, boolean, array and object identities and malformed URL types, while preserving string IDs and default HTTPS port normalization. The runbook now states that origin transport keeps `https://origin.internal/<path>` while the service binding selects the renamed Worker.

This repairs a reproduced deployment-configuration failure. It does not measure natural production frequency, billing, customer adoption, diagnostic speed or an unmet product need. Existing valid production targets require no migration or configuration change. Publication, complete CI, client build and live verification are recorded separately after they pass.

## Local release verification

`npm run check` passes 297 application tests across 24 files, eight asset-verifier fault tests, 27 operator groups, formatting, TypeScript, the production build and both deployment dry-runs. The existing native monitor suite also passes scheduling, lease/revision fences, recovery, retention and readiness controls. The independent [client build](client-build.json) matches all sixteen maintained output files, with inputs stable through snapshot disposal. This is byte and source evidence; rendered interaction is unverified.
