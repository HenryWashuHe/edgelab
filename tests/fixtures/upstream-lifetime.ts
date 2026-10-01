import { probe } from '../../worker/monitor-probe';
import { callOrigin } from '../../worker/origin-client';
import { defaultPolicy } from '../../worker/monitor-domain';

const scenarios = [
  'healthy',
  'exact-limit',
  'split-utf8',
  'oversize',
  'invalid-json',
  'missing-body',
  'network-error',
  'status-cancel-pending',
  'status-cancel-rejected',
  'body-timeout',
  'body-timeout-cancel-pending',
  'body-timeout-cancel-rejected',
  'late-response',
  'empty-stream',
] as const;
type Scenario = (typeof scenarios)[number];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();

/** Test-only adapters deliberately ignore fetch abort. Streams run inside workerd. */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subject = url.searchParams.get('subject');
    const scenario = url.searchParams.get('scenario') as Scenario;
    if (
      request.method !== 'GET' ||
      url.pathname !== '/check' ||
      !['monitor', 'lab'].includes(subject ?? '') ||
      !scenarios.includes(scenario)
    )
      return new Response(null, { status: 400 });

    const catalog = {
      service: 'demo-catalog',
      revision: scenario === 'split-utf8' ? 'π' : '',
      generatedAt: 1,
      products: [
        { sku: 'edge-notebook', available: 42 },
        { sku: 'internet-pin', available: 18 },
      ],
    };
    const json =
      subject === 'lab' ? catalog : { ok: true, padding: scenario === 'split-utf8' ? 'π' : '' };
    if (scenario === 'exact-limit' || scenario === 'oversize') {
      const maximum = 16384 + (scenario === 'oversize' ? 1 : 0);
      const padding = 'x'.repeat(maximum - encoder.encode(JSON.stringify(json)).byteLength);
      if ('padding' in json) json.padding = padding;
      else json.revision = padding;
    }
    const bytes = encoder.encode(scenario === 'invalid-json' ? 'invalid' : JSON.stringify(json));
    const stalled = scenario.startsWith('body-timeout') || scenario === 'late-response';
    let requests = 0;
    let pulls = 0;
    let cancelCalls = 0;
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    let signal: AbortSignal | undefined;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          source = controller;
        },
        pull(controller) {
          pulls++;
          if (scenario === 'empty-stream') {
            controller.enqueue(new Uint8Array());
            return;
          }
          if (offset < bytes.byteLength) {
            const length = scenario === 'split-utf8' ? 1 : 1024;
            const end = Math.min(bytes.byteLength, offset + length);
            controller.enqueue(bytes.slice(offset, end));
            offset = end;
          } else if (!stalled && !scenario.startsWith('status-cancel')) controller.close();
        },
        cancel() {
          cancelCalls++;
          if (scenario.endsWith('cancel-pending')) return new Promise<void>(() => {});
          if (scenario.endsWith('cancel-rejected'))
            return Promise.reject(new Error('private-fixture-provider-error'));
        },
      },
      { highWaterMark: 0 },
    );
    const timeoutMs =
      stalled || scenario === 'empty-stream' || scenario.startsWith('status-cancel') ? 40 : 500;
    const origin = {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        requests++;
        signal = input instanceof Request ? input.signal : (init?.signal ?? undefined);
        if (scenario === 'network-error') throw new Error('private-fixture-network-error');
        if (scenario === 'late-response') await wait(80);
        return new Response(scenario === 'missing-body' ? null : stream, {
          status: scenario.startsWith('status-cancel') ? 503 : 200,
        });
      },
    } as unknown as Pick<Fetcher, 'fetch'>;
    const started = Date.now();
    const result =
      subject === 'monitor'
        ? await probe(
            {
              id: 'fixture',
              name: 'Fixture',
              url: 'https://origin.internal/health',
              transport: 'origin',
              assertion: 'ok-json',
            },
            { ...defaultPolicy, timeoutMs, latencyObjectiveMs: timeoutMs },
            origin,
          )
        : await callOrigin(origin, 20, false, timeoutMs);
    const elapsedMs = Date.now() - started;
    // Observe late fetch completion and pending-read cleanup before harness disposal.
    await wait(scenario === 'late-response' ? 140 : 40);
    const measured = {
      subject,
      scenario,
      outcome: 'outcome' in result ? result.outcome : result.ok ? 'good' : result.reason,
      status: 'status' in result ? result.status : null,
      timeoutMs,
      elapsedMs,
      requests,
      pulls,
      deliveredBytes: offset,
      sourceBytes: bytes.byteLength,
      cancelCalls,
      bodyLockedAfterObservation: stream.locked,
      signalAbortedAfterObservation: signal?.aborted ?? false,
    };
    // Baseline readers can be orphaned. Close only after recording the failing state.
    try {
      source?.close();
    } catch {
      // Already closed/canceled by the tested client.
    }
    return Response.json(measured);
  },
} satisfies ExportedHandler;
