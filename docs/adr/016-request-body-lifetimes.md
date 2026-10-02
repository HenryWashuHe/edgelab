# ADR 016: bound incoming POST body lifetimes

## Problem

The gateway's 4,096-byte incoming body reader waited for every read and awaited cancellation after overflow. It had no completion deadline. A connected partial upload could therefore hold the gateway before owner admission or Durable Object lookup. [Cloudflare documents no hard HTTP invocation duration limit while the client remains connected](https://developers.cloudflare.com/workers/platform/limits/#duration); upstream probe deadlines do not cover input consumption.

A local native reproduction also held an oversized constructed stream's cancellation through a synthetic service binding. The gateway stayed pending for the observed 250 ms and returned 413 only after cleanup was released. That is a controlled stream fault, not a naturally observed external HTTP cancellation failure.

## Decision

One shared reader owns POST body consumption for operator and laboratory routes. It retains at most 4,096 body bytes in one fixed buffer, with a 10,000 ms completion deadline. It checks elapsed time before and after awaits and yields after every 64 reads so immediately resolved chunks cannot starve its timer. There is no chunk-count rejection; ordinary valid split bodies keep their previous behavior.

The first terminal result wins. Overflow returns the existing HTTP 413 error; timeout returns HTTP 408; unreadable or observed aborted input returns a sanitized HTTP 400. Existing route, method, capability and operator authentication checks still precede consumption. Only a successfully consumed body can reach owner admission or object lookup. Operator JSON validation and laboratory action validation remain separate.

Cleanup requests reader cancellation without awaiting it and releases the lock where possible. A late read or a rejecting/hanging cleanup cannot replace the terminal result or forward a mutation. Successful EOF releases the reader without cancellation. The decoder keeps existing UTF-8 replacement behavior; this change is not a stricter JSON or encoding contract.

## Scope and verification

Actual local workerd tests must compare the pinned old gateway with the maintained gateway, preserve ordinary input controls and distinguish constructed stream faults from a connected partial upload sent over real loopback HTTP. Rejected bodies must produce no actor or admission call; successful controls must execute the actual SQLite-backed actors. Source, fixture, build and dependency pins must remain stable through awaited disposal.

This bounds input consumption in the application. It does not establish exact provider termination timing, global resource capacity, production cost, attack frequency, client rendering or unmet demand. It does not guarantee that every network disconnect appears as `Request.signal` abort, and it does not roll back an actor mutation that has already been dispatched after successful consumption.
