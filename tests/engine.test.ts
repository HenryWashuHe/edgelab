import { describe, it, expect } from 'vitest';
import { initialState, admit, complete, refill, validateConfig } from '../worker/engine';
const state = () => initialState(1000, 'run-a');
function permit(s: ReturnType<typeof state>, now: number) {
  const p = admit(s, now);
  if ('outcome' in p) throw new Error(`Expected permit, got ${p.outcome}`);
  return p;
}
describe('coordinated token bucket', () => {
  it('admits exactly the burst budget under same-time concurrency', () => {
    const s = state();
    const results = Array.from({ length: 100 }, () => admit(s, 1000));
    expect(results.filter((r) => !('outcome' in r))).toHaveLength(12);
    expect(s.counts.limited).toBe(88);
    expect(s.originCalls).toBe(12);
    expect(s.tokens).toBe(0);
  });
  it('refills fractionally, never exceeds capacity, and ignores backward time', () => {
    const s = state();
    s.tokens = 0;
    refill(s, 1125);
    expect(s.tokens).toBe(0.5);
    refill(s, 1000);
    expect(s.tokens).toBe(0.5);
    expect(s.updatedAt).toBe(1125);
    refill(s, 100000);
    expect(s.tokens).toBe(12);
  });
  it('includes a bounded positive retry delay', () => {
    const s = state();
    s.tokens = 0;
    expect(admit(s, 1000)).toMatchObject({ status: 429, retryAfter: 1 });
  });
});
describe('circuit breaker and cache', () => {
  function trip(s = state()) {
    s.config.originMode = 'failing';
    for (let i = 0; i < 3; i++) complete(s, permit(s, 1000), 1100);
    expect(s.circuit).toBe('open');
    return s;
  }
  it('opens at the threshold and bypasses origin during cooldown', () => {
    const s = trip();
    expect(admit(s, 2000)).toMatchObject({ outcome: 'blocked', status: 503, retryAfter: 4 });
    expect(s.originCalls).toBe(3);
  });
  it('allows exactly one probe, then closes on success', () => {
    const s = trip();
    s.config.originMode = 'healthy';
    const probe = permit(s, 5100);
    expect(probe.probe).toBe(true);
    expect(s.circuit).toBe('half-open');
    expect(admit(s, 5100)).toMatchObject({ outcome: 'blocked' });
    complete(s, probe, 5200);
    expect(s.circuit).toBe('closed');
    expect(s.failures).toBe(0);
  });
  it('reopens on failed recovery probe', () => {
    const s = trip();
    complete(s, permit(s, 5100), 5200);
    expect(s.circuit).toBe('open');
    expect(s.openedAt).toBe(5200);
  });
  it('uses cached success on error and on circuit bypass', () => {
    const s = state();
    complete(s, permit(s, 1000), 1050);
    trip(s);
    expect(s.counts.stale).toBe(3);
    expect(admit(s, 2000)).toMatchObject({ outcome: 'stale', status: 200 });
  });
  it('never serves cached data older than 60 seconds', () => {
    const s = state();
    s.cachedAt = 0;
    s.config.originMode = 'failing';
    expect(complete(s, permit(s, 61000), 61200)).toMatchObject({ outcome: 'error', status: 502 });
  });
  it('supports disabling fallback even with a populated cache', () => {
    const s = state();
    s.cachedAt = 1000;
    s.config.staleFallback = false;
    trip(s);
    expect(admit(s, 2000)).toMatchObject({ outcome: 'blocked', status: 503 });
  });
  it('does not let an old success close a newly opened circuit', () => {
    const s = state();
    const olderSuccess = permit(s, 1000);
    trip(s);
    complete(s, olderSuccess, 2000);
    expect(s.circuit).toBe('open');
    expect(s.cachedAt).toBeNull();
  });
  it('fences in-flight completions after reset', () => {
    const s = state();
    const old = permit(s, 1000);
    const fresh = initialState(2000, 'run-b');
    expect(complete(fresh, old, 2200)).toBeNull();
    expect(fresh.total).toBe(0);
  });
  it('recovers an interrupted probe after its persisted lease expires', () => {
    const s = trip();
    const old = permit(s, 5100);
    const next = permit(s, 15100);
    expect(next.probe).toBe(true);
    expect(next.generation).toBeGreaterThan(old.generation);
    complete(s, { ...old, fails: false }, 15200);
    expect(s.circuit).toBe('half-open');
  });
  it('state survives serialization between admission and completion', () => {
    const s = state();
    const p = permit(s, 1000);
    const restored = JSON.parse(JSON.stringify(s));
    complete(restored, p, 1200);
    expect(restored.counts.origin).toBe(1);
    expect(restored.tokens).toBe(11);
  });
});
describe('configuration validation', () => {
  it.each([
    { capacity: 0 },
    { refillPerSecond: 1.2 },
    { cooldownMs: 999999 },
    { originMode: 'unknown' },
    { originMode: ['healthy'] },
    { originMode: { toString: () => 'healthy' } },
    { staleFallback: 'yes' },
    { evil: true },
    null,
    [],
    JSON.parse('{"__proto__":{}}'),
  ])('rejects invalid configuration %j', (value) => {
    expect(() => validateConfig(value, state().config)).toThrow();
  });
  it('merges valid bounded settings without changing other fields', () => {
    const previous = state().config;
    const next = validateConfig({ capacity: 20, originMode: 'flaky' }, previous);
    expect(next.capacity).toBe(20);
    expect(next.originMode).toBe('flaky');
    expect(previous.capacity).toBe(12);
  });
});
