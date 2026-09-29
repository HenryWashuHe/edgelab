# EdgeLab v3: reliability operations

Goal: evolve the interactive resilience lab into a complete, self-hostable reliability application with an operating service, durable history, an operator workflow, and reproducible evidence.

Acceptance requirements (completion requires evidence for every item):

- A real scheduled Worker checks deployment-approved HTTPS services and private service bindings without an open browser. Public callers cannot choose targets or trigger probes.
- SQLite-backed monitoring persists checks, service policies, incidents, acknowledgement, and audit events across eviction and deployment. Existing laboratory data remains compatible.
- Duplicate/retried/overlapping schedules cannot double-count samples or create duplicate incidents. Leases recover interrupted work; stale completions cannot overwrite changed policies.
- Incidents open after consecutive bad observations, recover after consecutive good observations, and permit authenticated acknowledgement with a bounded operator note.
- Reporting includes observed good-check ratio, latency percentiles, error-budget consumption, missing-sample coverage, freshness, and explicit measurement limits. Gaps never become successful checks.
- Public operations UI includes service health, history, incidents, reliability trends, export, and methodology; owner controls support policy editing, maintenance pause, and acknowledgement. The laboratory remains available.
- Operator writes require a deployment secret, same-origin browser requests, bounded and validated payloads. Public data excludes secrets, private target URLs, and operator notes. Probe targets are deploy-time configuration, redirects are not followed, time and response consumption are bounded.
- Unit and actual-runtime tests cover incident state transitions, retries, concurrency, crash/lease recovery, policy races, auth, retention, and persistence. Existing lab checks continue passing.
- A repeatable benchmark reports measured concurrency behavior with environment and methodology, without invented production or global-scale claims.
- OpenAPI, operator runbook, architecture decisions, threat boundaries, CI, and deployment instructions match the shipped implementation.
- Publish verified code and the working upgrade; verify live scheduled samples and record the exact tested revision. Do not claim a long operating history immediately after deployment.

Implementation phases: monitoring domain and storage; scheduled/API integration; operations UI; failure tests and benchmark; documentation; deployment and completion audit.

Non-goals: multi-tenant SaaS billing, external email/PagerDuty delivery, global multi-region uptime measurement, or a general-purpose unrestricted URL proxy. Incident notifications are visible in the application; no messages are sent to third parties.
