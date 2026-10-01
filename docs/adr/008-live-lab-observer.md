# Observe committed lab state through hibernating WebSockets

Status: accepted for EdgeLab 3.5.0, with actual local runtime and browser verification. Successful production observation, monitoring recovery and native inference remain separate gates.

## Problem

The resilience lab coordinates concurrent requests in a real SQLite Durable Object, but a second tab cannot follow its state without HTTP refreshes. Those refreshes renew the run's idle lifetime. A live observer should make token reservations, circuit changes, recovery and reset fencing visible while preserving the existing command and expiry boundaries.

## Decision

Use the existing `ReliabilityLab` object as a WebSocket server with the [Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). At most four observers attach to an existing run. The channel accepts no commands and adds no application heartbeat or server polling timer. Commands remain on the existing HTTP routes.

A same-origin link opens `#observer` in a second tab. It reads the browser's existing valid lab capability from local storage; observer-only entry cannot generate an identifier, initialize source state, call `/api/state`, renew the deadline or schedule an alarm. The UUID still grants HTTP lab control. The observer interface does not establish a separate authorization role.

The browser offers exactly `edgelab-observer-v1` and `edgelab-cap.<UUID>` as WebSocket subprotocols. The gateway validates method, Upgrade, same Origin and that bounded ordered pair before opening a Durable Object. It selects only the version protocol and preserves the returned WebSocket in its HTTP 101 response. The capability is absent from the URL and projected frames.

## State and publication

Source state retains an increasing revision and the timestamp of its actual commit in the existing state-row write. Reset changes the run ID and carries the prior revision forward. Legacy state has revision zero and an unknown commit time until an owner performs a real write. Connecting or rendering cannot supply a fresh commit timestamp.

Only genuinely absent metadata fields gain the legacy projection. Explicitly malformed or partial stored metadata is unavailable; it cannot be relabeled as an old run to bypass validation.

The initial frame projects committed state and at most twelve recent events. An update projects the complete committed state and at most one newly recorded event. Configuration, token balance, circuit, failures and run counters are available; cached payloads, request identifiers, raw messages and capability values are omitted. Unsettled outcomes are total evaluated requests minus recorded outcome counts; this does not prove work is still running. A request can finish while its outcome save fails, leaving the earlier admission without a recorded settlement. Rate-limited requests are included in total and settle immediately when their transaction succeeds. Displayed tokens are committed values, without a simulated refill.

Frames are captured once for a source commit and broadcast after its transaction succeeds. Event identity comes from the existing insert's returned ID. Fanout never performs a source query per viewer or rescans event history per mutation. A rolled-back state/event write cannot produce a phantom update. Earlier owner activity can already have committed before a later action fails, and must be described separately.

A failure inside `blockConcurrencyWhile` can reset the object before a sanitized terminal message reaches the peer. The client then reports a generic unavailable connection and marks retained evidence unconfirmed. Returning from `transactionSync` or awaiting native alarm setup inside that block does not alone establish durability: all three injected first-touch failure stages restored the prior source state, deadline and alarm in the tested runtime. Publication waits for the block's successful storage work. Reconnect obtains the actual stored snapshot; the client never guesses rollback or repeats an uncertain command.

Existing owner HTTP activity changes the idle lease as well as saving state. Its published revision and deadline must advance together, so observers do not retain an earlier deadline after the owner renews it. Observer attach, idle connection and reconnect remain read-only. Expiry closes observers; both the existing run/generation checks and the actual deadline fence late origin work. If owner activity reaches a known elapsed deadline before a delayed alarm, its transaction starts a new run and clears the old events before renewing the lease. It carries the revision sequence forward and closes old observers as expired after commit and alarm setup. Missing legacy deadlines preserve old source state on ordinary owner activity; observing cannot fill them in.

## Client behavior

The browser validates bounded, allowlisted frames before displaying them. Epoch guards prevent abandoned connections from overwriting a new view. Increasing same-run revisions advance state; a changed run ID clears the old event list, and a reconnect snapshot replaces it. Disconnect retains a clearly historical, unconfirmed view. A quiet connected channel waits for changes and does not imply stalled monitoring or a healthy origin.

Reconnect is manual and receives a new snapshot without replaying commands. Missing or replaced local storage clears the connection and requires an existing run. HTTP upgrade rejection is generally opaque to browser JavaScript; [the WebSocket standard](https://websockets.spec.whatwg.org/) constrains failure details. Unknown failures therefore receive generic connection-unavailable wording. Only validated terminal messages or known close codes explain expiry or unavailability.

## Verification and resource limits

The [actual local workerd record](../evidence/releases/3.5.0-lab-observer.json) passes 26 proof groups covering multiple clients, isolation, capacity, ordering, pending admission, reset and deadline races, executed transaction rollback, bounded projection, protocol validation and expiry. `Miniflare.unsafeEvictDurableObject(..., { webSockets: 'hibernate' })` preserves the original network sockets and attachments through a real constructor restart in this integration. This forced eviction does not measure natural production hibernation timing.

The same fixed owner workload (configuration, two successful requests and reset; ten updates) uses 33 SQL statements, 28 rows read and 16 written with zero, one or four observers. Each profile also performs ten KV gets, four KV puts and four alarm sets. A warm handshake separately reads two SQL rows and one KV deadline, with zero writes or alarm renewal. A cold unknown observer performs constructor DDL (six rows read and nine written in this fixture), but creates no run, deadline or alarm. After a warm alarm deletes storage, an observer cannot recreate schemas; legitimate owner activity can rebuild them. These SQL counts exclude hidden KV/alarm storage work, which is reported separately.

[Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) meters connection requests and storage; KV and alarm operations also use the storage allowance. Eligible hibernation avoids idle duration charges, but this controlled workload establishes neither account-wide capacity nor a measured production bill.

The [browser record](../evidence/releases/3.5.0-browser-qa.json) verifies two-tab changes, original sockets after forced hibernation, pending versus settled requests, reconnect/reset, malformed-frame handling, idle expiry, missing-session entry and actual 390px document bounds. Leaving an owner page while its request is pending produces no abandoned follow-up state GET. Only tested interactions are claimed; storage denial and cross-tab capability replacement are guarded in source but were not separately browser-injected. A quota-failed deployed upgrade establishes only the unavailable boundary. Successful production observation requires separate evidence after storage recovers.

Local close verification distinguishes receiving the server's close frame and release of application socket membership from completion of TCP shutdown. The current workerd network test can remain in the closing transport state after HTTP-initiated closure despite receiving the correct code. Its network peer uses a bounded close timeout; that test cannot claim natural teardown timing in production.
