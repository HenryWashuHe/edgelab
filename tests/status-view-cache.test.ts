import { describe, expect, it } from 'vitest';
import { evaluateBurnRates } from '../worker/burn-rate';
import {
  projectBudgetSignal,
  type BudgetAgeSource,
  type BudgetSignalSnapshot,
} from '../worker/budget-signals';
import {
  defaultPolicy,
  initialMonitorState,
  MINUTE,
  type ProbeResult,
} from '../worker/monitor-domain';
import { monitoringReadiness } from '../worker/monitor-readiness';
import {
  projectStatusView,
  statusServiceAt,
  StatusViewCache,
  STATUS_VIEW_MAX_AGE_MS,
  STATUS_VIEW_MAX_BYTES,
  type StatusWindow,
} from '../worker/status-view-cache';

const now = 10 * MINUTE + 1000;
const observedAt = now - 180000;
const sources = (): BudgetAgeSource[] => [{ revision: 1, computedAt: observedAt }];
const snapshot = () => {
  const evaluation = evaluateBurnRates({
    now: observedAt,
    revision: 1,
    policyRecordedAt: 0,
    target: defaultPolicy.availabilityTarget,
    paused: false,
    checks: [],
  });
  const budget: BudgetSignalSnapshot = {
    evaluation,
    evaluationStatus: 'current',
    lastFiring: {
      revision: 1,
      rule: 'rapid',
      firstFiredAt: observedAt - MINUTE,
      lastConfirmedAt: observedAt,
      evidence: evaluation.rules[0],
      policyContext: null,
    },
  };
  return {
    version: 'fixture',
    now,
    window: '24h',
    services: [
      {
        id: 'catalog',
        name: 'Catalog',
        revision: 1,
        policy: { ...defaultPolicy },
        state: initialMonitorState(),
        latest: {
          slot: Math.floor(observedAt / MINUTE),
          at: observedAt + 200,
          observedAt: observedAt as number | null,
          revision: 1,
          outcome: 'good' as ProbeResult['outcome'],
        },
        status: 'healthy',
        budget,
        metrics: { expected: 9, good: 9, p95Ms: 20, windowStart: MINUTE, windowEnd: 10 * MINUTE },
        hourly: [{ at: 0, total: 9, good: 9 }],
        history: [{ at: observedAt, observedAt, revision: 1 }],
      },
    ],
    monitoring: monitoringReadiness({
      now,
      lastStartedAt: observedAt,
      lastCompletedAt: observedAt,
      lastSlot: Math.floor(observedAt / MINUTE),
      services: [{ paused: false, lastObservedAt: observedAt }],
    }),
    scheduler: [{ at: observedAt, detail: { cleanup: { cutoff: 0 } } }],
    incidents: [{ opened: observedAt - MINUTE, resolved: null, acknowledged: observedAt }],
    padding: '',
  };
};
type View = ReturnType<typeof snapshot>;
const cache = () => new StatusViewCache<View>();

