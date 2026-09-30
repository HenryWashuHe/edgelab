import { describe, expect, it } from 'vitest';
import {
  classifyTick,
  MONITOR_CADENCE_MS,
  MONITOR_FRESHNESS_MS,
  monitoringReadiness,
  type MonitoringReadinessInput,
} from '../worker/monitor-readiness';

const now = 20 * MONITOR_CADENCE_MS;
const ready: MonitoringReadinessInput = {
  now,
  services: [{ paused: false, lastObservedAt: now - MONITOR_CADENCE_MS }],
  lastStartedAt: now - MONITOR_CADENCE_MS,
  lastCompletedAt: now - MONITOR_CADENCE_MS + 100,
  lastSlot: 19,
};

describe('scheduled observation timing', () => {
  it('accepts only the current integer slot at both minute boundaries', () => {
    expect(classifyTick(0, 0)).toMatchObject({ accepted: true, status: 'accepted' });
    expect(classifyTick(19, now - 1)).toMatchObject({ accepted: true, status: 'accepted' });
    expect(classifyTick(20, now)).toMatchObject({ accepted: true, status: 'accepted' });
    expect(classifyTick(20, now + MONITOR_CADENCE_MS - 1)).toMatchObject({ accepted: true });
  });

  it('skips delayed minutes instead of assigning a new observation to historical time', () => {
    expect(classifyTick(19, now)).toMatchObject({ accepted: false, status: 'skipped-late' });
    expect(classifyTick(0, now)).toMatchObject({ accepted: false, status: 'skipped-late' });
  });

  it('rejects future and malformed slots without coercion', () => {
    for (const slot of [21, -1, 19.5, NaN, Infinity, -Infinity, '20' as unknown as number])
      expect(classifyTick(slot, now)).toMatchObject({ accepted: false, status: 'invalid' });
    for (const invalidNow of [NaN, Infinity, -Infinity, -1])
      expect(classifyTick(20, invalidNow)).toMatchObject({ accepted: false, status: 'invalid' });
  });
});

describe('monitoring readiness', () => {
  it('starts without a completed scheduled run even when a service sample exists', () => {
    expect(monitoringReadiness({ ...ready, lastCompletedAt: null })).toMatchObject({
      status: 'starting',
      ageMs: null,
    });
  });

  it('accepts freshness exactly at three minutes, then stalls at the next millisecond', () => {
    const boundary = {
      ...ready,
      services: [{ paused: false, lastObservedAt: now - MONITOR_FRESHNESS_MS }],
      lastStartedAt: now - MONITOR_FRESHNESS_MS,
      lastCompletedAt: now - MONITOR_FRESHNESS_MS,
      lastSlot: 17,
    };
    expect(monitoringReadiness(boundary)).toMatchObject({
      status: 'healthy',
      ageMs: MONITOR_FRESHNESS_MS,
    });
    expect(monitoringReadiness({ ...boundary, now: now + 1 })).toMatchObject({
      status: 'stalled',
      ageMs: MONITOR_FRESHNESS_MS + 1,
    });
  });

  it('does not let a fresh service observation conceal a stale scheduler', () => {
    expect(
      monitoringReadiness({
        ...ready,
        services: [{ paused: false, lastObservedAt: now }],
        lastCompletedAt: now - MONITOR_FRESHNESS_MS - 1,
      }),
    ).toMatchObject({ status: 'stalled' });
  });

  it('returns partial for missing, stale, malformed, or future active service evidence', () => {
    for (const lastObservedAt of [null, now - MONITOR_FRESHNESS_MS - 1, -1, NaN, Infinity, now + 1])
      expect(
        monitoringReadiness({
          ...ready,
          services: [...ready.services, { paused: false, lastObservedAt }],
        }),
      ).toMatchObject({ status: 'partial' });
    expect(
      monitoringReadiness({
        ...ready,
        services: [{ paused: false, lastObservedAt: now - MONITOR_FRESHNESS_MS }],
      }),
    ).toMatchObject({ status: 'healthy' });
  });

  it('ignores paused samples, and distinguishes all-paused from no services', () => {
    expect(
      monitoringReadiness({
        ...ready,
        services: [...ready.services, { paused: true, lastObservedAt: null }],
      }),
    ).toMatchObject({ status: 'healthy' });
    const paused = monitoringReadiness({
      ...ready,
      services: [{ paused: true, lastObservedAt: null }],
    });
    expect(paused.status).toBe('healthy');
    expect(paused.reason).toContain('all services are paused');
    expect(monitoringReadiness({ ...ready, services: [] }).reason).toContain('no services');
    expect(
      monitoringReadiness({
        ...ready,
        now: now + MONITOR_FRESHNESS_MS,
        services: [{ paused: true, lastObservedAt: null }],
      }),
    ).toMatchObject({ status: 'stalled' });
  });

  it('rejects impossible scheduler times, slots, and incomplete completion metadata', () => {
    for (const patch of [
      { lastStartedAt: now + 1 },
      { lastCompletedAt: now + 1 },
      { lastCompletedAt: NaN },
      { lastCompletedAt: Infinity },
      { lastCompletedAt: -1 },
      { lastSlot: 21 },
      { lastSlot: -1 },
      { lastSlot: 19.5 },
      { lastStartedAt: null },
      { lastSlot: null },
      { now: NaN },
      { now: -1 },
    ])
      expect(monitoringReadiness({ ...ready, ...patch })).toMatchObject({ status: 'stalled' });
    expect(monitoringReadiness({ ...ready, lastCompletedAt: now + 1 }).ageMs).toBeNull();
  });

  it('allows a newer in-progress run while previous completion and services are fresh', () => {
    expect(monitoringReadiness({ ...ready, lastStartedAt: now, lastSlot: 20 })).toMatchObject({
      status: 'healthy',
    });
  });

  it('dashboard reads let persisted evidence age and cannot make monitoring fresh', () => {
    const evidence = structuredClone(ready);
    const before = structuredClone(evidence);
    expect(monitoringReadiness(evidence).status).toBe('healthy');
    expect(monitoringReadiness({ ...evidence, now: now + MONITOR_FRESHNESS_MS }).status).toBe(
      'stalled',
    );
    expect(evidence).toEqual(before);
    expect(monitoringReadiness(evidence)).toMatchObject({
      lastStartedAt: ready.lastStartedAt,
      lastCompletedAt: ready.lastCompletedAt,
      lastSlot: ready.lastSlot,
    });
  });
});
