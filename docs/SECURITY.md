# Security boundaries

EdgeLab separates a public read model, a single-owner control plane, an approved-target probe plane, and a capability-scoped experimental lab.

The public Fieldnotes explorer is a separate static presentation of pinned controlled fixtures. Its generated client data excludes private notes, credentials, target URLs, raw prompts and provider envelopes. It never invokes incident or inference APIs. Browser hash verification identifies content changes only; these unsigned canned examples do not establish source authenticity or a model result.

## Assets and trust

The operator token grants policy and incident-management access. It is a Cloudflare Worker secret, generated with 256 bits of randomness, sent to Wrangler over stdin, and retained locally in an ignored mode-600 file. The UI retains it only in memory. Authorization compares SHA-256 digests without data-dependent early exit. This is a single-owner token model, not user identity, organization RBAC, MFA, or an attribution system: audit entries mean the deployment credential was used.

Public snapshots, incident evidence, and operations exports omit target URLs, investigation notes, acknowledgement notes, and private audit details. Policy-version evidence exposes policy, service name, transport, assertion, revision, and provenance, without the enrolled URL. React renders notes as text, never HTML. Operator requests carry a bearer token, require the correct browser Origin when present, and accept bounded JSON. Tokens are never query parameters. A known incident ID cannot grant write access. Repeated acknowledgements are idempotent; concurrent policy edits use revision checks.

`GET /api/ops/incidents/<id>?before=<slot>` is public and returns at most 50 descending check records plus their policy context per page, only for active deployment targets. A valid bearer token adds private notes. An invalid supplied bearer token returns 401 instead of silently falling back to public output. `POST /api/ops/incident-note` requires authorization and a UUID v4 request ID. The same ID and payload return the existing note; conflicting reuse returns 409. Request IDs provide retry deduplication, not authorization. Notes are nonblank, bounded to 500 characters, and capped at 100 retained appended notes per incident; resolved incidents still permit follow-up investigation.

## Network boundary

Incident briefs are operator-only. The server freezes a whitelist of public-safe evidence and sends no private notes, target URLs, credentials, arbitrary user prompts or response bodies to Workers AI. Service names remain inspectable in the snapshot but are excluded from the model prompt. The model and prompt version are selected by code. Generated hypotheses require strict schema, bounded plain text, relevant included evidence IDs and allowlisted suggestion labels; no tool execution or automatic policy/incident mutation is available. Valid citations do not establish root cause.

Private brief records retain their frozen snapshot/hash and sanitized provider failures. Invalid raw output and provider exception text are not stored or exposed. Request IDs deduplicate dispatch but do not authorize retrieval. Inference reservations and deadline tokens are persisted before network work; late results cannot replace terminal requests. Four attempts/day, one start/minute and one pending call limit this application, not the account's shared quota or provider billing. Native inference is gated by `AI_BRIEFS_ENABLED`, which defaults to false; normal incident evidence remains available when disabled. Requests/results expire 30 days after creation, and reads enforce retention even when cron cleanup has stalled.

Separate atomic record admission caps new brief rows at 16 per UTC day, 256 physically retained rows and 128 KiB per new serialized row with completion headroom. Deterministic records consume admission; no failed capacity check reserves an AI attempt. Deletion and lease expiry never refund counters. Legacy oversized records remain readable, and a one-time counterless-store migration closes its UTC day rather than invent a deleted-creation count. These private application controls do not replace perimeter limits or reserve the account's shared database allowance.

Targets come only from trusted deployment configuration, at most five per deployment. Only HTTPS without credentials, query, fragment, or custom port is accepted. Public transport requires a DNS hostname; private transport uses the fixed ORIGIN binding. The monitor follows no redirects, validates its expected JSON contract, consumes at most 16 KB, and applies an overall timeout. It does not retain response bodies or exception text in public observations.

This is not a DNS-rebinding defense for arbitrary untrusted user URLs. The deployer must control and trust configured DNS and endpoints. Do not offer untrusted self-service enrollment without a separate egress and ownership-verification design. Requests to the private monitor DO's tick route are not exposed by the gateway.

Timing is an evidence boundary. Only the current scheduled minute may start a probe; a late invocation produces a diagnostic event without backfilling observations. Actual start timestamps distinguish verified observations from legacy timing that cannot be reconstructed. Policy migration recovers only the current stored policy with `recovered-current` provenance, rather than inventing historical versions.

## Operational risks

Public reads and lab sessions can consume quota. The adjustable laboratory bucket protects the experimental origin path, not the application's perimeter. A UUID lab capability is not user authentication. For private review deployments use Cloudflare Access; for broad anonymous use add issuance and perimeter rate controls. No external notification channel is configured, so a dashboard incident is not guaranteed to wake an operator.

A leaked token must be rotated and private audit data reviewed. Notes should not contain credentials or personal information. Dependencies, logging, the Cloudflare account, deployer machine, and same-origin script integrity remain trusted. No compliance certification, independent penetration test, or disaster-recovery guarantee is claimed.

`GET /api/ready` reports persisted scheduler and active-service freshness, with an inclusive three-minute limit; only healthy readiness returns 200. Paused services are ignored, and public reads cannot renew scheduler evidence. This read-only endpoint provides an independent observer with a useful signal but shares Cloudflare's failure domain. Readiness can be healthy while monitored services fail because it evaluates monitoring operation. Scheduler diagnostics expose only the latest 20 public events and have 30-day retention.

Appended private notes are retained for 30 days and removed when their resolved incident is pruned. Open incidents persist, while their older appended notes still expire. The original acknowledgement note follows the incident record's retention. Authenticated incident output therefore requires private handling even after upstream recovery; public schemaVersion 4 exports do not include it.

## Tests

The actual runtime suite checks unauthenticated writes and audit reads, cross-origin requests, malformed/oversized data, non-public schedule routes, and private-note exclusion. Incident evidence checks cover authenticated detail, cursor bounds, idempotent note writes, conflicting request IDs, resolved follow-up, and retention. Unit tests exercise target validation, redirect rejection, bounded body consumption, public error categorization, current-minute acceptance, and freshness boundaries. These tests verify specific controls; they do not imply comprehensive security certification.
