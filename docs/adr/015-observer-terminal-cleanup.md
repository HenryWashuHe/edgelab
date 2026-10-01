# ADR 015: independent observer terminal cleanup

## Decision

A terminal notification and its WebSocket close are separate best-effort operations. An exception from `send()` must not skip the subsequent close attempt. A close exception remains contained so cleanup continues for the other recipients. This changes no stored state, frame schema, retry policy or observer lease behavior.

Observer and replay summaries call `total − recorded outcome counts` **Unsettled outcomes**. This is an evidence gap: some evaluated requests may already have finished without a recorded outcome. Existing actual-workerd completion-save and event-insert injected-failure cases await a completed HTTP 503 response before observing `total=1` and zero outcome counts. The number alone cannot establish how many requests are running.

## Reproduced cleanup defect

The previous terminal loop put `send()` and `close()` in one try block. A controlled send-call exception left the selected socket open and enrolled, while a healthy recipient received its terminal frame and close. Both unavailable-storage and expiry paths had this behavior.

The regression runs actual local workerd, SQLite and two Node network WebSocket peers. It forces native hibernation while retaining the original sockets and attachments. A fixture throws JavaScript immediately before delegating one terminal send to a still-open native socket. Every close and the healthy send remain native operations. This is a controlled API failure, not an observed native send exception or a production incident.

The baseline loads exact `worker/index.ts` bytes from commit `a830b2622a4e00759099da295467b0e5b8aadf8f`, with the same maintained dependencies and fixture as the repaired build. It is a selected historical index comparison, not a complete historical deployment. Exact loaded source buffers, build graphs, recipe and package foundations are hashed and checked after runtime disposal.

For the unavailable case, a fixture exception follows consumed native config-save SQL inside the production transaction. The failed config rolls back, and the earlier successful owner touch remains visible. For expiry, a shortened fixture deadline triggers the actual alarm and source cleanup. The repaired selected peer still receives no terminal message, but receives the expected native server close control frame; both memberships are released. The healthy peer behaves correctly in both implementations.

## Limits

The fix independently attempts close; it cannot guarantee success if close itself fails. Received close control and released membership establish the tested cleanup behavior, not natural TCP teardown timing. Server sends do not acknowledge client application or rendering. The recipe excludes capabilities and private state from its report, and verifies the complete allowlisted wire frames and static close reasons before projecting results.

These are correctness and portfolio improvements. They do not establish natural failure frequency, diagnostic speed, external adoption or an unmet product need. [Release evidence](../evidence/releases/3.12.2-observer-terminal/README.md) preserves the measured comparison and its limitations.
