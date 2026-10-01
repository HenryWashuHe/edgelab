import OriginalWorker, { Counter } from './upstream/counter.js';

const methods = [
  'get',
  'put',
  'delete',
  'list',
  'deleteAll',
  'getAlarm',
  'setAlarm',
  'deleteAlarm',
  'sync',
];
let constructions = 0;
const json = (value, status = 200, extra = {}) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });

/** Local fixture only: unchanged source behavior with attempted logical API-call meters. */
export class EvidenceCounter extends Counter {
  constructor(ctx, env) {
    const operations = Object.fromEntries(methods.map((method) => [method, 0]));
    // Keep the real context and native methods. Return their exact results and
    // promises without adding awaits, synchronization, transactions or writes.
    for (const method of methods) {
      const delegate = ctx.storage[method].bind(ctx.storage);
      ctx.storage[method] = (...args) => {
        operations[method]++;
        return delegate(...args);
      };
    }
    super(ctx, env);
    this.operations = operations;
    this.constructionSequence = ++constructions;
  }

  async readSnapshot() {
    const stored = await this.ctx.storage.get('value');
    const value = stored ?? 0;
    const observedAt = Date.now();
    if (
      !Number.isSafeInteger(value) ||
      Math.abs(value) > 1_000_000_000 ||
      !Number.isSafeInteger(observedAt) ||
      observedAt < 0 ||
      observedAt > 8_640_000_000_000_000
    )
      throw new Error('Counter sample unavailable');
    return { observedAt, sourceRevision: null, sourceCommitAt: null, state: { value } };
  }

  readMeter() {
    return {
      scope: 'attempted-logical-calls-since-construction',
      operations: { ...this.operations },
      // Worker-local ordering only; neither persistent nor an object identity.
      constructionSequence: this.constructionSequence,
    };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/__sample' && url.pathname !== '/__meter')
      return OriginalWorker.fetch(request, env, ctx);
    if (request.method !== 'GET')
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    const name = url.searchParams.get('name');
    if (!name) return json({ error: 'Counter name required' }, 400);
    try {
      const counter = env.COUNTERS.getByName(name);
      return json(
        await (url.pathname === '/__sample' ? counter.readSnapshot() : counter.readMeter()),
      );
    } catch {
      return json({ error: 'Counter inspection unavailable' }, 503);
    }
  },
};
