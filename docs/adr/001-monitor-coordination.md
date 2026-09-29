# ADR 001: a bounded monitoring coordinator

Status: accepted for EdgeLab v3.

## Problem

An in-browser resilience lab demonstrates algorithms but does not operate a system. Monitoring must continue without a browser, retain incident history, survive restarts, and avoid duplicate samples or false recovery when the scheduler retries or configuration changes during a request.

## Decision

Use a singleton SQLite-backed Durable Object for at most five deployment-approved services, driven by a one-minute Cron Trigger. Keep the existing per-session laboratory class separate.

Each service/minute job claims a persisted token and 30-second lease inside a synchronous transaction. An active lease prevents another minute for that service from overlapping. Probe I/O happens outside the transaction with a maximum 10-second budget. Completion checks the lease token and service revision, then atomically stores the uniquely keyed sample, advances streaks, records incident transitions, and completes the job. Expired claims can be replaced after a crash. Repeated completed minutes are no-ops. Stale policy results release their reservation and do not enter SLO history.

Streaks advance only for increasing consecutive slots. Out-of-order samples cannot change the latest incident state. Gaps reset streaks without closing an existing incident. Maintenance resets streaks and leaves open incidents intact. A partial unique SQLite index provides a second invariant against two open incidents for one service.

The public Worker exposes status only without credentials; operator endpoints verify a deployment secret before the DO is addressed. Target URLs are deploy-time configuration. There is no public scheduler or arbitrary fetch endpoint. Policy writes include an expected revision to prevent lost updates.

## Alternatives and tradeoffs

A DO per service would improve isolation and scale but complicate cross-service read models. A relational database plus queue could scale fan-out but adds coordination and delivery machinery disproportionate to five targets. A browser timer is insufficient because it stops when the tab closes. A stateless cron alone cannot safely deduplicate retries or preserve failure streaks.

The singleton is a throughput/availability boundary. Probe concurrency is bounded by target count, and network I/O is not inside an object-wide lock. Lease expiration is recovery permission, not proof that old code stopped; fencing is still required. A provider-wide outage can affect both the monitor and its targets. These are intentional, documented constraints, not claims of an unbounded SaaS architecture.

## Verification

The runtime suite sends twelve concurrent deliveries of a slot and proves one stored check/one upstream call. It tests incident acknowledgement, recovery, object eviction, revision races, active and expired abandoned leases, retention, and the actual Worker scheduled handler. Unit tests cover gaps, out-of-order observations, bounds, redirects, invalid bodies, network failures, and body-consumption timeouts.
