import { afterEach, describe, expect, it, vi } from 'vitest';
import origin from '../worker/origin';
import { callOrigin } from '../worker/origin-client';
const binding = (fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  ({ fetch }) as unknown as Pick<Fetcher, 'fetch'>;
afterEach(() => vi.useRealTimers());
describe('private origin Worker and client', () => {
  it('rejects invalid faults rather than waiting an unbounded duration', async () => {
    const result = await origin.fetch(
      new Request('https://origin/catalog', {
        method: 'POST',
        body: JSON.stringify({ delay: 999999, fails: false }),
      }),
    );
    expect(result.status).toBe(400);
  });
  it('returns an actual versioned response via the service binding contract', async () => {
    const result = await callOrigin(
      binding(async (input, init) => origin.fetch(new Request(input, init))),
      20,
      false,
      1000,
    );
    expect(result).toMatchObject({
      ok: true,
      payload: {
        service: 'demo-catalog',
        products: [
          { sku: 'edge-notebook', available: 42 },
          { sku: 'internet-pin', available: 18 },
        ],
      },
    });
    if (result.ok) expect(result.payload.revision).toMatch(/^[\da-f-]{36}$/);
  });
  it('turns non-200 upstream responses into failures', async () => {
    expect(
      await callOrigin(
        binding(async () => new Response('unavailable', { status: 503 })),
        20,
        false,
        100,
      ),
    ).toEqual({ ok: false, reason: 'error' });
  });
  it('validates the upstream payload before caching it', async () => {
    expect(
      await callOrigin(
        binding(async () => Response.json({ unexpected: true })),
        20,
        false,
        100,
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
  });
  it('times out even if an upstream ignores abort, without waiting for a response', async () => {
    vi.useFakeTimers();
    const result = callOrigin(
      binding(() => new Promise(() => {})),
      20,
      false,
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
  });
  it('includes response-body consumption in the timeout budget', async () => {
    vi.useFakeTimers();
    const result = callOrigin(
      binding(async () => new Response(new ReadableStream({ start() {} }))),
      20,
      false,
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
  });
});
