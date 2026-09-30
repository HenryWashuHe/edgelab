import { describe, expect, it } from 'vitest';
import { MINUTE } from '../worker/monitor-domain';
import {
  evaluateBurnRates,
  type BurnRateCheck,
  type BurnRateInput,
  type BurnRuleId,
} from '../worker/burn-rate';

const now = 10_000 * MINUTE;
const end = now / MINUTE - 1;
const checks = (outcome: BurnRateCheck['outcome'] = 'good'): BurnRateCheck[] =>
  Array.from({ length: 4320 }, (_, index) => ({
    slot: end - 4319 + index,
    observedAt: (end - 4319 + index) * MINUTE + 100,
    revision: 1,
    outcome,
  }));
const input = (overrides: Partial<BurnRateInput> = {}): BurnRateInput => ({
  now,
  revision: 1,
  policyRecordedAt: 0,
  target: 99.9,
  paused: false,
  checks: checks(),
  ...overrides,
});
const rule = (value: BurnRateInput, id: BurnRuleId = 'rapid') =>
  evaluateBurnRates(value).rules.find((item) => item.id === id)!;
const bad = (value: BurnRateCheck[], slots: number[]) =>
  value.map((check) =>
    slots.includes(check.slot) ? { ...check, outcome: 'http-error' as const } : check,
  );

