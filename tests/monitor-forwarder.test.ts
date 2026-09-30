import { describe, expect, it } from 'vitest';
import { createMonitorForwarder, monitorFailureReason } from '../worker/monitor-forwarder';

describe('monitor failure boundary', () => {
  it('reports quota exhaustion with a bounded cooldown and retries after it', async () => {
    let now = Date.UTC(2026, 8, 30, 23, 59, 30);
    let calls = 0;
    const stub = {
      async fetch() {
        calls++;
        if (calls === 1)
          throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
        return Response.json({ now: 42, monitoring: { status: 'healthy' } });
      },
    } as unknown as Pick<Fetcher, 'fetch'>;
    const forward = createMonitorForwarder(() => now);
    const request = new Request('https://monitor.internal/status');
    const failed = await forward(stub, request);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('Cache-Control')).toBe('no-store');
    expect(failed.headers.get('Retry-After')).toBe('60');
    expect(failed.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await failed.json()).toEqual({
      error:
        'Monitoring storage is temporarily unavailable. Current monitoring cannot be confirmed.',
      code: 'monitor-storage-unavailable',
      reason: 'daily-read-limit',
      retryAtUTC: '2026-10-01T00:00:00.000Z',
    });
    now += 59999;
    expect((await forward(stub, request)).status).toBe(503);
    expect(calls).toBe(1);
    now++;
    expect(await (await forward(stub, request)).json()).toEqual({
      now: 42,
      monitoring: { status: 'healthy' },
    });
    expect(calls).toBe(2);
  });

  it('does not turn a private exception into public detail or falsely identify a quota', async () => {
    const stub = {
      async fetch() {
        throw new Error('https://secret.internal/target operator-private-note');
      },
    } as unknown as Pick<Fetcher, 'fetch'>;
    const response = await createMonitorForwarder(() => 123)(
      stub,
      new Request('https://monitor.internal/audit'),
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('secret.internal');
    expect(text).not.toContain('operator-private-note');
    expect(JSON.parse(text)).toMatchObject({ reason: 'storage-unavailable', retryAtUTC: null });
    expect(
      monitorFailureReason(
        new Error('Exceeded allowed rows written in Durable Objects free tier.'),
      ),
    ).toBe('daily-write-limit');
    expect(monitorFailureReason('Exceeded allowed rows read in Durable Objects free tier.')).toBe(
      'storage-unavailable',
    );
  });

  it('preserves structured application failures and successful evidence without renewing it', async () => {
    const providerFailure = Response.json(
      { error: 'AI capacity unavailable', brief: { state: 'failed' } },
      { status: 503 },
    );
    const structuredStub = { fetch: async () => providerFailure } as unknown as Pick<
      Fetcher,
      'fetch'
    >;
    const forward = createMonitorForwarder(() => 100000);
    const request = new Request('https://monitor.internal/incident-brief', { method: 'POST' });
    expect(await forward(structuredStub, request)).toBe(providerFailure);
    const success = Response.json({ now: 7, latest: { observedAt: 3 } });
    expect(
      await forward({ fetch: async () => success } as unknown as Pick<Fetcher, 'fetch'>, request),
    ).toBe(success);
    const htmlFailure = await forward(
      {
        fetch: async () => new Response('<html>private runtime error</html>', { status: 500 }),
      } as unknown as Pick<Fetcher, 'fetch'>,
      request,
    );
    expect(htmlFailure.status).toBe(503);
    expect(await htmlFailure.text()).not.toContain('private runtime error');
  });
});