describe('bounded instance status views', () => {
  it('reports source provenance without exposing the captured budget columns or config fingerprint', () => {
    const store = cache();
    const first = store.materialize('24h', 'private-target-url', snapshot(), sources());
    expect(first.read).toEqual({
      source: 'storage',
      materializedAt: now,
      servedAt: now,
      ageMs: 0,
      maxAgeMs: 10000,
    });
    const hit = store.read('24h', 'private-target-url', now + 1)!;
    expect(hit.read).toEqual({
      source: 'memory',
      materializedAt: now,
      servedAt: now + 1,
      ageMs: 1,
      maxAgeMs: 10000,
    });
    expect(hit.now).toBe(now + 1);
    const publicJSON = JSON.stringify(hit);
    for (const privateKey of ['budgetSources', 'ageSource', 'private-target-url', 'computed_at'])
      expect(publicJSON).not.toContain(privateKey);
  });

  it('expires at exactly ten seconds, and repeated hits do not renew capture time', () => {
    const store = cache();
    store.materialize('24h', 'config', snapshot(), sources());
    for (const offset of [1, 5000, 9999])
      expect(store.read('24h', 'config', now + offset)?.read.materializedAt).toBe(now);
    expect(store.read('24h', 'config', now + STATUS_VIEW_MAX_AGE_MS)).toBeNull();
    expect(store.read('24h', 'config', now + STATUS_VIEW_MAX_AGE_MS + 1)).toBeNull();
  });

  it('misses at a UTC minute boundary even with one millisecond of age', () => {
    const store = cache();
    const view = snapshot();
    view.now = 11 * MINUTE - 1;
    store.materialize('24h', 'config', view, sources());
    expect(store.read('24h', 'config', 11 * MINUTE)).toBeNull();
  });

  it('clears both windows after rollback, invalid time, changed configuration or explicit invalidation', () => {
    for (const action of [
      (store: StatusViewCache<View>) => store.read('24h', 'config', now - 1),
      (store: StatusViewCache<View>) => store.read('24h', 'config', NaN),
      (store: StatusViewCache<View>) => store.read('24h', 'config', Infinity),
      (store: StatusViewCache<View>) => store.read('24h', 'config', -1),
      (store: StatusViewCache<View>) => store.read('24h', 'config', 8640000000000001),
      (store: StatusViewCache<View>) => store.read('24h', 'changed', now),
      (store: StatusViewCache<View>) => store.invalidate(),
    ]) {
      const store = cache();
      store.materialize('24h', 'config', snapshot(), sources());
      store.materialize('7d', 'config', snapshot(), sources());
      expect(store.entryCount).toBe(2);
      action(store);
      expect(store.entryCount).toBe(0);
      expect(store.read('7d', 'config', now)).toBeNull();
    }
  });

  it('ages service, budget and scheduler at 180001 ms without changing original evidence or metrics', () => {
    const store = cache();
    const input = snapshot();
    const original = structuredClone(input);
    store.materialize('24h', 'config', input, sources());
    expect(store.read('24h', 'config', now)).toMatchObject({
      services: [{ status: 'healthy', budget: { evaluationStatus: 'current' } }],
      monitoring: { status: 'healthy', ageMs: 180000 },
    });
    const hit = store.read('24h', 'config', now + 1)!;
    expect(hit).toMatchObject({
      services: [{ status: 'unknown', budget: { evaluationStatus: 'stale' } }],
      monitoring: { status: 'stalled', ageMs: 180001 },
    });
    expect(hit.services[0].latest).toEqual(original.services[0].latest);
    expect(hit.services[0].budget.evaluation).toEqual(original.services[0].budget.evaluation);
    expect(hit.services[0].budget.lastFiring).toEqual(original.services[0].budget.lastFiring);
    expect(hit.services[0].metrics).toEqual(original.services[0].metrics);
    expect(hit.services[0].hourly).toEqual(original.services[0].hourly);
    expect(hit.services[0].history).toEqual(original.services[0].history);
    expect(hit.scheduler).toEqual(original.scheduler);
    expect(hit.incidents).toEqual(original.incidents);
    expect(hit.monitoring.lastCompletedAt).toBe(original.monitoring.lastCompletedAt);
    expect(input).toEqual(original);
  });

  it('projects active/paused, incident, degraded, old revision, future and legacy service states', () => {
    const service = snapshot().services[0];
    expect(statusServiceAt(service, now)).toBe('healthy');
    service.state.incidentId = 'incident';
    expect(statusServiceAt(service, now)).toBe('incident');
    service.state.incidentId = null;
    service.latest.outcome = 'http-error';
    expect(statusServiceAt(service, now)).toBe('degraded');
    service.latest.revision = 0;
    expect(statusServiceAt(service, now)).toBe('unknown');
    service.latest.revision = 1;
    service.latest.observedAt = now + 1;
    expect(statusServiceAt(service, now)).toBe('unknown');
    service.latest.observedAt = null;
    expect(statusServiceAt(service, now)).toBe('unknown');
    service.policy.paused = true;
    expect(statusServiceAt(service, now + 1)).toBe('maintenance');
  });

  it('uses row timestamps and revision rather than inconsistent evaluation JSON metadata', () => {
    const store = cache();
    const view = snapshot();
    view.services[0].budget.evaluation!.computedAt = now;
    view.services[0].budget.evaluation!.revision = 99;
    store.materialize('24h', 'config', view, sources());
    expect(store.read('24h', 'config', now + 1)?.services[0].budget).toMatchObject({
      evaluationStatus: 'stale',
      evaluation: { computedAt: now, revision: 99 },
    });
    const other = cache();
    other.materialize('7d', 'config', view, [{ revision: 2, computedAt: now }]);
    expect(other.read('7d', 'config', now + 1)?.services[0].budget.evaluationStatus).toBe(
      'policy-changed',
    );
  });

  it('preserves missing evaluations and does not cache malformed numeric row metadata', () => {
    const store = cache();
    const missing = snapshot();
    missing.services[0].budget = {
      evaluation: null,
      evaluationStatus: 'not-evaluated',
      lastFiring: null,
    };
    store.materialize('24h', 'config', missing, [null]);
    expect(store.read('24h', 'config', now + 1)?.services[0].budget.evaluationStatus).toBe(
      'not-evaluated',
    );
    for (const computedAt of [NaN, Infinity, -1, 'invalid' as unknown as number]) {
      const result = store.materialize('24h', 'config', snapshot(), [{ revision: 1, computedAt }]);
      expect(result.read.source).toBe('storage');
      expect(store.read('24h', 'config', now)).toBeNull();
    }
    const first = snapshot().services[0].budget;
    expect(
      projectBudgetSignal(first, { revision: 1, computedAt: NaN }, 1, now).evaluationStatus,
    ).toBe('stale');
    expect(
      projectBudgetSignal(first, { revision: 1, computedAt: now + 1 }, 1, now).evaluationStatus,
    ).toBe('stale');
  });

  it('does not share mutable input, source metadata or response objects with later callers', () => {
    const store = cache();
    const input = snapshot();
    const ages = sources();
    const first = store.materialize('24h', 'config', input, ages);
    input.services[0].name = 'changed input';
    input.services[0].budget.evaluation!.computedAt = now + 99;
    ages[0]!.computedAt = now;
    first.services[0].name = 'changed response';
    first.scheduler[0].detail.cleanup.cutoff = 99;
    const hit = store.read('24h', 'config', now + 1)!;
    expect(hit.services[0].name).toBe('Catalog');
    expect(hit.services[0].budget.evaluationStatus).toBe('stale');
    expect(hit.scheduler[0].detail.cleanup.cutoff).toBe(0);
    hit.services[0].metrics.expected = 1234;
    expect(store.read('24h', 'config', now + 2)?.services[0].metrics.expected).toBe(9);
  });

  it('counts UTF-8 bytes of both snapshots plus private age envelopes and keeps at most two keys', () => {
    const store = cache();
    const view = snapshot();
    view.padding = '界'.repeat(60000);
    const expectedBytes = new TextEncoder().encode(
      JSON.stringify({ snapshot: view, budgetSources: sources() }),
    ).byteLength;
    store.materialize('24h', 'config', view, sources());
    store.materialize('7d', 'config', view, sources());
    expect(store.retainedBytes).toBe(2 * expectedBytes);
    expect(store.retainedBytes).toBeLessThanOrEqual(STATUS_VIEW_MAX_BYTES);
    for (let index = 0; index < 100; index++)
      store.materialize(`untrusted-${index}` as StatusWindow, 'config', view, sources());
    expect(store.entryCount).toBe(2);
  });

  it('evicts the older window when their combined payload would exceed the cap', () => {
    const store = cache();
    const view = snapshot();
    view.padding = 'a'.repeat(600000);
    store.materialize('24h', 'config', view, sources());
    store.materialize('7d', 'config', view, sources());
    expect(store.entryCount).toBe(1);
    expect(store.retainedBytes).toBeLessThanOrEqual(STATUS_VIEW_MAX_BYTES);
    expect(store.read('24h', 'config', now)).toBeNull();
    expect(store.read('7d', 'config', now)).not.toBeNull();
  });

  it('returns an oversized authoritative view intact without retaining it', () => {
    const store = cache();
    const view = snapshot();
    view.padding = '🧪'.repeat(STATUS_VIEW_MAX_BYTES / 4);
    const result = store.materialize('24h', 'config', view, sources());
    expect(result.padding).toBe(view.padding);
    expect(result.read.source).toBe('storage');
    expect(store.entryCount).toBe(0);
    expect(store.retainedBytes).toBe(0);
    expect(store.read('24h', 'config', now)).toBeNull();
  });

  it('includes the private envelope at the exact byte boundary and refuses one additional byte', () => {
    const store = cache();
    const view = snapshot();
    const base = new TextEncoder().encode(
      JSON.stringify({ snapshot: view, budgetSources: sources() }),
    ).byteLength;
    view.padding = 'a'.repeat(STATUS_VIEW_MAX_BYTES - base);
    store.materialize('24h', 'config', view, sources());
    expect(store.retainedBytes).toBe(STATUS_VIEW_MAX_BYTES);
    expect(store.read('24h', 'config', now)?.padding).toBe(view.padding);
    view.padding += 'b';
    expect(store.materialize('24h', 'config', view, sources()).padding).toBe(view.padding);
    expect(store.entryCount).toBe(0);
    expect(store.retainedBytes).toBe(0);
  });

  it('projects paused/missing/future scheduler evidence conservatively without renewing a heartbeat', () => {
    const view = snapshot();
    view.services[0].policy.paused = true;
    expect(projectStatusView(view, sources(), now, 'storage').monitoring.status).toBe('healthy');
    expect(projectStatusView(view, sources(), now + 1, 'memory').monitoring.status).toBe('stalled');
    view.monitoring.lastCompletedAt = null;
    expect(projectStatusView(view, sources(), now, 'storage').monitoring.status).toBe('starting');
    view.monitoring.lastCompletedAt = now + 1;
    expect(projectStatusView(view, sources(), now, 'storage').monitoring.status).toBe('stalled');
    expect(projectStatusView(view, sources(), NaN, 'storage').monitoring.status).toBe('stalled');
  });
});
