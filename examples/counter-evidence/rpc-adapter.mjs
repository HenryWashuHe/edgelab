import OriginalWorker from './upstream/counter.js';
export { Counter } from './upstream/counter.js';

const json = (value, status = 200, extra = {}) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });

/** Local fixture only: sample the existing read RPC without adapting the Durable Object. */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/__sample') return OriginalWorker.fetch(request, env, ctx);
    if (request.method !== 'GET')
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    const name = url.searchParams.get('name');
    if (!name) return json({ error: 'Counter name required' }, 400);
    try {
      const value = await env.COUNTERS.getByName(name).getCounterValue();
      // This is a gateway clock after the read RPC returns, not a source commit time.
      const observedAt = Date.now();
      if (
        !Number.isSafeInteger(value) ||
        Math.abs(value) > 1_000_000_000 ||
        !Number.isSafeInteger(observedAt) ||
        observedAt < 0 ||
        observedAt > 8_640_000_000_000_000
      )
        throw new Error('Counter sample unavailable');
      return json({ observedAt, sourceRevision: null, sourceCommitAt: null, state: { value } });
    } catch {
      return json({ error: 'Counter inspection unavailable' }, 503);
    }
  },
};
