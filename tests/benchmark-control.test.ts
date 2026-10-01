import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the exact plain-Node helper, without importing/executing the CLI or
// adding TS loading requirements to benchmark.mjs. No HTTP calls or files occur.
const helperURL = new URL('../scripts/benchmark-control.mjs', import.meta.url).href;
const {
  readBenchmarkResponse,
  settleBenchmarkRequests,
  measureBenchmarkTrial,
  collectBenchmarkSamples,
} = await import(helperURL);

const firstId = '21111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const privateCanary = 'private-provider-body-must-not-be-echoed';
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No HTTP benchmark may run in unit tests');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());

function decision(outcome = 'origin', status = 200, requestId = firstId) {
  return Response.json(
    { outcome, status, requestId },
    {
      status,
      headers: { 'X-Request-ID': requestId, 'X-Response-Source': outcome },
    },
  );
}
function gate(status = 429) {
  return Response.json(
    {
      code: status === 429 ? 'lab-admission-limited' : 'lab-admission-unavailable',
      error: privateCanary,
      retryAfterSeconds: 60,
    },
    { status },
  );
}
function source(overrides: Record<string, unknown> = {}) {
  return Response.json({
    state: {
      total: 2,
      originCalls: 1,
      counts: { origin: 1, limited: 1, stale: 0, blocked: 0, error: 0 },
    },
    events: [
      { outcome: 'origin', status: 200, requestId: firstId },
      { outcome: 'limited', status: 429, requestId: secondId },
    ],
    ...overrides,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe('benchmark protocol and pre-object admission failures', () => {
  it.each(['config', 'request', 'state'])(
    'aborts %s on both sanitized admission statuses without provider copy',
    async (path) => {
      for (const status of [429, 503]) {
        try {
          await readBenchmarkResponse(gate(status), path);
          throw new Error('Expected gate refusal');
        } catch (error) {
          expect((error as Error).message).toContain('gateway admission refused');
          expect((error as Error).message).not.toContain(privateCanary);
          expect((error as Error).message).toContain('Requests are not replayed');
        }
      }
    },
  );

  it('prioritizes admission codes over misleading engine fields or HTTP 200', async () => {
    const body = {
      code: 'lab-admission-limited',
      error: privateCanary,
      retryAfterSeconds: 60,
      outcome: 'origin',
      status: 200,
      requestId: firstId,
    };
    await expect(readBenchmarkResponse(Response.json(body), 'request')).rejects.toThrow(
      'unconfirmed gateway admission',
    );
  });

  it.each([
    ['origin', 200],
    ['stale', 200],
    ['limited', 429],
    ['blocked', 503],
    ['error', 502],
    ['error', 504],
  ])('recognizes genuine protocol decision %s/%i', async (outcome, status) => {
    expect(
      await readBenchmarkResponse(decision(String(outcome), Number(status)), 'request'),
    ).toEqual({ outcome, status, requestId: firstId });
  });

  it('rejects bare 429, unknown/mismatched outcomes, wrong UUIDs and disagreeing headers', async () => {
    for (const response of [
      Response.json({ error: privateCanary }, { status: 429 }),
      decision('limited', 200),
      decision('invented', 200),
      decision('origin', 200, 'not-a-uuid'),
      Response.json({ outcome: 'origin', status: 200, requestId: firstId }),
      Response.json({ outcome: 'origin', status: 429, requestId: firstId }),
    ])
      await expect(readBenchmarkResponse(response, 'request')).rejects.toThrow('Benchmark stopped');
  });

  it('sanitizes malformed JSON and requires confirmed config and settled state', async () => {
    await expect(readBenchmarkResponse(new Response(privateCanary), 'config')).rejects.toThrow(
      'invalid JSON',
    );
    await expect(readBenchmarkResponse(Response.json({ ok: false }), 'config')).rejects.toThrow(
      'configuration was not confirmed',
    );
    await expect(
      readBenchmarkResponse(Response.json({ ok: true }, { status: 202 }), 'config'),
    ).rejects.toThrow('configuration was not confirmed');
    await expect(
      readBenchmarkResponse(source({ state: { total: 2, originCalls: 3, counts: {} } }), 'state'),
    ).rejects.toThrow('state counters');
    await expect(
      readBenchmarkResponse(
        source({
          state: {
            total: 2,
            originCalls: 1,
            counts: { origin: 1, limited: 0, stale: 0, blocked: 0, error: 0 },
          },
        }),
        'state',
      ),
    ).rejects.toThrow('fully settled');
  });
});

describe('benchmark batch completion and complete-only samples', () => {
  it.each(['resolve', 'reject'])(
    'waits for held sibling %s after admission refusal before exiting, with no state read/replay',
    async (settlement) => {
      const held = deferred<Response>();
      const calls: string[] = [];
      let requestIndex = 0;
      const call = async (path: string) => {
        calls.push(path);
        if (path === 'config') return Response.json({ ok: true });
        if (path === 'request') return requestIndex++ === 0 ? gate() : held.promise;
        throw new Error('State must not be read for an incomplete trial');
      };
      let exited = false;
      let failure: unknown;
      const completion = measureBenchmarkTrial(call, 2, () => 0).then(
        () => {
          exited = true;
        },
        (error: unknown) => {
          exited = true;
          failure = error;
        },
      );
      await flush();
      expect(calls).toEqual(['config', 'request', 'request']);
      expect(exited).toBe(false);
      if (settlement === 'resolve') held.resolve(decision('origin', 200, secondId));
      else held.reject(new Error('Later transport failure'));
      await completion;
      expect(exited).toBe(true);
      expect((failure as Error).message).toContain('gateway admission refused');
      expect(calls).toEqual(['config', 'request', 'request']);
    },
  );

  it('preserves first observed failure while waiting for every dispatched body/transport task', async () => {
    const earlier = deferred<number>();
    const later = deferred<number>();
    const held = deferred<number>();
    const firstFailure = new Error('First observed parse failure');
    let completed = false;
    let failure;
    const result = settleBenchmarkRequests([earlier.promise, later.promise, held.promise]).catch(
      (error: unknown) => {
        completed = true;
        failure = error;
      },
    );
    later.reject(firstFailure);
    await flush();
    expect(completed).toBe(false);
    earlier.reject(new Error('Later failure'));
    await flush();
    expect(completed).toBe(false);
    held.resolve(3);
    await result;
    expect(failure).toBe(firstFailure);
  });

  it('reconciles engine outcomes, source counters and request history into a complete sample', async () => {
    let requestIndex = 0;
    const call = async (path: string) =>
      path === 'config'
        ? Response.json({ ok: true })
        : path === 'state'
          ? source()
          : requestIndex++ === 0
            ? decision()
            : decision('limited', 429, secondId);
    expect(await measureBenchmarkTrial(call, 2, () => 0)).toEqual({
      accepted: 1,
      limited: 1,
      wallMs: 0,
      clientP50Ms: 0,
      clientP95Ms: 0,
      originCalls: 1,
    });
  });

  it('rejects mismatched source counters or missing/duplicate history rather than returning a sample', async () => {
    for (const state of [
      source({
        state: {
          total: 2,
          originCalls: 2,
          counts: { origin: 2, limited: 0, stale: 0, blocked: 0, error: 0 },
        },
      }),
      source({ events: [{ outcome: 'origin', status: 200, requestId: firstId }] }),
      source({
        events: [
          { outcome: 'origin', status: 200, requestId: firstId },
          { outcome: 'origin', status: 200, requestId: firstId },
        ],
      }),
      gate(503),
    ]) {
      let requestIndex = 0;
      const call = async (path: string) =>
        path === 'config'
          ? Response.json({ ok: true })
          : path === 'state'
            ? state
            : requestIndex++ === 0
              ? decision()
              : decision('limited', 429, secondId);
      await expect(measureBenchmarkTrial(call, 2, () => 0)).rejects.toThrow('Benchmark stopped');
    }
  });

  it('does not count stale/blocked/error responses as successful healthy-trial origin calls', async () => {
    let stateReads = 0;
    const call = async (path: string) => {
      if (path === 'config') return Response.json({ ok: true });
      if (path === 'state') {
        stateReads++;
        return source();
      }
      return decision('stale', 200);
    };
    await expect(measureBenchmarkTrial(call, 1, () => 0)).rejects.toThrow(
      'unexpected engine decision',
    );
    expect(stateReads).toBe(0);
  });

  it('returns no partial collection or successful artifact after a later trial config is refused', async () => {
    let trials = 0;
    let dispatches = 0;
    let successfulReportWrites = 0;
    const createCall = () => {
      const trial = trials++;
      return async (path: string) => {
        dispatches++;
        if (trial > 0) return gate(503);
        if (path === 'config') return Response.json({ ok: true });
        if (path === 'request') return decision();
        return source({
          state: {
            total: 1,
            originCalls: 1,
            counts: { origin: 1, limited: 0, stale: 0, blocked: 0, error: 0 },
          },
          events: [{ outcome: 'origin', status: 200, requestId: firstId }],
        });
      };
    };
    await expect(
      collectBenchmarkSamples(1, createCall).then(() => successfulReportWrites++),
    ).rejects.toThrow('gateway admission refused');
    expect(trials).toBe(2);
    expect(dispatches).toBe(4);
    expect(successfulReportWrites).toBe(0);
  });
});
