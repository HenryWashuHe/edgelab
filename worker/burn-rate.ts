import { MINUTE, type ProbeResult } from './monitor-domain';

export type BurnRateCheck = {
  slot: number;
  observedAt: number | null;
  revision: number;
  outcome: ProbeResult['outcome'];
};
export type BurnRateInput = {
  now: number;
  revision: number;
  policyRecordedAt: number;
  /** Good-check objective expressed as a percentage, e.g. 99.9. */
  target: number;
  paused: boolean;
  checks: BurnRateCheck[];
};
export type BurnRateState = 'firing' | 'clear' | 'insufficient-evidence' | 'maintenance';
export type BurnRuleId = 'rapid' | 'sustained' | 'gradual';
export type BurnWindowEvidence = {
  minutes: number;
  startSlot: number;
  endSlot: number;
  expected: number;
  observed: number;
  good: number;
  bad: number;
  maintenance: number;
  unknown: number;
  coverage: number | null;
  burnRate: number | null;
  mature: boolean;
};
export type BurnRuleEvidence = {
  id: BurnRuleId;
  name: string;
  long: BurnWindowEvidence;
  short: BurnWindowEvidence;
  threshold: number;
  state: BurnRateState;
  reason: string;
};
export type BurnRateEvaluation = {
  ruleVersion: 1;
  revision: number;
  computedAt: number;
  state: BurnRateState;
  highestFiring: BurnRuleId | null;
  rules: BurnRuleEvidence[];
};

/** Fixed paired-window thresholds from the Google SRE Workbook's 30-day budget examples. */
export const BURN_RATE_RULES = [
  { id: 'rapid', name: 'Rapid burn', longMinutes: 60, shortMinutes: 5, threshold: 14.4 },
  { id: 'sustained', name: 'Sustained burn', longMinutes: 360, shortMinutes: 30, threshold: 6 },
  { id: 'gradual', name: 'Gradual burn', longMinutes: 4320, shortMinutes: 360, threshold: 1 },
] as const;
/** Project-specific sampling gates, not canonical Google parameters or request-availability claims. */
export const BURN_RATE_MIN_COVERAGE = 95;
export const BURN_RATE_MIN_SHORT_OBSERVATIONS = 5;
export const BURN_RATE_MIN_LONG_OBSERVATIONS = 20;

const outcomes = new Set<ProbeResult['outcome']>([
  'good',
  'http-error',
  'timeout',
  'network-error',
  'invalid-body',
  'slow',
  'maintenance',
]);
const sameCheck = (left: BurnRateCheck, right: BurnRateCheck) =>
  left.observedAt === right.observedAt &&
  left.revision === right.revision &&
  left.outcome === right.outcome;

/**
 * Evaluate sampled checks, never customer requests. Windows contain finished UTC minutes only.
 * Exact duplicates collapse; conflicting duplicate evidence makes a slot unknown. Unknown slots
 * cannot improve coverage, and full policy-window maturity prevents partial history becoming clear.
 */
