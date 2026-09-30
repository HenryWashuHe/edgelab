# EdgeLab v3.1: reliability operations and incident evidence

Goal: evolve the interactive resilience lab into a complete, self-hostable reliability application with an operating service, durable history, an operator workflow, and reproducible evidence.

Acceptance requirements (completion requires evidence for every item):

- A real scheduled Worker checks deployment-approved HTTPS services and private service bindings without an open browser. Public callers cannot choose targets or trigger probes.
- SQLite-backed monitoring persists checks, service policies, incidents, acknowledgement, and audit events across eviction and deployment. Existing laboratory data remains compatible.
- Duplicate/retried/overlapping schedules cannot double-count samples or create duplicate incidents. Leases recover interrupted work; stale completions cannot overwrite changed policies.
- Incidents open after consecutive bad observations, recover after consecutive good observations, and permit authenticated acknowledgement with a bounded operator note.
- Reporting includes observed good-check ratio, latency percentiles, error-budget consumption, missing-sample coverage, freshness, and explicit measurement limits. Gaps never become successful checks.
- Scheduled checks start only in the current UTC minute. Delayed invocations are skipped with persisted diagnostic evidence and never backfill history. Each new check retains its actual start timestamp; a completion crossing a minute boundary keeps the original slot. Migrated checks with unknown start time remain visible but receive no verified SLO credit.
- `GET /api/ready` evaluates persisted scheduler completion and active-service freshness against an inclusive three-minute bound. Only healthy readiness returns 200; starting, partial, and stalled return 503. Paused services are ignored, and dashboard reads cannot renew the evidence.
- Public incident lists include every open incident for active deployment targets plus their latest 100 resolved incidents. `GET /api/ops/incidents/<id>?before=<slot>` provides 50 descending retained checks per page, lifecycle timestamps, retention bounds, and policy versions referenced on the page. Older open incidents cannot be hidden by a recent resolved-record limit.
- Policy versions captured at enrollment and subsequent changes preserve their context with `recorded` provenance. Migration labels the available current policy `recovered-current` and does not invent older policy history. Missing historical versions remain unknown.
- A valid bearer token adds private evidence to incident detail. `POST /api/ops/incident-note` supports a UUID v4 request ID, a 1–500-character nonblank note, at most 100 retained notes per incident, and idempotent retries of an identical payload. Conflicting reuse returns 409; recovered incidents permit follow-up notes.
- Public operations UI includes service health, history, incidents, reliability trends, export, and methodology; owner controls support policy editing, maintenance pause, and acknowledgement. The laboratory remains available.
- Operator writes require a deployment secret, same-origin browser requests, bounded and validated payloads. Public data excludes secrets, private target URLs, and operator notes. Probe targets are deploy-time configuration, redirects are not followed, time and response consumption are bounded.
- Unit and actual-runtime tests cover incident state transitions, retries, concurrency, crash/lease recovery, policy races, auth, retention, and persistence. Existing lab checks continue passing.
- A repeatable benchmark reports measured concurrency behavior with environment and methodology, without invented production or global-scale claims.
- OpenAPI, operator runbook, architecture decisions, threat boundaries, CI, and deployment instructions match the shipped implementation.
- Operations exports use `schemaVersion: 4`, separate unverified checks from verified SLO metrics, and include readiness plus 20 recent persistent scheduler diagnostics. Diagnostics and appended notes have 30-day retention; open incident records remain retained, with evidence limits explicit.
- Publish verified code and the working upgrade; verify live scheduled samples and record the exact tested revision. Do not claim a long operating history immediately after deployment.

Implementation phases: monitoring domain and storage; scheduled/API integration; operations UI; failure tests and benchmark; incident evidence and policy history; timing correction and readiness; documentation; deployment and completion audit. A release is complete only after its exact deployed revision and runtime behavior are verified.

Non-goals: multi-tenant SaaS billing, external email/PagerDuty delivery, global multi-region uptime measurement, or a general-purpose unrestricted URL proxy. Incident notifications are visible in the application; no messages are sent to third parties.
