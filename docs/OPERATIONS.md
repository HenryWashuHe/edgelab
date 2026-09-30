# Operator runbook

## Deployment prerequisites

Use Node 22.12+, a Cloudflare account with Workers and SQLite-backed Durable Objects, and Wrangler authentication. Clone the repository, run `npm ci`, then `npm run check`, `npm run test:lifecycle`, `npm run test:monitor`, `npm run test:incident`, `npm run test:upgrade`, and `npm run test:budget`.

Configure both Worker names and the gateway ORIGIN service binding together. `MONITOR_TARGETS` is a JSON string of at most five targets in `wrangler.jsonc`. Each has a unique lowercase ID, name, HTTPS URL, transport (`origin` for the fixed private binding or `https`), and assertion (`ok-json` requires `{ "ok": true }`; `catalog-json` validates the catalog contract). No credentials, query strings, fragments, or custom ports are accepted. Only enroll endpoints you own or are authorized to monitor.

The HTTPS URL is trusted deployment configuration. Do not point it at untrusted DNS or sensitive internal services. There is no runtime endpoint for adding arbitrary URLs. Redirect responses fail instead of being followed. Reusing a service ID preserves its history and active incident; use a new ID for a genuinely different service.

Deploy with `npm run deploy`, then `npm run operator:setup`. The setup command sends a random token through Wrangler stdin and keeps a private mode-600 copy in `.env.operator`. It does not print the token. The dashboard’s Operator tab needs this token. Opening the file privately is sufficient; do not send it through chat, commit it, or put it in an issue.

## Verify an actual release

