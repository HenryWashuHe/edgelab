import data from './brief-examples-data.json';
import type {
  BriefEvidence,
  BriefHypothesisKind,
  BriefNextCheck,
  GeneratedBrief,
} from '../worker/incident-brief-domain';

export type ReadonlyBriefData<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyBriefData<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyBriefData<T[Key]> }
    : T;

export type BriefExampleId = 'http-recovery' | 'timeout-gaps' | 'insufficient-history';
export type BriefExample = ReadonlyBriefData<{
  id: BriefExampleId;
  label: string;
  description: string;
  sourceKind: 'controlled-fixture';
  responseOrigin: 'human-authored-canned-envelope' | 'none';
  disposition: 'validated-canned-response' | 'insufficient-evidence';
  nativeInferenceCalls: 0;
  rootCauseProven: false;
  capturedAt: number;
  evidenceHash: string;
  inputHash: string | null;
  evidence: BriefEvidence;
  suppliedCitationIds: string[];
  omittedEvidenceCount: number | null;
  messageBytes: number | null;
  inputBytes: number | null;
  generated: GeneratedBrief | null;
}>;

type ReportCase = (typeof data.examples)[number];
const caseIds: readonly BriefExampleId[] = [
  'http-recovery',
  'timeout-gaps',
  'insufficient-history',
];
const hypothesisKinds: readonly BriefHypothesisKind[] = [
  'upstream-http-error',
  'latency-or-timeout',
  'response-contract',
  'transport-failure',
  'evidence-gap',
];
const nextChecks: readonly BriefNextCheck[] = [
  'inspect-service-logs',
  'compare-deployments',
  'verify-response-contract',
  'review-latency-and-timeout',
  'compare-policy-versions',
  'inspect-monitor-scheduler',
];

function exact<T extends string | number | boolean | null>(value: unknown, expected: T): T {
  if (value !== expected) throw new Error('Pinned brief example metadata changed');
  return expected;
}
function oneOf<const T extends readonly string[]>(value: string, choices: T): T[number] {
  for (const choice of choices) if (value === choice) return choice;
  throw new Error('Pinned brief example contains an unsupported value');
}
function hash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid example provenance hash');
  return value;
}
function freeze<T>(value: T): ReadonlyBriefData<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((child) => freeze(child));
    Object.freeze(value);
  }
  // Every child is frozen above; this cast only describes that readonly transform.
  return value as ReadonlyBriefData<T>;
}

/**
 * Only pinned public presentation fields are copied. Raw prompts, provider
 * envelopes, harness environment and private request/session fields stay out
 * of this contract. Hashes identify the full selected source snapshot, not a
 * live incident or a signed proof that an explanation is true.
 */
