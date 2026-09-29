# Operator runbook

## Deployment prerequisites

Use Node 22.12+, a Cloudflare account with Workers and SQLite-backed Durable Objects, and Wrangler authentication. Clone the repository, run `npm ci`, then `npm run check`, `npm run test:lifecycle`, and `npm run test:monitor`.

Configure both Worker names and the gateway ORIGIN service binding together. `MONITOR_TARGETS` is a JSON string of at most five targets in `wrangler.jsonc`. Each has a unique lowercase ID, name, HTTPS URL, transport (`origin` for the fixed private binding or `https`), and assertion (`ok-json` requires `{ "ok": true }`; `catalog-json` validates the catalog contract). No credentials, query strings, fragments, or custom ports are accepted. Only enroll endpoints you own or are authorized to monitor.

The HTTPS URL is trusted deployment configuration. Do not point it at untrusted DNS or sensitive internal services. There is no runtime endpoint for adding arbitrary URLs. Redirect responses fail instead of being followed. Reusing a service ID preserves its history and active incident; use a new ID for a genuinely different service.

Deploy with `npm run deploy`, then `npm run operator:setup`. The setup command sends a random token through Wrangler stdin and keeps a private mode-600 copy in `.env.operator`. It does not print the token. The dashboard’s Operator tab needs this token. Opening the file privately is sufficient; do not send it through chat, commit it, or put it in an issue.

## Verify an actual release

1. Confirm the published commit passes GitHub CI.
2. `GET /api/health` must report version 3.0.0.
3. `GET /api/ops/status` must list the expected target names. Public output must not contain the operator token, target URLs, or investigation notes.
4. Allow cron propagation (Cloudflare documents up to 15 minutes). Verify each service receives observations in two distinct scheduled minutes without clicking a “run” button. Check `latest.slot` and `latest.at`, not just the page’s snapshot timestamp.
5. The private catalog probe must validate actual JSON through its service binding; the gateway probe must reach the configured public HTTPS health endpoint.
6. Public policy/audit requests must return 401. `npm run operator -- audit` with the right deployment token must work.
7. Run `BASE_URL=https://YOUR-WORKER.workers.dev npm run test:integration`. These create isolated lab sessions and do not modify monitor policies.
8. Run the bounded benchmark if performance evidence is being updated. Save raw results and their environment; do not mix local and live observations.

## Incident response

A bad check means non-200 HTTP, invalid/oversized JSON, transport error, timeout, or latency above its objective. Inspect the last 60 samples, outcome, status, latency, revision, and freshness. Three consecutive bad observations open an incident by default. A missing minute resets the detection streak, so the incident count alone never proves health.

Authenticate and acknowledge the incident with a private investigation note, or use `operator ack`. Acknowledgement records an audit event and ownership; it does not resolve the incident. Inspect Worker logs and the upstream service. Correct the upstream issue. Two consecutive good observations resolve the incident by default. Resolution time is detection/recovery observation time, not a claim of precise outage onset/end.

If monitoring itself stops, service status becomes unknown and missing coverage rises. Investigate cron configuration, deployment errors, quotas, and `monitor.tick` logs. Check the monitor from outside Cloudflare for correlated provider outages. The system deliberately does not convert missing probes into good samples or close incidents automatically.

## Policy and maintenance

Edit the latency objective, timeout, good-check target, failure threshold, and recovery threshold in Operator or service detail. Writes include the last observed revision and return 409 if another operator changed it. Refresh and reopen the form before retrying. Each saved policy invalidates in-flight old-revision results and resets streaks. Existing incidents remain open.

Pause records maintenance observations each minute without touching the upstream. Those observations are excluded from the SLO and coverage denominator. Unobserved minutes during a scheduler outage remain missing, including during a pause. Resume explicitly; there is no automatic maintenance end. An active incident during maintenance still needs subsequent successful probes to recover.

The good-check objective evaluates both validity and latency. Historical outcomes retain the policy used at check time; changing a threshold does not rescore history. The current good-check target determines the displayed error budget. Export a report before large policy changes for interpretation.

## Retention, export, and backup limits

Scheduled runs prune checks, completed jobs, resolved incidents, and audit events older than 30 days. Open incidents and service policies are retained. Removed deployment targets are no longer probed or publicly displayed; their retained data is not immediately deleted. Resolved incidents and audit history prune when cron runs.

The dashboard exports the selected 24-hour or 7-day summary, hourly aggregates, latest 60 samples per service, and latest 100 incident records. This is a report, not a full database backup. The authenticated audit endpoint returns the latest 100 audit entries and incident notes. Keep exports private if they contain notes. No application-level disaster recovery backup is claimed; before destructive storage operations use Cloudflare's supported storage recovery/export tools and verify recovery separately.

## Stop, rotate, and roll back

- Pause each service to stop upstream probes while keeping scheduled maintenance records.
- To stop all scheduled invocations, set `triggers.crons` to `[]` and deploy. Propagation is not immediate. Check Worker logs after the propagation window.
- Rotate an exposed credential with `npm run operator:setup -- --rotate`. Old browser sessions fail their next authenticated request. Update any private CI secret copy. Never paste the token into a bug report.
- v3 adds the `MonitorStore` class with an additive `v2` migration. Do not delete classes or migrations to roll back a UI issue. Prefer a forward fix or Cloudflare’s supported deployment rollback after checking migration compatibility. The old lab remains a separate class and namespace.
- To restore a known application revision, preserve current bindings, secrets, migration history, and the monitoring schema. A code checkout alone is not a database rollback. Record a before/after public status export.

## Local development and fault injection

`npm run operator:setup -- --local` provisions `.dev.vars`. Restart Wrangler to load it. Local cron must be invoked explicitly through `/cdn-cgi/local/scheduled`; do not expect the passage of time to schedule checks. A local HTTPS target can still point at the live gateway; use private test bindings for isolated tests.

`npm run test:monitor` creates an ephemeral workerd runtime. It injects HTTP failure, concurrency, policy races, a crashed persisted lease, object eviction, and old retention rows. Storage inspection is enabled only in that test harness. There is no public fault-injection endpoint on the monitor.

If workerd reports SQLite busy, another dev process likely uses the same `.wrangler` directory. Stop that process or start the new preview with a distinct `--persist-to` directory. Never delete a live application's storage to fix a preview lock.

## Cost and operating boundaries

Two monitored services produce at most 2,880 scheduled probes/day, plus cron invocations, storage, reads, and lab traffic. This is an invocation estimate, not a bill. Five targets cap deployment fan-out. Each probe is bounded at 10 seconds maximum; default is 3 seconds. Public status queries and lab sessions still consume account quota. Restrict access using Cloudflare Access when exposing only to reviewers; add an independent perimeter policy before offering this as an anonymous multi-tenant service.

References: [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
