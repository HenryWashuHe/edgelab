# Security boundaries

EdgeLab separates a public read model, a single-owner control plane, an approved-target probe plane, and a capability-scoped experimental lab.

## Assets and trust

The operator token grants policy and incident-management access. It is a Cloudflare Worker secret, generated with 256 bits of randomness, sent to Wrangler over stdin, and retained locally in an ignored mode-600 file. The UI retains it only in memory. Authorization compares SHA-256 digests without data-dependent early exit. This is a single-owner token model, not user identity, organization RBAC, MFA, or an attribution system: audit entries mean the deployment credential was used.

Public snapshots omit target URLs, notes, and audit details. React renders notes as text, never HTML. Operator requests carry a bearer token, require the correct browser Origin when present, and accept bounded JSON. Tokens are never query parameters. A known incident ID cannot grant write access. Repeated acknowledgements are idempotent; concurrent policy edits use revision checks.

## Network boundary

Targets come only from trusted deployment configuration, at most five per deployment. Only HTTPS without credentials, query, fragment, or custom port is accepted. Public transport requires a DNS hostname; private transport uses the fixed ORIGIN binding. The monitor follows no redirects, validates its expected JSON contract, consumes at most 16 KB, and applies an overall timeout. It does not retain response bodies or exception text in public observations.

This is not a DNS-rebinding defense for arbitrary untrusted user URLs. The deployer must control and trust configured DNS and endpoints. Do not offer untrusted self-service enrollment without a separate egress and ownership-verification design. Requests to the private monitor DO's tick route are not exposed by the gateway.

## Operational risks

Public reads and lab sessions can consume quota. The adjustable laboratory bucket protects the experimental origin path, not the application's perimeter. A UUID lab capability is not user authentication. For private review deployments use Cloudflare Access; for broad anonymous use add issuance and perimeter rate controls. No external notification channel is configured, so a dashboard incident is not guaranteed to wake an operator.

A leaked token must be rotated and private audit data reviewed. Notes should not contain credentials or personal information. Dependencies, logging, the Cloudflare account, deployer machine, and same-origin script integrity remain trusted. No compliance certification, independent penetration test, or disaster-recovery guarantee is claimed.

## Tests

The actual runtime suite checks unauthenticated writes and audit reads, cross-origin requests, malformed/oversized data, non-public schedule routes, and private-note exclusion. Unit tests exercise target validation, redirect rejection, bounded body consumption, and public error categorization. These tests verify specific controls; they do not imply comprehensive security certification.