function publicEvidence(value: ReportCase['evidence']): BriefEvidence {
  return {
    schemaVersion: exact(value.schemaVersion, 1),
    capturedAt: value.capturedAt,
    incident: {
      id: value.incident.id,
      service: value.incident.service,
      opened: value.incident.opened,
      resolved: value.incident.resolved,
      acknowledged: value.incident.acknowledged,
    },
    range: {
      fromSlot: value.range.fromSlot,
      toSlot: value.range.toSlot,
      retentionStart: value.range.retentionStart,
      limitedByRetention: value.range.limitedByRetention,
    },
    checks: value.checks.map((check) => ({
      id: check.id,
      service: check.service,
      slot: check.slot,
      at: check.at,
      outcome: oneOf(check.outcome, [
        'good',
        'http-error',
        'timeout',
        'network-error',
        'invalid-body',
        'slow',
        'maintenance',
      ]),
      status: check.status,
      latency: check.latency,
      revision: check.revision,
      observedAt: check.observedAt,
      timing: oneOf(check.timing, ['verified', 'legacy', 'invalid']),
    })),
    versions: value.versions.map((version) => ({
      id: version.id,
      service: version.service,
      revision: version.revision,
      recordedAt: version.recordedAt,
      name: version.name,
      transport: oneOf(version.transport, ['https', 'origin']),
      assertion: oneOf(version.assertion, ['ok-json', 'catalog-json']),
      provenance: version.provenance,
      policy: {
        paused: version.policy.paused,
        timeoutMs: version.policy.timeoutMs,
        latencyObjectiveMs: version.policy.latencyObjectiveMs,
        availabilityTarget: version.policy.availabilityTarget,
        failureThreshold: version.policy.failureThreshold,
        recoveryThreshold: version.policy.recoveryThreshold,
      },
    })),
    lifecycle: value.lifecycle.map((event) => ({
      id: event.id,
      action: oneOf(event.action, [
        'incident.opened',
        'incident.acknowledged',
        'incident.recovered',
      ]),
      at: event.at,
    })),
    facts: {
      recordedChecks: value.facts.recordedChecks,
      verifiedChecks: value.facts.verifiedChecks,
      goodChecks: value.facts.goodChecks,
      badChecks: value.facts.badChecks,
      maintenanceChecks: value.facts.maintenanceChecks,
      legacyChecks: value.facts.legacyChecks,
      invalidTimingChecks: value.facts.invalidTimingChecks,
      missingMinutesWithinSlice: value.facts.missingMinutesWithinSlice,
      selectedFromSlot: value.facts.selectedFromSlot,
      selectedToSlot: value.facts.selectedToSlot,
      finishedExpectedMinutesWithinSlice: value.facts.finishedExpectedMinutesWithinSlice,
      finishedEligibleMinutesWithinSlice: value.facts.finishedEligibleMinutesWithinSlice,
      verifiedCoveragePercentWithinFinishedSlice:
        value.facts.verifiedCoveragePercentWithinFinishedSlice,
      outcomes: {
        good: value.facts.outcomes.good,
        'http-error': value.facts.outcomes['http-error'],
        timeout: value.facts.outcomes.timeout,
        'network-error': value.facts.outcomes['network-error'],
        'invalid-body': value.facts.outcomes['invalid-body'],
        slow: value.facts.outcomes.slow,
        maintenance: value.facts.outcomes.maintenance,
      },
    },
    limits: {
      checkLimit: exact(value.limits.checkLimit, 50),
      checksOmitted: value.limits.checksOmitted,
      olderPagesAvailable: value.limits.olderPagesAvailable,
      limitedByRetention: value.limits.limitedByRetention,
      missingPolicyRevisions: [...value.limits.missingPolicyRevisions],
      recoveredPolicyRevisions: [...value.limits.recoveredPolicyRevisions],
      includesCurrentMinute: value.limits.includesCurrentMinute,
      measurement: exact(value.limits.measurement, 'one-coordinator-sampled-checks'),
      responseBodiesAvailable: exact(value.limits.responseBodiesAvailable, false),
      privateNotesIncluded: exact(value.limits.privateNotesIncluded, false),
    },
    references: value.references.map((reference) => ({
      id: reference.id,
      kind: oneOf(reference.kind, ['check', 'policy', 'lifecycle', 'fact', 'limit']),
      label: reference.label,
      detail: reference.detail,
      allowedKinds: reference.allowedKinds.map((kind) => oneOf(kind, hypothesisKinds)),
    })),
  };
}