1. Confirm the published commit passes GitHub CI.
2. For a v3.2 release, `GET /api/health` must report version 3.2.0. Compare the deployed revision with the release evidence; these instructions alone do not prove deployment.
3. `GET /api/ops/status` must list the expected target names. Public output must not contain the operator token, target URLs, or investigation notes.
4. Allow cron propagation ([Cloudflare documents up to 15 minutes](https://developers.cloudflare.com/workers/configuration/cron-triggers/)). Verify each service receives observations in two distinct scheduled minutes without clicking a “run” button. Check `latest.slot`, the actual probe start `latest.observedAt`, and completion `latest.at`, not just the page's snapshot timestamp. Trigger propagation is not permission to backfill: an invocation whose scheduled minute has passed is recorded as `skipped-late` and makes no observation.
5. The private catalog probe must validate actual JSON through its service binding; the gateway probe must reach the configured public HTTPS health endpoint.
6. Public policy/audit requests must return 401. `npm run operator -- audit` with the right deployment token must work.
7. Run `BASE_URL=https://YOUR-WORKER.workers.dev npm run test:integration`. These create isolated lab sessions and do not modify monitor policies.
8. `GET /api/ready` must return HTTP 200 and `monitoring.status: "healthy"`. Starting, partial, and stalled states return 503. Inspect the persisted last-started, last-completed, and last-completed-slot fields and the latest 20 scheduler events in public status. Requests to the page or readiness endpoint cannot refresh them.
9. Confirm `GET /api/ops/export` reports `schemaVersion: 4`, excludes private notes, distinguishes unverified migrated checks from verified observations, and adds each service's `budget` evidence. Its evaluation must be computed by a scheduled run; repeated public reads must not renew `computedAt`.
10. Run the bounded benchmark if performance evidence is being updated. Save raw results and their environment; do not mix local and live observations.

## Incident response

A bad check means non-200 HTTP, invalid/oversized JSON, transport error, timeout, or latency above its objective. Open an incident investigation to inspect its lifecycle, outcome, status, latency, revision, and freshness. Public status includes all open incidents for active targets plus their latest 100 resolved incidents, so recent recoveries cannot crowd out an older open incident. Three consecutive bad observations open an incident by default. A missing minute resets the detection streak, so the incident count alone never proves health.

Authenticate and acknowledge the incident with a private investigation note, or use `operator ack`. Acknowledgement records an audit event and ownership; it does not resolve the incident. Inspect Worker logs and the upstream service. Correct the upstream issue. Two consecutive good observations resolve the incident by default. Resolution time is detection/recovery observation time, not a claim of precise outage onset/end.

`GET /api/ops/incidents/<id>?before=<slot>` returns up to 50 retained checks, newest slot first, with the policy versions referenced on that page. Omit `before` for the first page and pass `nextCursor` as `before` to load older evidence. The range includes up to ten minutes before detection and the retained incident interval; `limitedByRetention` flags an incomplete historical range. Missing checks stay missing. Public evidence excludes target URLs and private notes. Supply `Authorization: Bearer ...` to include notes; an invalid supplied token returns 401.

Append an investigation or follow-up note with `POST /api/ops/incident-note` and `{ "incident": "INCIDENT_ID", "requestId": "UUID-v4", "note": "Investigating the upstream timeout" }`. Generate one UUID v4 per intended note and retain it when retrying after a lost response. The identical request is idempotent; a different note or incident using that ID returns 409. The note must be 1–500 characters with non-whitespace content. Each incident is capped at 100 retained appended notes. Recovery does not prevent follow-up notes, while acknowledgement still applies only to open incidents.

If monitoring itself stops, service status becomes unknown and missing coverage rises. `/api/ready` permits at most three minutes since the last completed scheduled run and the actual start of every active service's latest current-revision check. It returns `starting` before any run completes, `stalled` for stale or impossible scheduler evidence, and `partial` when the scheduler is fresh but an active service lacks fresh evidence. Paused services are ignored; a fresh scheduler with all services paused is healthy and states that no probes are expected. This endpoint measures monitoring freshness, not upstream success.

Investigate cron configuration, deployment errors, quotas, `monitor.tick` logs, and the status snapshot's latest 20 persisted scheduler events. A skipped late event cannot fill a historical gap. Check `/api/ready` from outside Cloudflare for correlated provider outages. The system does not convert missing probes into good samples or close incidents automatically.

## Investigating a budget signal

Open a service's Error budget signals panel and check the evaluation time, policy revision, and `budget.evaluationStatus` before interpreting its result. Only `current` evidence can establish a present result: the persisted computation must be at most 180 seconds old and belong to the current revision. `stale`, `policy-changed`, and `not-evaluated` do not mean clear. Refreshing the dashboard cannot renew evaluation. Inspect readiness and scheduler diagnostics when fresh evidence stops arriving.

The three fixed rules use a 30-day check-budget basis: rapid 60/5-minute windows at 14.4× burn, sustained 360/30 at 6×, and gradual 4,320/360 at 1×. Both windows must meet the rule's threshold. The selected 24-hour/7-day report does not change these windows. The [SRE source](https://sre.google/workbook/alerting-on-slos/) supplies the paired thresholds; EdgeLab's full current-policy maturity, 95% coverage, 20 long-window samples, and five short-window samples are explicit project gates. Each window's counts, unknown minutes, maintenance, maturity, and reason are inspectable.

Inspect rules individually. Rapid can qualify after an hour even while the longer rules need more history; firing takes priority over incomplete rules, ordered rapid, sustained, then gradual. An overall insufficient-evidence result means no qualified rule is firing and at least one rule lacks evidence, not that all service outcomes are healthy. A qualified rapid clear result can still be useful when gradual is immature. At a 99.9% target, one failure in 60 checks gives about 16.7× burn, so interpret a warning with its small sampled population.

Retained `lastFiring` evidence remains available after missing observations, a policy change, maintenance, a stale scheduler, or a later clear evaluation. The panel distinguishes “Current firing evidence,” “Previous warning is below its trigger,” “Warning retained from a previous policy,” and “Previous warning has no confirmed clearance.” Only a current qualified clear result under the same policy and rule supports the below-trigger label. A historical retained warning is not a current alarm, and stale/unknown evidence cannot establish recovery.

Use the signal to investigate intermittent failure that may never reach the consecutive-failure incident threshold. Its first-fired and last-confirmed timestamps describe recorded evaluations, not exact outage onset/end or uninterrupted warning duration. Budget signals neither create nor recover incidents. Pausing monitoring does not recover either an incident or a prior warning. The application sends no external notifications and does not claim customer-request uptime.

## Policy and maintenance

Edit the latency objective, timeout, good-check target, failure threshold, and recovery threshold in Operator or service detail. Writes include the last observed revision and return 409 if another operator changed it. Refresh and reopen the form before retrying. Each saved policy invalidates in-flight old-revision results and resets streaks. Existing incidents remain open.

Pause records maintenance observations each minute without touching the upstream. Those observations are excluded from the SLO and coverage denominator. Unobserved minutes during a scheduler outage remain missing, including during a pause. Resume explicitly; there is no automatic maintenance end. An active incident during maintenance still needs subsequent successful probes to recover.

Budget evaluation shows explicit maintenance when the current policy is paused or both rule windows contain only verified maintenance. Mixed maintenance still must meet the minimum non-maintenance sample gates. Any policy revision restarts full-window maturity; newly resumed or edited services can require up to three days before the gradual rule qualifies. Previously recorded firing evidence remains available under its original revision.

The good-check objective evaluates both validity and latency. New policy and target revisions store their policy context with `recorded` provenance; changing a threshold does not rescore historical outcomes. On migration, only the current v3 policy can be recovered, marked `recovered-current`. Earlier revisions lacking captured policy context cannot be reconstructed. Legacy checks without an actual observation start time remain visible as unverified evidence and receive no verified SLO credit. The current good-check target determines the displayed error budget. Export a report before large policy changes for interpretation.

## Retention, export, and backup limits

Scheduled runs prune checks, completed jobs, resolved incidents, audit events, scheduler diagnostics, and appended private notes older than 30 days. Appended notes expire even while their incident remains open. Open incidents and current service policies are retained; the original acknowledgement note follows the incident record's retention. Historical policy versions are kept while referenced by retained checks or the current service revision. Removed deployment targets are no longer probed or publicly displayed; their retained data is not immediately deleted. Pruning depends on completed scheduled runs.

The dashboard exports the selected 24-hour or 7-day summary, hourly aggregates, latest 60 samples per service, all active-target open incidents, their latest 100 resolved incidents, readiness, latest 20 scheduler diagnostics, and each service's persisted budget evaluation and last firing evidence. Operations exports retain `schemaVersion: 4`; v3.2's `service.budget` is additive. Configured services keep one latest evaluation and one last firing record through prolonged gaps; removed services' records are pruned after 30 days. This is not a full warning-event history. Incident detail provides separate cursor-based evidence pages with their policy context. These are bounded reports, not full database backups. The authenticated audit endpoint returns the latest 100 audit entries and incident records; authenticated detail includes retained private notes. Keep any authenticated output private. No application-level disaster recovery backup is claimed; before destructive storage operations use Cloudflare's supported storage recovery/export tools and verify recovery separately.

## Stop, rotate, and roll back

- Pause each service to stop upstream probes while keeping scheduled maintenance records.
- To stop all scheduled invocations, set `triggers.crons` to `[]` and deploy. Propagation is not immediate. Check Worker logs after the propagation window.
- Rotate an exposed credential with `npm run operator:setup -- --rotate`. Old browser sessions fail their next authenticated request. Update any private CI secret copy. Never paste the token into a bug report.
- v3 adds the `MonitorStore` class with an additive `v2` migration. Do not delete classes or migrations to roll back a UI issue. Prefer a forward fix or Cloudflare’s supported deployment rollback after checking migration compatibility. The old lab remains a separate class and namespace.
- v3.1 adds observation-start timestamps, policy-version records, scheduler diagnostics, and appended incident notes to the existing SQLite coordinator. Existing checks migrate with unknown observation timing, not invented timestamps. Preserve these additive tables and columns when evaluating rollback compatibility.
- v3.2 adds the `budget_signals` table to the existing coordinator. It stores versioned evaluation and last firing evidence; schemaVersion 4 public exports add `service.budget`. Preserve this table during rollback and expect old clients to ignore the additive field.
- To restore a known application revision, preserve current bindings, secrets, migration history, and the monitoring schema. A code checkout alone is not a database rollback. Record a before/after public status export.

## Local development and fault injection

`npm run operator:setup -- --local` provisions `.dev.vars`. Restart Wrangler to load it. Local cron must be invoked explicitly through `/cdn-cgi/local/scheduled`; do not expect the passage of time to schedule checks. A local HTTPS target can still point at the live gateway; use private test bindings for isolated tests.

`npm run test:monitor` creates an ephemeral workerd runtime. It injects HTTP failure, concurrency, policy races, a crashed persisted lease, object eviction, old retention rows, and controlled timing boundaries. Incident evidence tests verify pagination, policy context, private-note authorization, and idempotent retries. Storage inspection is enabled only in that test harness. There is no public fault-injection endpoint on the monitor.

`npm run test:budget` exercises actual SQLite persistence, eviction, retained warnings, gaps, policy changes, stale reads, and pruning with controlled historical fixtures. Those fixture timelines are test evidence, not operating history for the deployed service. Unit signal tests evaluate synthetic patterns and threshold boundaries. Production observations still accumulate only through the real current-minute scheduler.

If workerd reports SQLite busy, another dev process likely uses the same `.wrangler` directory. Stop that process or start the new preview with a distinct `--persist-to` directory. Never delete a live application's storage to fix a preview lock.

## Cost and operating boundaries

Two monitored services produce at most 2,880 scheduled probes/day, plus cron invocations, storage, reads, and lab traffic. This is an invocation estimate, not a bill. Five targets cap deployment fan-out. Each probe is bounded at 10 seconds maximum; default is 3 seconds. Public status queries and lab sessions still consume account quota. Restrict access using Cloudflare Access when exposing only to reviewers; add an independent perimeter policy before offering this as an anonymous multi-tenant service.

References: [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
