# Explain recurring reliability failures with paired windows

Status: accepted for EdgeLab 3.2.

## Problem

Consecutive-failure incidents detect sustained outages. A pattern of alternating failures and good checks can repeatedly reset the streak while consuming the sampled good-check budget. The selected 24-hour or 7-day aggregate does not establish whether that pattern is ongoing now.

## Decision

Add fixed versioned paired-window signals evaluated by the scheduled coordinator. The rules use long/short windows of 60/5 minutes at 14.4× burn, 360/30 minutes at 6×, and 4,320/360 minutes at 1×. Burn is the observed bad ratio divided by the allowed bad ratio. Both windows must reach their rule's threshold. This follows the Google SRE Workbook's 30-day-budget examples; it is an in-app diagnostic applied to synthetic minute samples. [Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)

Require a complete current-policy window, at least 95% coverage, at least 20 non-maintenance observations in the long window, and five in the short window. These sampling gates are project choices. Missing, legacy, conflicting, wrong-revision, and incorrectly timed observations remain unknown. Maintenance is excluded from the coverage denominator and burn ratio. A paused policy or completely verified maintenance window is explicit maintenance.

Compute signals from finished UTC minutes after scheduled probes complete. Dashboard reads return persisted evidence, age it, and never trigger reevaluation or refresh its timestamp. Persist the last firing evidence across insufficient history, maintenance, and policy changes. A stale evaluation or changed revision cannot become a confident current clear result. The UI distinguishes a qualified rule that no longer fires from unavailable evidence and from a warning under an earlier policy.

These signals do not create or recover consecutive-failure incidents, page operators, or send notifications. Highest-priority firing takes precedence, while each rule exposes its own state, counts, coverage, and reason. The warning evaluation is independent of the dashboard's selected reporting window.

## Consequences

One bad sample among 60 at a 99.9% target produces about 16.7× long-window burn. This coarse result can fire the rapid signal when the recent window also qualifies. It is not an estimate of customer request availability or evidence of global uptime. Thresholds should be interpreted with their sample counts, rather than as a paging policy.

The long rules need six hours and three days of current-policy history. Policy changes deliberately restart maturity instead of combining checks evaluated under different definitions. A prior warning remains inspectable when newer evidence is insufficient. Actual SQLite tests and synthetic timelines cover intermittent failures, threshold boundaries, recovery, gaps, maintenance, policy changes, duplicate ambiguity, eviction, and read-only aging.
