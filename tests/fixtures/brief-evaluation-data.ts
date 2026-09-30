import type { IncidentCheck, IncidentDetail } from '../../worker/incident-evidence';
import type { BriefEvidence, GeneratedBrief } from '../../worker/incident-brief-domain';
import { MINUTE, RETENTION, type ProbeResult } from '../../worker/monitor-domain';

/** Hand-authored controlled scenarios, never observations from a live service. */
export const BRIEF_EVALUATION_SUITE_VERSION = 1 as const;
export const CONTROLLED_CAPTURE_AT = Date.UTC(2026, 8, 1, 12, 0, 12);
export const CONTROLLED_PRIVATE_SENTINEL = 'CONTROLLED_PRIVATE_NOTE_MUST_NOT_LEAK';
const currentSlot = Math.floor(CONTROLLED_CAPTURE_AT / MINUTE);

type ExpectedFacts = Pick<
  BriefEvidence['facts'],
  | 'recordedChecks'
  | 'verifiedChecks'
  | 'goodChecks'
  | 'badChecks'
  | 'maintenanceChecks'
  | 'legacyChecks'
  | 'invalidTimingChecks'
  | 'missingMinutesWithinSlice'
  | 'finishedExpectedMinutesWithinSlice'
  | 'finishedEligibleMinutesWithinSlice'
  | 'verifiedCoveragePercentWithinFinishedSlice'
>;
export type ControlledBriefCase = {
  id: string;
  label: string;
  description: string;
  detail: IncidentDetail;
  expectedFacts: ExpectedFacts;
  expectedDisposition: 'validate-canned-response' | 'skip-insufficient-evidence';
  /** Native envelope shape is deliberate; its contents are written by humans. */
  cannedEnvelope: { response: string | GeneratedBrief } | null;
};

function check(
  offset: number,
  outcome: ProbeResult['outcome'],
  patch: Partial<IncidentCheck> = {},
): IncidentCheck {
  const slot = currentSlot - offset;
  const latency = outcome === 'timeout' ? 3000 : outcome === 'slow' ? 1800 : 20;
  return {
    service: 'controlled-service',
    slot,
    observedAt: slot * MINUTE + 1000,
    at: slot * MINUTE + 1000 + latency,
    outcome,
    status:
      outcome === 'maintenance' || outcome === 'timeout'
        ? null
        : outcome === 'http-error'
          ? 503
          : 200,
    latency,
    revision: 1,
    ...patch,
  };
}

function detail(id: string, checks: IncidentCheck[], recovered: boolean): IncidentDetail {
  const opened = recovered ? (currentSlot - 3) * MINUTE + 1020 : (currentSlot - 7) * MINUTE + 2000;
  const resolved = recovered ? (currentSlot - 1) * MINUTE + 1020 : null;
  return {
    incident: {
      id,
      service: 'controlled-service',
      opened,
      resolved,
      acknowledged: null,
    },
    checks,
    versions: [
      {
        service: 'controlled-service',
        revision: 1,
        recordedAt: CONTROLLED_CAPTURE_AT - 60 * MINUTE,
        name: 'CONTROLLED FIXTURE — never a production incident',
        transport: 'origin',
        assertion: 'ok-json',
        policy: {
          paused: false,
          timeoutMs: 3000,
          latencyObjectiveMs: 1500,
          availabilityTarget: 99.9,
          failureThreshold: 3,
          recoveryThreshold: 2,
        },
        provenance: 'recorded',
      },
    ],
    nextCursor: null,
    range: {
      fromSlot: currentSlot - 20,
      toSlot: currentSlot - 1,
      retentionStart: CONTROLLED_CAPTURE_AT - RETENTION,
      limitedByRetention: false,
    },
    lifecycle: [
      { action: 'incident.opened', at: opened },
      ...(resolved === null ? [] : [{ action: 'incident.recovered' as const, at: resolved }]),
    ],
    notes: [{ id: 'controlled-private-note', at: opened, note: CONTROLLED_PRIVATE_SENTINEL }],
    acknowledgementNote: CONTROLLED_PRIVATE_SENTINEL,
  };
}