export function evaluateBurnRates(input: BurnRateInput): BurnRateEvaluation {
  const validClock = Number.isFinite(input.now) && input.now >= 0;
  const validPolicy =
    validClock &&
    Number.isSafeInteger(input.revision) &&
    input.revision > 0 &&
    Number.isFinite(input.policyRecordedAt) &&
    input.policyRecordedAt >= 0 &&
    input.policyRecordedAt <= input.now &&
    Number.isFinite(input.target) &&
    input.target > 0 &&
    input.target < 100;
  const endSlot = validClock ? Math.floor(input.now / MINUTE) - 1 : -1;
  const earliestSlot = endSlot - BURN_RATE_RULES[2].longMinutes + 1;
  const firstPolicySlot = validPolicy ? Math.ceil(input.policyRecordedAt / MINUTE) : Infinity;
  const budgetRatio = validPolicy ? (100 - input.target) / 100 : null;
  const bySlot = new Map<number, BurnRateCheck | null>();
  for (const check of input.checks) {
    if (
      !Number.isSafeInteger(check.slot) ||
      check.slot < 0 ||
      check.slot < earliestSlot ||
      check.slot > endSlot
    )
      continue;
    if (!bySlot.has(check.slot)) bySlot.set(check.slot, check);
    else {
      const previous = bySlot.get(check.slot);
      if (previous === null || !previous || !sameCheck(previous, check))
        bySlot.set(check.slot, null);
    }
  }

  const window = (minutes: number): BurnWindowEvidence => {
    const startSlot = endSlot - minutes + 1;
    let good = 0;
    let bad = 0;
    let maintenance = 0;
    for (let slot = startSlot; slot <= endSlot; slot++) {
      const check = bySlot.get(slot);
      if (
        !validPolicy ||
        !check ||
        check.revision !== input.revision ||
        check.observedAt === null ||
        !Number.isFinite(check.observedAt) ||
        check.observedAt < input.policyRecordedAt ||
        Math.floor(check.observedAt / MINUTE) !== slot ||
        !outcomes.has(check.outcome)
      )
        continue;
      if (check.outcome === 'maintenance') maintenance++;
      else if (check.outcome === 'good') good++;
      else bad++;
    }
    const observed = good + bad;
    const eligible = minutes - maintenance;
    return {
      minutes,
      startSlot,
      endSlot,
      expected: minutes,
      observed,
      good,
      bad,
      maintenance,
      unknown: minutes - observed - maintenance,
      coverage: eligible > 0 ? (100 * observed) / eligible : null,
      burnRate: observed > 0 && budgetRatio !== null ? bad / observed / budgetRatio : null,
      mature: startSlot >= firstPolicySlot,
    };
  };
  const qualifies = (evidence: BurnWindowEvidence, minimum: number) =>
    evidence.mature &&
    evidence.coverage !== null &&
    evidence.coverage >= BURN_RATE_MIN_COVERAGE &&
    evidence.observed >= minimum;
  const allMaintenance = (evidence: BurnWindowEvidence) =>
    evidence.maintenance === evidence.expected && evidence.unknown === 0;

  const rules: BurnRuleEvidence[] = BURN_RATE_RULES.map((rule) => {
    const long = window(rule.longMinutes);
    const short = window(rule.shortMinutes);
    const evidence = { id: rule.id, name: rule.name, long, short, threshold: rule.threshold };
    if (input.paused)
      return { ...evidence, state: 'maintenance', reason: 'The current policy pauses probing.' };
    if (allMaintenance(long) && allMaintenance(short))
      return {
        ...evidence,
        state: 'maintenance',
        reason: 'Both windows contain only verified maintenance minutes.',
      };
    if (!validPolicy)
      return {
        ...evidence,
        state: 'insufficient-evidence',
        reason:
          'A valid clock, current revision, policy timestamp, and percentage target are required.',
      };
    if (
      !qualifies(long, BURN_RATE_MIN_LONG_OBSERVATIONS) ||
      !qualifies(short, BURN_RATE_MIN_SHORT_OBSERVATIONS)
    )
      return {
        ...evidence,
        state: 'insufficient-evidence',
        reason:
          'Both policy windows must be mature with at least 95% coverage, 20 long-window and 5 short-window non-maintenance observations.',
      };
    const firing =
      long.burnRate !== null &&
      short.burnRate !== null &&
      long.burnRate >= rule.threshold &&
      short.burnRate >= rule.threshold;
    return {
      ...evidence,
      state: firing ? 'firing' : 'clear',
      reason: firing
        ? 'Both qualified windows meet or exceed the burn-rate threshold.'
        : 'The qualified windows do not both reach the burn-rate threshold.',
    };
  });
  const highestFiring = rules.find((rule) => rule.state === 'firing')?.id ?? null;
  const state: BurnRateState = highestFiring
    ? 'firing'
    : rules.some((rule) => rule.state === 'insufficient-evidence')
      ? 'insufficient-evidence'
      : rules.every((rule) => rule.state === 'maintenance')
        ? 'maintenance'
        : 'clear';
  return {
    ruleVersion: 1,
    revision: input.revision,
    computedAt: input.now,
    state,
    highestFiring,
    rules,
  };
}
