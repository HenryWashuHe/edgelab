import gateway from '../../worker/index';
export { ReliabilityLab, MonitorStore } from '../../worker/index';

type GatewayEnv = Parameters<typeof gateway.fetch>[1];
type FixtureEnv = GatewayEnv & { HOLD: Fetcher };
const encoder = new TextEncoder();
const capability = '00000000-0000-4000-8000-000000000001';
const incident = '00000000-0000-4000-8000-000000000002';
const metrics = {
  labNames: 0,
  labGets: 0,
  labFetches: 0,
  monitorNames: 0,
  monitorGets: 0,
  monitorFetches: 0,
  ownerAdmission: 0,
  observerAdmission: 0,
  cancelCalls: 0,
  cancelCompleted: 0,
  lateSupplyAttempts: 0,
  lateSupplyRejected: 0,
};

/** Count delegation without replacing native namespaces, stubs or admission results. */
function tracked(env: FixtureEnv): GatewayEnv {
  const namespace = (
    source: GatewayEnv['LABS'] | GatewayEnv['MONITORS'],
    kind: 'lab' | 'monitor',
  ) => ({
    idFromName(name: string) {
      metrics[kind === 'lab' ? 'labNames' : 'monitorNames']++;
      return source.idFromName(name);
    },
    get(id: DurableObjectId) {
      metrics[kind === 'lab' ? 'labGets' : 'monitorGets']++;
      const stub = source.get(id);
      return {
        fetch(...args: Parameters<typeof stub.fetch>) {
          metrics[kind === 'lab' ? 'labFetches' : 'monitorFetches']++;
          return stub.fetch(...args);
        },
      };
    },
  });
  const limiter = (binding: unknown, lane: 'owner' | 'observer') => ({
    async limit(options: { key: string }) {
      metrics[lane === 'owner' ? 'ownerAdmission' : 'observerAdmission']++;
      const native = binding as { limit(options: { key: string }): Promise<unknown> };
      return native.limit(options);
    },
  });
  return {
    ...env,
    LABS: namespace(env.LABS, 'lab') as GatewayEnv['LABS'],
    MONITORS: namespace(env.MONITORS, 'monitor') as GatewayEnv['MONITORS'],
    LAB_OWNER_LIMITER: limiter(env.LAB_OWNER_LIMITER, 'owner'),
    LAB_OBSERVER_LIMITER: limiter(env.LAB_OBSERVER_LIMITER, 'observer'),
  };
}

export default {
  async fetch(request: Request, env: FixtureEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__fixture/metrics') return Response.json({ ...metrics });
    if (url.pathname !== '/__fixture/body') return gateway.fetch(request, tracked(env));

    const mode = url.searchParams.get('mode');
    const route = url.searchParams.get('route');
    const key = url.searchParams.get('key');
    const supported = [
      'overflow-hold',
      'overflow-throw',
      'overflow-finite',
      'read-error',
      'abort-before',
      'abort-late',
      'empty-forever',
      'exact',
      'split-utf8',
      'tiny-empty',
      'empty',
      'no-body',
      'invalid-json',
      'array-json',
    ];
    if (!mode || !supported.includes(mode) || !['lab', 'ops'].includes(route ?? '') || !key)
      return Response.json({ error: 'Invalid local fixture control' }, { status: 400 });

    const body =
      route === 'lab'
        ? JSON.stringify({ capacity: 17 })
        : JSON.stringify({ incident, requestId: crypto.randomUUID(), note: 'é🟩' });
    const exact = encoder.encode(body + ' '.repeat(4096 - encoder.encode(body).byteLength));
    const content =
      mode === 'invalid-json'
        ? encoder.encode('{invalid')
        : mode === 'array-json'
          ? encoder.encode('[]')
          : mode === 'empty'
            ? new Uint8Array()
            : mode.startsWith('overflow')
              ? new Uint8Array(4097)
              : exact;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offset = 0;
    let emptyNext = true;
    const cleanup = () => {
      metrics.cancelCalls++;
      if (mode === 'overflow-throw') throw new Error('fixture-private-cancellation-detail');
      if (mode === 'overflow-hold') {
        const held = env.HOLD.fetch(`https://hold.internal/${key}/cancel`).then(() => {
          metrics.cancelCompleted++;
        });
        ctx.waitUntil(held.catch(() => {}));
        return held;
      }
      metrics.cancelCompleted++;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (['overflow-hold', 'overflow-throw'].includes(mode)) {
          controller.enqueue(content);
        } else if (mode === 'read-error') {
          controller.error(new Error('fixture-private-read-detail'));
        } else if (mode === 'abort-late') {
          controller.enqueue(content.subarray(0, 1));
          const held = env.HOLD.fetch(`https://hold.internal/${key}/data`).then(() => {
            metrics.lateSupplyAttempts++;
            try {
              controller.enqueue(content.subarray(1));
              controller.close();
            } catch {
              metrics.lateSupplyRejected++;
            }
          });
          ctx.waitUntil(held.catch(() => {}));
          timer = setTimeout(() => abort.abort(), 50);
        }
      },
      pull(controller) {
        if (['overflow-hold', 'overflow-throw', 'read-error', 'abort-late'].includes(mode)) return;
        if (mode === 'empty-forever') {
          controller.enqueue(new Uint8Array());
          return;
        }
        if (mode === 'tiny-empty' && emptyNext) {
          emptyNext = false;
          controller.enqueue(new Uint8Array());
          return;
        }
        emptyNext = true;
        if (offset === content.byteLength) {
          controller.close();
          return;
        }
        const end = ['tiny-empty', 'split-utf8'].includes(mode) ? offset + 1 : content.byteLength;
        controller.enqueue(content.subarray(offset, end));
        offset = end;
      },
      cancel: cleanup,
    });
    if (mode === 'abort-before') abort.abort();
    const source = new Request(
      new URL(route === 'lab' ? '/api/config' : '/api/ops/incident-note', request.url),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Lab-ID': capability,
          ...(route === 'ops' ? { Authorization: `Bearer ${env.OPERATOR_TOKEN}` } : {}),
        },
        body: mode === 'no-body' ? undefined : stream,
        signal: abort.signal,
      },
    );
    try {
      return await gateway.fetch(source, tracked(env));
    } finally {
      clearTimeout(timer);
    }
  },
} satisfies ExportedHandler<FixtureEnv>;
