import { describe, expect, it } from 'vitest';
import { initialState } from '../worker/engine';
import {
  LAB_OBSERVER_PROTOCOL,
  LAB_OBSERVER_CAPABILITY_PREFIX,
  MAX_LAB_OBSERVER_FRAME_BYTES,
  captureLabObserverFrame,
  parseLabObserverFrame,
  parseLabObserverProtocols,
} from '../worker/lab-observer';

const capability = '21111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const now = Date.UTC(2026, 9, 1);
const frame = () => ({
  schemaVersion: 1,
  kind: 'snapshot',
  runId,
  revision: 1,
  committedAt: now - 1,
  now,
  expiresAt: now + 60000,
  state: initialState(now, runId),
  events: [
    {
      id: 1,
      at: now - 1,
      latencyMs: 20,
      outcome: 'origin',
      status: 200,
      circuit: 'closed',
      originAttempted: true,
    },
  ],
});

describe('lab observer transport boundary', () => {
  it('accepts only the exact ordered version/capability pair', () => {
    const offered = `${LAB_OBSERVER_PROTOCOL}, ${LAB_OBSERVER_CAPABILITY_PREFIX}${capability}`;
    expect(parseLabObserverProtocols(offered)).toBe(capability);
    for (const invalid of [
      null,
      '',
      LAB_OBSERVER_PROTOCOL,
      `${LAB_OBSERVER_CAPABILITY_PREFIX}${capability}, ${LAB_OBSERVER_PROTOCOL}`,
      `${offered}, another`,
      `${LAB_OBSERVER_PROTOCOL}, ${LAB_OBSERVER_PROTOCOL}`,
      `${LAB_OBSERVER_PROTOCOL}, ${LAB_OBSERVER_CAPABILITY_PREFIX}not-a-uuid`,
      `${LAB_OBSERVER_PROTOCOL}, ${LAB_OBSERVER_CAPABILITY_PREFIX}${runId.replace('-4222-', '-1222-')}`,
      offered + ' '.repeat(128),
    ])
      expect(parseLabObserverProtocols(invalid)).toBeNull();
  });

  it('rebuilds a bounded whitelist without payloads, messages, request IDs or capabilities', () => {
    const raw = frame();
    const value = {
      ...raw,
      capability,
      state: {
        ...raw.state,
        cachedPayload: { private: 'fixture-cache-body' },
        arbitrary: 'fixture-private-state',
        config: { ...raw.state.config, arbitrary: 'fixture-private-config' },
      },
      events: raw.events.map((event) => ({
        ...event,
        message: 'fixture-private-message',
        requestId: capability,
        payload: { private: 'fixture-event-body' },
      })),
    };
    const parsed = parseLabObserverFrame(JSON.stringify(value));
    expect(parsed).not.toBeNull();
    const serialized = JSON.stringify(parsed);
    for (const privateValue of [capability, 'fixture-', 'cachedPayload', 'requestId', 'message'])
      expect(serialized).not.toContain(privateValue);
    expect(value.state.cachedPayload).toEqual({ private: 'fixture-cache-body' });
  });

  it('permits legacy unknown commit metadata only in a snapshot', () => {
    const legacy = { ...frame(), revision: 0, committedAt: null };
    expect(parseLabObserverFrame(legacy)).toMatchObject({ revision: 0, committedAt: null });
    expect(parseLabObserverFrame({ ...legacy, kind: 'update' })).toBeNull();
    expect(parseLabObserverFrame({ ...frame(), revision: 0 })).toBeNull();
    expect(parseLabObserverFrame({ ...frame(), committedAt: null })).toBeNull();
  });

  it('captures only absent legacy metadata and rejects malformed or partial stored pairs', () => {
    const legacy = initialState(now, runId);
    expect(captureLabObserverFrame(legacy, 'snapshot', [], now, now + 60000)).toMatchObject({
      revision: 0,
      committedAt: null,
    });
    expect(() => captureLabObserverFrame(legacy, 'update', [], now, now + 60000)).toThrow();
    for (const metadata of [
      { revision: -1, committedAt: 'invalid' },
      { revision: 'invalid', committedAt: null },
      { revision: 1 },
      { committedAt: now },
      { revision: 1, committedAt: now + 1 },
    ]) {
      const source = { ...legacy, ...metadata } as unknown as typeof legacy;
      expect(() => captureLabObserverFrame(source, 'snapshot', [], now, now + 60000)).toThrow();
    }
  });

  it('accepts pending admissions while rejecting impossible aggregate counters', () => {
    const pending = frame();
    pending.state.total = 2;
    pending.state.originCalls = 2;
    expect(parseLabObserverFrame(pending)).not.toBeNull();
    pending.state.counts.origin = 3;
    expect(parseLabObserverFrame(pending)).toBeNull();
    pending.state.counts.origin = 0;
    pending.state.originCalls = 3;
    expect(parseLabObserverFrame(pending)).toBeNull();
  });

  it('rejects unrenderable, future committed and expired timestamps', () => {
    for (const key of ['now', 'expiresAt', 'committedAt'] as const) {
      expect(parseLabObserverFrame({ ...frame(), [key]: 8_640_000_000_000_001 })).toBeNull();
      expect(parseLabObserverFrame({ ...frame(), [key]: -1 })).toBeNull();
    }
    expect(parseLabObserverFrame({ ...frame(), committedAt: now + 1 })).toBeNull();
    expect(parseLabObserverFrame({ ...frame(), expiresAt: now })).toBeNull();
    expect(
      parseLabObserverFrame({ ...frame(), events: [{ ...frame().events[0], at: now + 1 }] }),
    ).toBeNull();
  });

  it('bounds snapshot/update evidence and encoded transport bytes', () => {
    const event = frame().events[0];
    expect(
      parseLabObserverFrame({ ...frame(), events: Array.from({ length: 13 }, () => event) }),
    ).toBeNull();
    expect(
      parseLabObserverFrame({ ...frame(), kind: 'update', events: [event, event] }),
    ).toBeNull();
    expect(parseLabObserverFrame({ ...frame(), events: [event, event] })).toBeNull();
    for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1])
      expect(parseLabObserverFrame({ ...frame(), events: [{ ...event, id }] })).toBeNull();
    expect(parseLabObserverFrame('x'.repeat(MAX_LAB_OBSERVER_FRAME_BYTES + 1))).toBeNull();
    expect(parseLabObserverFrame(new ArrayBuffer(8))).toBeNull();
    expect(parseLabObserverFrame('{invalid-json')).toBeNull();
  });

  it('returns sanitized terminal frames with matching reasons only', () => {
    expect(
      parseLabObserverFrame({
        schemaVersion: 1,
        kind: 'unavailable',
        reason: 'lab-unavailable',
        now,
        privateError: 'fixture-private-error',
      }),
    ).toEqual({ schemaVersion: 1, kind: 'unavailable', reason: 'lab-unavailable', now });
    expect(
      parseLabObserverFrame({ schemaVersion: 1, kind: 'expired', reason: 'lab-unavailable', now }),
    ).toBeNull();
  });
});