function example(value: ReportCase): BriefExample {
  const evidence = publicEvidence(value.evidence);
  exact(value.sourceKind, 'controlled-fixture');
  exact(value.nativeInferenceCalls, 0);
  exact(value.rootCauseProven, false);
  exact(value.capturedAt, evidence.capturedAt);
  const common = {
    id: oneOf(value.id, caseIds),
    label: value.label,
    description: value.description,
    sourceKind: 'controlled-fixture' as const,
    nativeInferenceCalls: 0 as const,
    rootCauseProven: false as const,
    capturedAt: evidence.capturedAt,
    evidenceHash: hash(value.evidenceHash),
    evidence,
  };
  if (value.inputHash === null) {
    exact(value.disposition, 'insufficient-evidence');
    exact(value.responseOrigin, 'none');
    exact(value.generated, null);
    exact(value.omittedEvidenceCount, null);
    exact(value.messageBytes, null);
    exact(value.inputBytes, null);
    exact(value.suppliedCitationIds.length, 0);
    return freeze({
      ...common,
      responseOrigin: 'none',
      disposition: 'insufficient-evidence',
      inputHash: null,
      suppliedCitationIds: [],
      omittedEvidenceCount: null,
      messageBytes: null,
      inputBytes: null,
      generated: null,
    });
  }
  exact(value.disposition, 'validated-canned-response');
  exact(value.responseOrigin, 'human-authored-canned-envelope');
  if (
    value.generated === null ||
    value.omittedEvidenceCount === null ||
    value.messageBytes === null ||
    value.inputBytes === null
  )
    throw new Error('Missing canned example response or preparation provenance');
  const generated: GeneratedBrief = {
    hypotheses: value.generated.hypotheses.map((hypothesis) => ({
      kind: oneOf(hypothesis.kind, hypothesisKinds),
      explanation: hypothesis.explanation,
      evidenceIds: [...hypothesis.evidenceIds],
      nextChecks: hypothesis.nextChecks.map((step) => oneOf(step, nextChecks)),
    })),
  };
  return freeze({
    ...common,
    responseOrigin: 'human-authored-canned-envelope',
    disposition: 'validated-canned-response',
    inputHash: hash(value.inputHash),
    suppliedCitationIds: [...value.suppliedCitationIds],
    omittedEvidenceCount: value.omittedEvidenceCount,
    messageBytes: value.messageBytes,
    inputBytes: value.inputBytes,
    generated,
  });
}

if (data.examples.length !== 3 || new Set(data.examples.map((item) => item.id)).size !== 3)
  throw new Error('Pinned examples must contain exactly three distinct controlled cases');

export const source = freeze({
  sourceProjectVersion: exact(data.source.sourceProjectVersion, '3.3.2'),
  sourceArtifactURL: exact(
    data.source.sourceArtifactURL,
    'https://github.com/HenryWashuHe/edgelab/blob/67b27d01aacefdae1d6b5918240d54b9ddeb4769/docs/evidence/releases/3.3.2-brief-evaluation.json',
  ),
  evaluationGuideURL: exact(
    data.source.evaluationGuideURL,
    'https://github.com/HenryWashuHe/edgelab/blob/67b27d01aacefdae1d6b5918240d54b9ddeb4769/docs/BRIEF_EVALUATION.md',
  ),
  reportVersion: exact(data.source.reportVersion, 1),
  suiteVersion: exact(data.source.suiteVersion, 1),
  promptVersion: exact(data.source.promptVersion, 1),
  schemaVersion: exact(data.source.schemaVersion, 1),
  model: exact(data.source.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
  mode: exact(data.source.mode, 'offline'),
  sourceKind: exact(data.source.sourceKind, 'controlled-fixtures-only'),
  responseOrigin: 'human-authored-canned-envelope' as const,
  nativeInferenceCalls: exact(data.source.nativeInferenceCalls, 0),
  cloudflareAccountQueries: exact(data.source.cloudflareAccountQueries, 0),
  productionWrites: exact(data.source.productionWrites, 0),
  modelQualityMeasured: exact(data.source.modelQualityMeasured, false),
  nativeProviderVerified: exact(data.source.nativeProviderVerified, false),
  rootCauseProven: exact(data.source.rootCauseProven, false),
  maxMessageBytes: data.source.maxMessageBytes,
  maxInputBytes: data.source.maxInputBytes,
  maxOutputTokens: data.source.maxOutputTokens,
});

export const examples: readonly BriefExample[] = freeze(data.examples.map(example));
export const briefExamplesSource = source;
export const briefExamples = examples;
