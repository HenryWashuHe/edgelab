import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  defaultPolicy,
  initialMonitorState,
  transition,
  validatePolicy,
  parseTargets,
  windowBounds,
} from '../worker/monitor-domain';
import { probe } from '../worker/monitor-probe';
const target = {
  id: 'health',
  name: 'Health',
  transport: 'origin' as const,
  url: 'https://origin.internal/health',
  assertion: 'ok-json' as const,
};
const binding = (fetch: () => Promise<Response>) => ({ fetch }) as unknown as Fetcher;
afterEach(() => vi.useRealTimers());
describe('monitoring incident state machine', () => {
  it('opens once after three consecutive failures and resolves after two successes', () => {
    let state = initialMonitorState();
    for (let slot = 1; slot <= 3; slot++) {
      const next = transition(state, false, slot, defaultPolicy);
      expect(next.change).toBe(slot === 3 ? 'open' : 'none');
      state = next.state;
    }
    state.incidentId = 'incident';
    const failed = transition(state, false, 4, defaultPolicy);
    expect(failed.change).toBe('none');
    const one = transition(failed.state, true, 5, defaultPolicy);
    expect(one.change).toBe('none');
    expect(transition(one.state, true, 6, defaultPolicy).change).toBe('resolve');
  });
  it('duplicate and out-of-order samples cannot advance a streak', () => {
    const state = transition(initialMonitorState(), false, 20, defaultPolicy).state;
    expect(transition(state, false, 20, defaultPolicy).state).toEqual(state);
    expect(transition(state, true, 19, defaultPolicy).state).toEqual(state);
  });
  it('a gap resets streaks, but does not silently close an incident', () => {
    const state = { failures: 2, successes: 0, lastSlot: 1, incidentId: null };
    expect(transition(state, false, 3, defaultPolicy)).toMatchObject({
      change: 'none',
      state: { failures: 1 },
    });
    expect(
      transition({ ...state, incidentId: 'open', successes: 1 }, true, 3, defaultPolicy),
    ).toMatchObject({ change: 'none', state: { incidentId: 'open', successes: 1 } });
  });
  it('excludes the incomplete minute and time before enrollment from reports', () => {
    expect(windowBounds(90_000, 240_001, 1440)).toEqual({ start: 2, end: 3, expected: 2 });
    expect(windowBounds(90_000, 100_000, 1440).expected).toBe(0);
    expect(windowBounds(0, 10000 * 60_000, 60).expected).toBe(60);
  });
  it('validates complete policies and rejects unknown fields and coercion', () => {
    for (const patch of [
      null,
      [],
      { timeoutMs: '1000' },
      { paused: 1 },
      { extra: 1 },
      { availabilityTarget: 100 },
      { latencyObjectiveMs: 4000 },
      { failureThreshold: 1.5 },
    ])
      expect(() => validatePolicy(patch, defaultPolicy)).toThrow();
    expect(
      validatePolicy({ paused: true, timeoutMs: 200, latencyObjectiveMs: 150 }, defaultPolicy),
    ).toMatchObject({ paused: true, timeoutMs: 200 });
  });
  it('accepts only bounded deploy-time target definitions', () => {
    expect(parseTargets(JSON.stringify([target]))).toEqual([target]);
    for (const patch of [
      { url: 'http://example.com' },
      { url: 'https://a:b@example.com' },
      { transport: 'https', url: 'https://127.0.0.1/' },
      { transport: 'https', url: 'https://localhost/' },
      { url: 'https://origin.internal/x?token=secret' },
      { id: 'Bad ID' },
      { transport: 'arbitrary' },
    ])
      expect(() => parseTargets(JSON.stringify([{ ...target, ...patch }]))).toThrow();
    expect(() => parseTargets(JSON.stringify([target, target]))).toThrow();
  });
});
describe('bounded monitor probes', () => {
  it('requires the advertised JSON contract', async () => {
    expect(
      await probe(
        target,
        defaultPolicy,
        binding(async () => Response.json({ ok: true })),
      ),
    ).toMatchObject({ outcome: 'good', status: 200 });
    expect(
      await probe(
        target,
        defaultPolicy,
        binding(async () => Response.json({ ok: false })),
      ),
    ).toMatchObject({ outcome: 'invalid-body' });
    expect(
      await probe(
        target,
        defaultPolicy,
        binding(async () => new Response('invalid')),
      ),
    ).toMatchObject({ outcome: 'invalid-body' });
  });
  it('does not follow redirects or credit non-200 responses', async () => {
    let redirect = '';
    const mock = {
      fetch: async (r: Request) => {
        redirect = r.redirect;
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1' } });
      },
    } as unknown as Fetcher;
    expect(await probe(target, defaultPolicy, mock)).toMatchObject({
      outcome: 'http-error',
      status: 302,
    });
    expect(redirect).toBe('manual');
  });
  it('rejects oversized bodies and network errors without leaking response content', async () => {
    expect(
      await probe(
        target,
        defaultPolicy,
        binding(async () => new Response('x'.repeat(16385))),
      ),
    ).toMatchObject({ outcome: 'invalid-body' });
    const result = await probe(
      target,
      defaultPolicy,
      binding(async () => {
        throw new Error('private credential');
      }),
    );
    expect(result.outcome).toBe('network-error');
    expect(JSON.stringify(result)).not.toContain('credential');
  });
  it('times out a response that never arrives and a response body that never finishes', async () => {
    vi.useFakeTimers();
    const policy = { ...defaultPolicy, timeoutMs: 100 };
    const absent = probe(
      target,
      policy,
      binding(() => new Promise(() => {})),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await absent).outcome).toBe('timeout');
    const stream = probe(
      target,
      policy,
      binding(async () => new Response(new ReadableStream({ start() {} }))),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await stream).outcome).toBe('timeout');
  });
  it('counts a correct but slow response against the latency objective', async () => {
    vi.useFakeTimers();
    const result = probe(
      target,
      { ...defaultPolicy, latencyObjectiveMs: 50 },
      binding(
        () => new Promise((resolve) => setTimeout(() => resolve(Response.json({ ok: true })), 100)),
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).outcome).toBe('slow');
  });
});
