# Developer workflow pilot

Prepared October 1, 2026. **No external developer sessions or voluntary reuse have been demonstrated.** This is a prepared session protocol and a copyable worksheet, not a pilot result. The [product assessment](PRODUCT_VALUE.md) defines the hypothesis: help a Workers developer explain what persisted after an uncertain operation and share bounded evidence without granting account access.

## Fit before a demo

Ask about one recent real problem before showing EdgeLab. Record the developer's unanswered question and what their existing recovery, getters, logs and traces already revealed. Include available [Workers traces and exports](https://developers.cloudflare.com/workers/observability/traces/), [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) for production failure grouping, and [Local Explorer](https://developers.cloudflare.com/workers/local-development/local-explorer/) for local SQL inspection and invocation traces in the baseline. Include existing browser replay or custom-event capture, such as [rrweb](https://rrweb.com/docs/recipes/custom-event), when relevant to the actual client failure. Record whether the developer already captures application positions/statuses and how custom payloads are sanitized; UI masking alone does not establish their privacy. Missing permissions or disabled instrumentation are constraints to record; they do not by themselves establish a missing product capability.

The October 2 baseline follow-up includes existing request-ID receipts or result lookups, and durable step/status evidence for applications already using Workflows. Record what those establish about the specific command before treating a sampled current value as an answer. For a problem in a recorded Browser Run automation session, compare its [rrweb and network/HAR exports](https://developers.cloudflare.com/browser-run/features/session-recording/) too, including actual recipient and redaction effort. This is a comparison requirement, not an executed integration or permission to launch browser automation.

Current capture has a strict boundary. The [counter recipe](../examples/counter-evidence/README.md) runs four ephemeral local runtimes around one pinned, independently authored counter example. Its two adapter profiles accept that example's numeric value, not arbitrary Durable Object state. It has no existing-deployment target argument. The deployed EdgeLab recorder accepts EdgeLab's own Lab schema. The [standalone inspector](evidence/counter-inspector/README.md) reads either known counter profile; it does not capture or integrate a new application.

If the real question cannot be represented by a supported profile, record **unsupported**. A different application needs a source review and a tailored, tested adapter before its evidence can be evaluated. Do not substitute a counter exercise and count that as an external developer outcome. Keep unsupported cases in the pilot denominator.

## Run one session

1. **Freeze the baseline before EdgeLab.** Write the exact question, established answer, remaining uncertainty and sanitized evidence references. Record which tools were actually used and which were unavailable. Preserve this entry when later evidence changes the conclusion.
2. **Check technical fit.** Name the application revision, storage model, concurrency conditions and supported adapter/profile. Define the state-read or successful client-application boundary being observed. Observation time, recorder receipt time and a native commit time are different fields; unavailable commit metadata stays unknown.
3. **Trial the minimum integration.** For a supported case, record the exact code/configuration changes and source revision. Measure integration, capture, export and recipient inspection separately. Record actual starts/ends, pauses, assistance and estimates. Count extra reads/RPCs/deployments where observable; mark physical SQL/CPU/billing unknown without appropriate measurements. Today's supplied capture recipe uses local fixtures and no account; an external integration is a separate, unimplemented trial.
4. **Compare answers.** Ask the developer the same unresolved question using the captured evidence. Record their answer verbatim only with permission, otherwise use a confirmed paraphrase. Check it against an independent authoritative observation or controlled reproduction. An unsigned content hash establishes consistency of validated data, not producer authenticity, command causality or exactly-once execution.
5. **Record the result and burden.** Choose one classification below. Note unanswered questions and incorrect inferences, even if the artifact looks convincing. Let the developer decide whether the added work is worthwhile.
6. **Check voluntary reuse separately.** Agree on a follow-up opportunity, then record whether the developer independently chooses the workflow for another real problem, with any prompting or assistance disclosed. Interest, a second guided demonstration or a repeated read of the same artifact is not independent reuse. This document does not authorize outreach or schedule a follow-up.

The second pass benefits from knowledge of the first pass. Its elapsed time cannot establish that EdgeLab caused faster diagnosis. A later timing experiment needs comparable independent tasks and an agreed evaluation design. This pilot records effort and answers rather than claiming a speedup.

## Copy one worksheet per developer and problem

Use an anonymous session identifier and approved sanitized references. Keep credentials and private logs out of repository evidence. Unfilled fields remain unknown; a prepared worksheet is not a completed session.

| Field                                                   | Record                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Session / developer ID / date                           | Unfilled                                                                  |
| Study type                                              | Real developer session; public-source assessment; or controlled rehearsal |
| Recent problem / application revision / storage model   | Unfilled                                                                  |
| Exact question, recorded before demo                    | Unfilled                                                                  |
| Concurrency, timeout/reset/lost-response conditions     | Unfilled                                                                  |
| Existing recovery and baseline tools actually used      | Unfilled                                                                  |
| Baseline facts / unknowns / sanitized references        | Unfilled                                                                  |
| Fit: supported profile or unsupported reason            | Unfilled                                                                  |
| Proposed adapter boundary and required changes          | Unfilled                                                                  |
| Trial status                                            | Completed, incomplete or withdrawn; initially unfilled                    |
| Integration / capture / export / recipient effort       | Unfilled; retain pauses, assistance and uncertainty                       |
| Extra operations / deployments / unmeasured costs       | Unfilled                                                                  |
| Artifact revision/hash / declared clocks / capture gaps | Unfilled; content consistency is not authenticity                         |
| Answer after trial / independent correctness check      | Unfilled                                                                  |
| Added answer beyond frozen baseline                     | Unfilled; state none if the answer is unchanged                           |
| Classification / developer-confirmed benefit and burden | Unfilled                                                                  |
| Remaining unknowns or misleading inference              | Unfilled                                                                  |
| Agreed follow-up opportunity / prompting                | Unfilled                                                                  |
| Actual reuse on another real problem / evidence         | Unfilled                                                                  |

| Classification            | Required evidence                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additional correct answer | A specific baseline uncertainty becomes an independently confirmed answer.                                                                                                       |
| Sharing convenience only  | The answer was already available; the useful change concerns its handoff or inspection. Record the recipient's result and effort against the existing export/redaction workflow. |
| No answer                 | Supported trial completes without resolving the stated question.                                                                                                                 |
| Unsupported               | Current capture cannot represent the needed producer/consumer boundary.                                                                                                          |
| Incorrect or misleading   | The workflow produces an incorrect answer or encourages an unsupported commitment, causality or completeness claim.                                                              |
| Not evaluated             | The trial is incomplete or withdrawn; its result remains unknown. Record the reason when available.                                                                              |

## Worked technical assessment: the counter

This assessment uses [controlled runtime evidence](evidence/counter-portability/rpc/README.md), not a recruited developer or an adoption result. The original counter's existing `getCounterValue()` RPC supplies the wrapper's sample. Its ordinary read route already exposes the numeric state.

| Question                                                    | Existing baseline                                                                                                             | EdgeLab's added result                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What value is observed after the unavailable response?      | Existing read path exposes zero after the controlled before-delegation loss and one after the controlled after-response loss. | The same value in a bounded export; no additional numeric answer.                                                                                                                        |
| Does one survive forced eviction?                           | The next read exposes one after actual local eviction.                                                                        | A retained sample of that observation; no additional persistence answer.                                                                                                                 |
| Which concurrent command caused this value?                 | A value alone cannot establish this.                                                                                          | These samples have no command attribution or native revision/commit time; still unanswered under arbitrary concurrency.                                                                  |
| Can a recipient inspect the samples without account access? | Compare the developer's actual sanitized export/redaction workflow; it has not been measured here.                            | One copied inspector plus artifact works with Node 22.12+, without the repository/npm/account. Distribution portability is demonstrated; recipient benefit and effort remain unmeasured. |

The loss branch is known from the isolated transport controls, not inferred from a value alone. Profile 2 calls the existing getter and timestamps its result at the gateway; intervening concurrent writes can occur before that timestamp. This assessment qualifies as a **controlled rehearsal with possible sharing convenience**, not an additional-answer pilot success.

From the repository root with Node 22.12+, inspect an existing frozen profile 2 artifact:

```sh
node docs/evidence/counter-inspector/inspect-counter.mjs docs/evidence/counter-portability/rpc/rpc-after-loss.json
```

Use the output to practice the worksheet's clock, attribution and baseline distinctions. Running it is an offline rehearsal, not a new capture or external-user session. The [counter instructions](../examples/counter-evidence/README.md) separately describe fresh local capture and building/copying the inspector for a recipient.

## Public reports to triage

Checked October 1, 2026. These reports remain public-source assessments, not participants, executed integrations or EdgeLab reproductions.

The [paired subscription checkpoint](evidence/subscription-pair/README.md) separately executes extracted accepted-row/replay paths on native local storage and the actual OT consumer with controlled delegates. It records two known boundaries while preserving existing recovery; it adds no answer beyond the fixture's ordinary reads, fatal/readiness signals and replay. This is a controlled rehearsal, not a completed integration with issue #305's application or an external pilot success. The real application's RPC/UI stall therefore remains unsupported by today's capture profiles.

| Report                                                                                                            | Existing answer or gap                                                                                                                                                                                                                      | Pilot fit today                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [workers-sdk #15614](https://github.com/cloudflare/workers-sdk/issues/15614) requests deployed KV API inspection. | The reporter describes the dashboard limitation and debug-endpoint workaround. The counter getter does not inspect arbitrary KV keys.                                                                                                       | Unsupported. An unrelated numeric counter export cannot validate solving this request.              |
| [Cloudflare OS #305](https://github.com/cloudflare/cloudflare-os/issues/305) reports stale subscription delivery. | Refresh already reveals persisted activity. The [source assessment](PRODUCT_VALUE.md#independent-application-assessment-stale-subscriptions) finds existing replay/recovery and distinguishes callbacks from successful client application. | Unsupported. A server-value export cannot establish the real client's applied or rendered position. |

## Decide after the pilot

Use three to five willing Workers developers recruited by the user. The pilot denominator contains recruited developers with real problems; public reports and controlled rehearsals stay separate. Retain incomplete/withdrawn trials and unobserved follow-ups as unresolved outcomes. They do not qualify for the gate, but an unavailable follow-up opportunity is not evidence that someone declined reuse. Report every classification, setup burden and missing follow-up. Count each developer once for the proposed diagnostic gate: at least two gain an independently confirmed answer beyond their frozen baseline and subsequently choose reuse on another real problem. This would justify another focused iteration, not prove market demand, uniqueness or causal speed improvement.

If the observed benefit is sharing convenience, evaluate that narrower handoff workflow separately; do not count it as diagnostic success. If baseline tools already answer the questions, integration costs outweigh the benefit or unsupported/incorrect cases dominate, retain EdgeLab as a reliability reference rather than expanding generic monitoring or a general SDK. Without recruited developers, prepare and rehearse the protocol but leave external usefulness and adoption unverified.
