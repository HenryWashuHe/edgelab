# Inspect a bounded interval of recorded observer evidence offline

Status: accepted for the EdgeLab 3.6 release candidate. Local codec, actual Worker trace and offline browser checks pass. Production observation and autonomous monitoring recovery remain separate gates.

## Problem

The laboratory's JSON/CSV report contains completed outcomes, while the live observer retains at most twelve recent events. Neither preserves the observed admission, pending-work and committed-state sequence for a reproducible demonstration. An offline recording should retain that coordination evidence without polling the object, adding source writes or requiring a healthy live account to inspect an already captured file.

## Decision

Capture the accepted initial snapshot and subsequent validated frames for one observer connection in browser memory. No rejected raw bytes, capability, request identifier, payload, cookie, authorization header or URL enters the file. Capturing adds no application HTTP requests, WebSocket messages, source storage writes, heartbeat or browser persistence. The observer connection retains its existing lease and hibernation behavior.

A recording is bounded to 256 entries and 192 KiB of finalized UTF-8 JSON. Reserve 1 KiB for final metadata and the hash, then check the finalized size. Reaching either limit freezes the valid prefix; it never silently discards the initial snapshot. The live observer can continue after recording stops. Stop, disconnect, interruption, validated terminal messages and invalid-frame rejection finish the interval with an explicit reason. Reconnect starts a separate recording; the interface must make replacement clear and permit downloading the previous one first.

Each entry preserves the validated server frame and a separate recorder receipt timestamp. The live view uses the browser clock; the controlled example uses its network peer's clock. Array order is receipt order; local clock regression cannot reorder it. Server frame time, actual source commit time and recorder receipt time remain distinct. Their differences are not a measured network latency because the clocks can differ. Unknown legacy commit time remains null.

## File and import boundary

Schema version 1 records the observer protocol, producer version, first/last receipt times, bounded entries and a finalized reason/time. Only one initial snapshot is accepted. Updates require increasing revisions across run changes; terminal frames end the stream. Extra snapshots, frames after a terminal, invalid dates or counters, unsupported versions and extra/private fields are rejected. Revision jumps identify unobserved commits without inventing their transitions or request outcomes.

A canonical SHA-256 content hash is computed from an immutable copy captured before asynchronous hashing. Strict import validates byte/count limits and exact metadata/frame shapes before accepting the hash. The hash detects changed content; anyone can recompute it, so it establishes neither authenticity nor server origin. A recording is an observed interval, not a full event backup or deterministic re-execution.

## Offline viewer

Import and step inspection use a separate `#replay` route. Direct entry cannot connect a socket, fetch an application API, read or create a capability, persist a file or execute recorded commands. Check `File.size` before reading; stale asynchronous imports cannot replace a newer selection or update an unmounted view. Error messages do not echo rejected file contents.

Previous/Next and a native keyboard-accessible scrubber select an entry without automatic playback timers. Show the recorded token balance, pending/settled counts, circuit, revision and timestamps. Reconstruct only the captured prefix's latest twelve events; run changes clear earlier-run event identity. Gaps and the interval's end reason remain visible. No interpolation, inferred refill, fresh monitoring label or confident all-clear is added.

## Verification gates

- Pure tests cover strict shape/privacy rejection, malformed hash/version/dates, UTF-8 bytes, both limits, prefix preservation, immutable asynchronous hashing, revision/terminal ordering, gaps, legacy timestamps and receipt clock regression.
- A reproducible actual local workerd recipe records a real network socket through pending/completed work, reset fencing and forced original-socket hibernation. Source/recipe/bundle hashes and the controlled environment are pinned separately. Equivalent reruns need not have identical timestamps or run UUIDs.
- Browser checks establish direct offline entry, built-in sample validation, keyboard stepping, disclosure and actual mobile bounds with zero application API requests. File upload and isolated live-lab access were declined; they were not retried through another surface. Live browser capture/download, file chooser rejection and injected stale asynchronous UI actions remain unverified. Strict file rejection and immutable asynchronous export are covered by pure tests; the actual network recipe exports/imports a valid recorded interval. UI epoch guards are independently reviewed, not fault-injected browser evidence.
- The controlled example is labeled recorded test evidence. It establishes no successful production observation, natural hibernation timing, account capacity, native model execution or recovery from the current storage failure.