const httpOutput: GeneratedBrief = {
  hypotheses: [
    {
      kind: 'upstream-http-error',
      explanation:
        'Recorded HTTP errors merit inspecting upstream logs. Later good samples show sampled recovery; the cause remains unverified.',
      evidenceIds: ['fact:http-error'],
      nextChecks: ['inspect-service-logs', 'compare-deployments'],
    },
  ],
};
const timeoutOutput: GeneratedBrief = {
  hypotheses: [
    {
      kind: 'latency-or-timeout',
      explanation:
        'Timeout and slow samples merit comparing service latency with the recorded timeout. This does not establish a cause.',
      evidenceIds: ['fact:timeout', 'fact:slow'],
      nextChecks: ['review-latency-and-timeout'],
    },
    {
      kind: 'evidence-gap',
      explanation:
        'A missing minute and a legacy start limit interpretation. Inspect scheduler evidence without assuming the missing outcome.',
      evidenceIds: ['limit:gaps', 'limit:legacy'],
      nextChecks: ['inspect-monitor-scheduler'],
    },
  ],
};

export const BRIEF_EVALUATION_CASES: ControlledBriefCase[] = [
  {
    id: 'http-recovery',
    label: 'CONTROLLED: HTTP errors followed by sampled recovery',
    description:
      'Eight consecutive finished minutes: three good, three HTTP 503, then two good. No application logs or deployment cause are supplied.',
    detail: detail(
      '66db6a01-ea65-48c8-93ed-87997dbe2a01',
      [
        check(1, 'good'),
        check(2, 'good'),
        check(3, 'http-error'),
        check(4, 'http-error'),
        check(5, 'http-error'),
        check(6, 'good'),
        check(7, 'good'),
        check(8, 'good'),
      ],
      true,
    ),
    expectedFacts: {
      recordedChecks: 8,
      verifiedChecks: 8,
      goodChecks: 5,
      badChecks: 3,
      maintenanceChecks: 0,
      legacyChecks: 0,
      invalidTimingChecks: 0,
      missingMinutesWithinSlice: 0,
      finishedExpectedMinutesWithinSlice: 8,
      finishedEligibleMinutesWithinSlice: 8,
      verifiedCoveragePercentWithinFinishedSlice: 100,
    },
    expectedDisposition: 'validate-canned-response',
    cannedEnvelope: { response: JSON.stringify(httpOutput) },
  },
  {
    id: 'timeout-gaps',
    label: 'CONTROLLED: timeouts, slow response, maintenance and unknown minutes',
    description:
      'Seven checks across eight finished minutes: two timeouts, one slow, two good, one maintenance, one legacy HTTP error and one missing minute.',
    detail: detail(
      '66db6a01-ea65-48c8-93ed-87997dbe2a02',
      [
        check(1, 'timeout'),
        check(2, 'slow'),
        check(4, 'good'),
        check(5, 'http-error', { observedAt: null }),
        check(6, 'maintenance'),
        check(7, 'timeout'),
        check(8, 'good'),
      ],
      false,
    ),
    expectedFacts: {
      recordedChecks: 7,
      verifiedChecks: 6,
      goodChecks: 2,
      badChecks: 3,
      maintenanceChecks: 1,
      legacyChecks: 1,
      invalidTimingChecks: 0,
      missingMinutesWithinSlice: 1,
      finishedExpectedMinutesWithinSlice: 8,
      finishedEligibleMinutesWithinSlice: 7,
      verifiedCoveragePercentWithinFinishedSlice: (5 / 7) * 100,
    },
    expectedDisposition: 'validate-canned-response',
    cannedEnvelope: { response: timeoutOutput },
  },
  {
    id: 'insufficient-history',
    label: 'CONTROLLED: no verified bad observation',
    description:
      'One verified good and one maintenance check plus a legacy HTTP error and an invalid-start timeout. The bad-looking records cannot qualify inference.',
    detail: detail(
      '66db6a01-ea65-48c8-93ed-87997dbe2a03',
      [
        check(1, 'good'),
        check(2, 'maintenance'),
        check(3, 'http-error', { observedAt: null }),
        check(4, 'timeout', { observedAt: (currentSlot - 5) * MINUTE + 1000 }),
      ],
      false,
    ),
    expectedFacts: {
      recordedChecks: 4,
      verifiedChecks: 2,
      goodChecks: 1,
      badChecks: 0,
      maintenanceChecks: 1,
      legacyChecks: 1,
      invalidTimingChecks: 1,
      missingMinutesWithinSlice: 0,
      finishedExpectedMinutesWithinSlice: 4,
      finishedEligibleMinutesWithinSlice: 3,
      verifiedCoveragePercentWithinFinishedSlice: (1 / 3) * 100,
    },
    expectedDisposition: 'skip-insufficient-evidence',
    cannedEnvelope: null,
  },
];
