# 3.12.3: scope outcome evidence to the selected view and run

Observer and replay labels now call saved counters **Recorded outcomes** or **Recorded / evaluated**. They describe committed outcome evidence, rather than every physically finished request. The observer list is **Outcome rows in this view**. Replay lists rows for the selected run, with the number shown; its empty state no longer claims that the entire captured prefix contains no outcomes.

The bundled historical recording makes the replay error concrete: reset frame 15 has zero selected-run outcome rows, although earlier frames in the same captured prefix contain two outcomes from the previous run. The existing [tour test](../../../../tests/replay-tour.test.ts) checks the new-run bookmark and its empty row list. The [recording codec tests](../../../../tests/lab-recording.test.ts) independently verify run replacement and the twelve-row bound.

Saved run counters and shown rows cover different scopes. The existing [native observer recipe](../../../../scripts/lab-observer.mjs) verifies twenty saved outcomes with a twelve-row snapshot. Its completion-fault controls separately finish an HTTP 503 response after settlement-save/event-insert rollback, leaving one evaluated request without a saved outcome. Those are controlled local failures; they do not prove a successful committed response missing its event or an ordinary production view with positive counts and an empty list. The [historical observer archive](../3.5.0-lab-observer.json) remains separate.

This patch changes consumer text and coordinated release versions. It changes no counter arithmetic, observer protocol, merge/reset behavior, storage, owner controls or recording format. The bundled 3.6.0 recording remains byte-identical, with its historical producer and content hash unchanged. No new native fault recipe or copy-only assertion test was added.

## Local verification

`npm run check` passes 295 application tests across 24 files, eight asset-verifier fault tests, formatting, TypeScript, the production build and both deployment dry-runs. `npm run test:client-build` independently reproduces the current client under its declared dependencies and matches all sixteen maintained output files, with source pins stable through baseline snapshot disposal. The frozen [client-build.json](client-build.json), measured October 1, 2026 at 22:14:14 UTC, is 71,469 bytes with SHA-256 `4060c14f7165bebd55389b5d2d04680732af6c70794473bf0d3b0d04d5175383`.

The build archive is structural and byte evidence. It does not render the application or establish visual layout, browser interaction, production resource cost, diagnostic speed, external adoption or an unmet product need. CI, deployment and live verification are recorded separately after they pass.
