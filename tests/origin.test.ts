import { afterEach, describe, expect, it, vi } from 'vitest';
import origin from '../worker/origin';
import { callOrigin } from '../worker/origin-client';
import { MAX_UPSTREAM_JSON_BYTES } from '../worker/bounded-json';
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
  it('turns unsuccessful upstream HTTP responses into failures', async () => {
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
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
        return new Promise<void>(() => {});
      },
    });
    const result = callOrigin(
      binding(async () => new Response(body)),
      20,
      false,
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });
  it('preserves HTTP errors even when their cleanup never finishes', async () => {
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
        return new Promise<void>(() => {});
      },
    });
    expect(
      await callOrigin(
        binding(async () => new Response(body, { status: 503 })),
        20,
        false,
        100,
      ),
    ).toEqual({ ok: false, reason: 'error' });
    expect(canceled).toBe(1);
  });
  it('accepts successful 2xx catalog JSON at the byte cap and rejects one byte more', async () => {
    const catalog = {
      service: 'demo-catalog',
      revision: '',
      generatedAt: 0,
      products: [
        { sku: 'edge-notebook', available: 42 },
        { sku: 'internet-pin', available: 18 },
      ],
    };
    const baseBytes = new TextEncoder().encode(JSON.stringify(catalog)).length;
    const exact = { ...catalog, revision: 'x'.repeat(MAX_UPSTREAM_JSON_BYTES - baseBytes) };
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(MAX_UPSTREAM_JSON_BYTES);
    const valid = await callOrigin(
      binding(async () => Response.json(exact, { status: 201 })),
      20,
      false,
      100,
    );
    expect(valid).toEqual({ ok: true, payload: exact });
    expect(
      await callOrigin(
        binding(async () => Response.json({ ...exact, revision: exact.revision + 'x' })),
        20,
        false,
        100,
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
  });
  it('discards a valid catalog arriving after timeout without consuming it', async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const result = callOrigin(
      binding(() => new Promise((resolve) => (deliver = resolve))),
      20,
      false,
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
    const response = Response.json({
      service: 'demo-catalog',
      revision: 'late',
      generatedAt: 0,
      products: [
        { sku: 'a', available: 1 },
        { sku: 'b', available: 2 },
      ],
    });
    const reader = vi.spyOn(response.body!, 'getReader');
    const cancel = vi.spyOn(response.body!, 'cancel');
    deliver(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(reader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(await result).toEqual({ ok: false, reason: 'timeout' });
  });
});
