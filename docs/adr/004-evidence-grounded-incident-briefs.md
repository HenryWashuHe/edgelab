# Preserve evidence when generating incident explanations

Status: accepted in EdgeLab 3.3. Native Workers AI execution remains disabled and unverified; isolated fake-provider verification is recorded separately.

## Problem

An incident timeline records symptoms, policy versions, and observation gaps. Interpreting that evidence still takes operator effort. A model can suggest useful next checks, but plausible prose can overstate cause, cite unavailable history, or silently change meaning when live policy rows are replaced.

## Decision

Add an operator-only incident brief generated explicitly from a retained incident. The server accepts an incident UUID and a UUID v4 request ID; it chooses the model and prompt. It does not accept arbitrary prompts, target URLs, model names, or tool instructions. Generation is available only when the AI binding and deployment capability are enabled.

Before inference, capture the latest evidence page: at most 50 descending checks, the immutable policy versions those checks reference, public lifecycle events, and deterministic facts and limits. Copy only public fields. Private notes, acknowledgement text, target URLs, credentials, and response bodies are excluded. Freeze the selected snapshot and calculate SHA-256 over canonical JSON, including capture time, facts, and limitations. Retain the snapshot with its hash so its citations remain inspectable after live checks or versions are pruned.

Verify check timing against the recorded UTC slot and actual start and completion timestamps. Legacy starts, invalid timing, unavailable policy versions, retention loss, and pagination remain explicit unknowns. Coverage applies only to finished minutes between the oldest and newest selected checks. Verified maintenance is excluded from that denominator; the current minute is excluded. Empty or maintenance-only coverage is unavailable. These counts describe a selected slice of one coordinator's synthetic observations, rather than the whole incident or customer request uptime.

Use `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with non-streaming JSON schema output, temperature zero, and at most 512 output tokens. This active model supports JSON mode; the earlier base Llama 3.1 8B model was deprecated in May 2026. JSON mode remains a provider convenience: local validation is mandatory because schema-conforming output is not guaranteed. [Model](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/), [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/), [Model deprecations](https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/)

Bound the combined message contents to 2 KiB, serialized model input to 4 KiB, and native output envelope to 8 KiB. Send representative symptoms and policy context rather than every frozen entry, expose the omitted-reference count, and permit citations only to IDs actually included. Service names never enter the prompt. Full selected policy metadata remains in the stored snapshot and escaped citation inspector.

Accept zero to two hypotheses with fixed symptom categories, short plain text explanations, one to three unique evidence IDs, and one or two fixed next-check enums. Each hypothesis must cite a source relevant to its category. Supplemental policy and lifecycle citations cannot establish a symptom on their own. Reject unexpected fields, HTML, URLs, duplicate categories, arbitrary actions, malformed provider envelopes, and tool calls. Never repair invalid model output or execute suggested actions. All model prose remains explicitly unverified; valid citations establish relevance to recorded symptoms, not causality.

## Dispatch and retention

Persist the snapshot, prompt version, selected citation IDs, and dispatch token before calling the provider. Permit at most four reserved model attempts per UTC day, one start per UTC minute, and one persisted pending attempt. These are application limits. Cloudflare's free neuron allocation is shared across the account; another application can exhaust it, so provider quota failures must remain explicit. No paid plan change is required by this design. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

While its record is retained, a same-ID retry returns the existing record and never repeats inference, including after failure or interruption. After retention removes that record, the identifier no longer provides deduplication. A request ID already attached to another incident conflicts. A 20-second deadline and dispatch token fence publication: expired pending records become interrupted, and late completions cannot overwrite them. Provider cancellation is best effort. Capacity rejection avoids provider queueing; an unknown client response offers an intentional same-ID retry or status read. [Reject if busy](https://developers.cloudflare.com/workers-ai/features/reject-if-busy/)

No verified bad observation produces an insufficient-evidence record without inference or attempt consumption. Prompt preparation failures also avoid inference. Preserve completed, failed, and interrupted records for 30 days, subject to incident retention and active-service eligibility. Read paths return stored model results rather than regenerate them. A private read can finalize an expired pending lease as interrupted; it never dispatches inference. The four-attempt quota bounds model dispatches rather than total stored records; deterministic records currently have no separate admission quota.

## Consequences

The operator sees frozen deterministic facts separately from AI-generated possible explanations. Native citation inspectors expose the exact stored entries. The browser keeps pending request identity only in authenticated component memory, clears it on credential or page-lifetime changes, and never automatically posts a new generation request.

This feature makes investigation reproducible and gives an AI demonstration grounded in the monitor's actual evidence. It cannot identify a proven root cause, inspect application logs it was not given, fill missing history, resolve incidents, or send notifications. Unit tests cover immutable capture, canonical hashing, timing and slice coverage, malicious metadata, byte limits, strict schemas, and citation relevance. Isolated runtime tests use a controlled fake AI binding to exercise dispatch ownership, replay, quota, provider errors, expiration, and eviction without consuming account inference quota.