describe('paired-window sampled-check burn rates', () => {
  it('returns fixed versioned rules and complete clear evidence for healthy history', () => {
    const result = evaluateBurnRates(input());
    expect(result).toMatchObject({
      ruleVersion: 1,
      revision: 1,
      computedAt: now,
      state: 'clear',
      highestFiring: null,
    });
    expect(result.rules.map(({ id, threshold }) => ({ id, threshold }))).toEqual([
      { id: 'rapid', threshold: 14.4 },
      { id: 'sustained', threshold: 6 },
      { id: 'gradual', threshold: 1 },
    ]);
    expect(result.rules[0].long).toEqual({
      minutes: 60,
      startSlot: end - 59,
      endSlot: end,
      expected: 60,
      observed: 60,
      good: 60,
      bad: 0,
      maintenance: 0,
      unknown: 0,
      coverage: 100,
      burnRate: 0,
      mature: true,
    });
    expect(result.rules.map(({ long, short }) => [long.minutes, short.minutes])).toEqual([
      [60, 5],
      [360, 30],
      [4320, 360],
    ]);
  });

  it('detects repeated intermittent failure and prioritizes rapid over other firing rules', () => {
    const alternating = checks().map((check) => ({
      ...check,
      outcome: check.slot % 2 === 0 ? ('good' as const) : ('timeout' as const),
    }));
    const result = evaluateBurnRates(input({ checks: alternating }));
    expect(result.state).toBe('firing');
    expect(result.highestFiring).toBe('rapid');
    expect(result.rules.every(({ state }) => state === 'firing')).toBe(true);
    expect(result.rules[0].long.bad).toBe(30);
  });

  it('reports the coarse signal from a single recent failure without inventing request traffic', () => {
    const recent = rule(input({ checks: bad(checks(), [end]) }));
    expect(recent.state).toBe('firing');
    expect(recent.long.burnRate).toBeCloseTo(1000 / 60);
    expect(recent.short.burnRate).toBeCloseTo(200);
    expect(recent.long.observed).toBe(60);
  });

  it('does not keep firing after the short window recovers despite historical budget burn', () => {
    const history = bad(
      checks(),
      Array.from({ length: 20 }, (_, index) => end - 59 + index),
    );
    const rapid = rule(input({ checks: history }));
    expect(rapid.long.burnRate).toBeGreaterThan(14.4);
    expect(rapid.short.burnRate).toBe(0);
    expect(rapid.state).toBe('clear');
  });

  it('excludes the incomplete minute and observations outside the exact windows', () => {
    const extra: BurnRateCheck[] = [
      { slot: end + 1, observedAt: now, revision: 1, outcome: 'timeout' },
      { slot: end - 4320, observedAt: (end - 4320) * MINUTE, revision: 1, outcome: 'timeout' },
    ];
    expect(evaluateBurnRates(input({ checks: [...checks(), ...extra] })).state).toBe('clear');
    expect(rule(input({ now: now + MINUTE - 1 })).long.endSlot).toBe(end);
  });

  it('treats each threshold as inclusive and stays clear immediately below it', () => {
    const rapidHistory = bad(checks(), [
      ...Array.from({ length: 49 }, (_, index) => end - 59 + index),
      ...Array.from({ length: 5 }, (_, index) => end - 4 + index),
    ]);
    const rapid = rule(input({ target: 93.75, checks: rapidHistory }));
    expect(rapid.long.burnRate).toBe(14.4);
    expect(rapid.state).toBe('firing');
    expect(rule(input({ target: 93.75 - 0.000001, checks: rapidHistory })).state).toBe('clear');

    const sustainedHistory = bad(checks(), [
      ...Array.from({ length: 123 }, (_, index) => end - 359 + index),
      ...Array.from({ length: 12 }, (_, index) => end - 11 + index),
    ]);
    const sustained = rule(input({ target: 93.75, checks: sustainedHistory }), 'sustained');
    expect(sustained.long.burnRate).toBe(6);
    expect(sustained.state).toBe('firing');
    expect(
      evaluateBurnRates(input({ target: 93.75, checks: sustainedHistory })).highestFiring,
    ).toBe('sustained');
    expect(
      rule(input({ target: 93.75 - 0.000001, checks: sustainedHistory }), 'sustained').state,
    ).toBe('clear');

    const gradualHistory = bad(checks(), [
      ...Array.from({ length: 247 }, (_, index) => end - 4319 + index),
      ...Array.from({ length: 23 }, (_, index) => end - 22 + index),
    ]);
    const gradual = rule(input({ target: 93.75, checks: gradualHistory }), 'gradual');
    expect(gradual.long.burnRate).toBe(1);
    expect(gradual.state).toBe('firing');
    expect(evaluateBurnRates(input({ target: 93.75, checks: gradualHistory })).highestFiring).toBe(
      'gradual',
    );
    expect(rule(input({ target: 93.75 - 0.000001, checks: gradualHistory }), 'gradual').state).toBe(
      'clear',
    );
  });

  it('requires at least 95 percent coverage in each window and exposes unknown slots', () => {
    const atBoundary = checks().filter(
      (check) => ![end - 59, end - 58, end - 57].includes(check.slot),
    );
    const boundary = rule(input({ checks: atBoundary }));
    expect(boundary.long).toMatchObject({ coverage: 95, unknown: 3, observed: 57 });
    expect(boundary.state).toBe('clear');
    const below = rule(input({ checks: atBoundary.filter((check) => check.slot !== end - 56) }));
    expect(below.long.coverage).toBeLessThan(95);
    expect(below.state).toBe('insufficient-evidence');
    const shortGap = rule(input({ checks: checks().filter((check) => check.slot !== end) }));
    expect(shortGap.short).toMatchObject({ coverage: 80, unknown: 1 });
    expect(shortGap.state).toBe('insufficient-evidence');
  });

  it('gives firing precedence when another rule lacks mature history', () => {
    const result = evaluateBurnRates(
      input({ policyRecordedAt: (end - 59) * MINUTE, checks: bad(checks(), [end]) }),
    );
    expect(result.rules[0].state).toBe('firing');
    expect(result.rules[1].state).toBe('insufficient-evidence');
    expect(result.state).toBe('firing');
    expect(result.highestFiring).toBe('rapid');
  });

  it('marks a paused policy or completely verified maintenance history as maintenance', () => {
    expect(evaluateBurnRates(input({ paused: true, checks: [] })).state).toBe('maintenance');
    const result = evaluateBurnRates(input({ checks: checks('maintenance') }));
    expect(result.state).toBe('maintenance');
    expect(result.highestFiring).toBeNull();
    expect(result.rules.every(({ state }) => state === 'maintenance')).toBe(true);
    expect(result.rules[0].long).toMatchObject({
      maintenance: 60,
      observed: 0,
      unknown: 0,
      coverage: null,
      burnRate: null,
    });
  });

  it('does not mistake sparse or mixed maintenance for qualified healthy evidence', () => {
    const mixed = checks().map((check) => ({
      ...check,
      outcome:
        check.slot >= end - 59 && check.slot < end - 18 ? ('maintenance' as const) : check.outcome,
    }));
    const sparse = rule(input({ checks: mixed }));
    expect(sparse.long).toMatchObject({ coverage: 100, observed: 19, maintenance: 41 });
    expect(sparse.state).toBe('insufficient-evidence');
    const sufficient = rule(
      input({
        checks: mixed.map((check) =>
          check.slot === end - 19 ? { ...check, outcome: 'good' } : check,
        ),
      }),
    );
    expect(sufficient.long.observed).toBe(20);
    expect(sufficient.state).toBe('clear');
    const sparseShort = rule(
      input({
        checks: checks().map((check) =>
          check.slot === end ? { ...check, outcome: 'maintenance' } : check,
        ),
      }),
    );
    expect(sparseShort.short).toMatchObject({ coverage: 100, observed: 4, maintenance: 1 });
    expect(sparseShort.state).toBe('insufficient-evidence');
    const missingMaintenance = evaluateBurnRates(
      input({ checks: checks('maintenance').filter((check) => check.slot !== end) }),
    );
    expect(missingMaintenance.state).toBe('insufficient-evidence');
  });

  it('requires a full current-policy window, including a policy change inside a minute', () => {
    const atBoundary = rule(input({ policyRecordedAt: (end - 59) * MINUTE }));
    expect(atBoundary.long.mature).toBe(true);
    const insideMinute = rule(input({ policyRecordedAt: (end - 59) * MINUTE + 1 }));
    expect(insideMinute.long.mature).toBe(false);
    expect(insideMinute.state).toBe('insufficient-evidence');
    const changed = evaluateBurnRates(input({ revision: 2, policyRecordedAt: now - 30 * MINUTE }));
    expect(changed.state).toBe('insufficient-evidence');
    expect(changed.rules[0].long).toMatchObject({ observed: 0, unknown: 60, mature: false });
  });

  it('rejects legacy, other revisions, mismatched actual starts, and pre-policy observations', () => {
    for (const patch of [
      { observedAt: null },
      { observedAt: now },
      { observedAt: -1 },
      { observedAt: NaN },
      { observedAt: Infinity },
      { revision: 2 },
    ]) {
      const values = checks().map((check) => (check.slot === end ? { ...check, ...patch } : check));
      const rapid = rule(input({ checks: values }));
      expect(rapid.short).toMatchObject({ observed: 4, unknown: 1 });
      expect(rapid.state).toBe('insufficient-evidence');
    }
    const prePolicy = rule(input({ policyRecordedAt: end * MINUTE + 101 }));
    expect(prePolicy.short.observed).toBe(0);
  });

  it('deduplicates identical evidence but makes conflicting slots unknown independent of order', () => {
    const history = checks();
    const latest = history[history.length - 1];
    const identical = rule(input({ checks: [...history, { ...latest }] }));
    expect(identical.short).toMatchObject({ observed: 5, unknown: 0 });
    expect(identical.state).toBe('clear');
    for (const conflict of [
      { ...latest, outcome: 'timeout' as const },
      { ...latest, observedAt: latest.observedAt! + 1 },
      { ...latest, revision: 2 },
    ]) {
      const duplicate = [...history, conflict];
      const forward = rule(input({ checks: duplicate }));
      expect(forward.short).toMatchObject({ observed: 4, unknown: 1 });
      expect(forward.state).toBe('insufficient-evidence');
      expect(rule(input({ checks: [...duplicate].reverse() }))).toEqual(forward);
    }
  });

  it('keeps empty history unknown and rejects invalid policy metadata without nonfinite rates', () => {
    const empty = evaluateBurnRates(input({ checks: [] }));
    expect(empty.state).toBe('insufficient-evidence');
    expect(empty.rules[0].long).toMatchObject({
      observed: 0,
      unknown: 60,
      coverage: 0,
      burnRate: null,
    });
    for (const patch of [
      { target: 100 },
      { target: 0 },
      { target: NaN },
      { revision: 0 },
      { revision: 1.5 },
      { policyRecordedAt: now + 1 },
      { policyRecordedAt: -1 },
      { policyRecordedAt: NaN },
      { now: NaN },
      { now: -1 },
    ]) {
      const invalid = evaluateBurnRates(input(patch));
      expect(invalid.state).toBe('insufficient-evidence');
      expect(
        invalid.rules.every(({ long, short }) => long.burnRate === null && short.burnRate === null),
      ).toBe(true);
    }
  });

  it('is read-only and ages existing samples instead of renewing them on evaluation', () => {
    const evidence = input();
    const before = structuredClone(evidence);
    expect(evaluateBurnRates(evidence).state).toBe('clear');
    expect(evaluateBurnRates({ ...evidence, now: now + 5 * MINUTE }).state).toBe(
      'insufficient-evidence',
    );
    expect(evidence).toEqual(before);
  });
});
