import { DurableObject } from 'cloudflare:workers';
import {
  admit,
  complete,
  initialState,
  refill,
  validateConfig,
  type LabState,
  type LabEvent,
  type Decision,
} from './engine';
interface Env {
  LABS: DurableObjectNamespace<ReliabilityLab>;
  ASSETS: Fetcher;
}
const colo = (request: Request) =>
  ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
    ? 'LOCAL'
    : String(request.cf?.colo ?? 'UNKNOWN');
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });
export class ReliabilityLab extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)',
    );
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)',
    );
  }
  private read(): LabState {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM state WHERE id = 1')
      .toArray()[0];
    return row ? JSON.parse(row.value) : initialState(Date.now(), crypto.randomUUID());
  }
  private save(s: LabState) {
    this.ctx.storage.sql.exec(
      'INSERT INTO state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
      JSON.stringify(s),
    );
  }
  private event(s: LabState, decision: Decision, started: number) {
    const item = {
      ...decision,
      at: Date.now(),
      latencyMs: Date.now() - started,
      circuit: s.circuit,
    };
    this.ctx.storage.sql.exec('INSERT INTO events(value) VALUES (?)', JSON.stringify(item));
    this.ctx.storage.sql.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 180 FROM events)');
    return item;
  }
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').pop();
    if (action === 'state' && request.method === 'GET') {
      const s = this.read();
      refill(s, Date.now());
      const events = this.ctx.storage.sql
        .exec<{ id: number; value: string }>(
          'SELECT id, value FROM events ORDER BY id DESC LIMIT 180',
        )
        .toArray()
        .map((row) => ({ ...JSON.parse(row.value), id: row.id }) as LabEvent);
      return json({ state: s, events, now: Date.now() });
    }
    if (request.method !== 'POST')
      return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (action === 'reset') {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM events');
        this.save(initialState(Date.now(), crypto.randomUUID()));
      });
      return json({ ok: true });
    }
    if (action === 'config') {
      let patch: unknown;
      try {
        patch = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      try {
        this.ctx.storage.transactionSync(() => {
          const s = this.read();
          refill(s, Date.now());
          s.config = validateConfig(patch, s.config);
          s.tokens = Math.min(s.tokens, s.config.capacity);
          this.save(s);
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (action !== 'request') return json({ error: 'Not found' }, 404);
    const started = Date.now();
    const admission = this.ctx.storage.transactionSync(() => {
      const s = this.read();
      const result = admit(s, started);
      this.save(s);
      if ('outcome' in result) this.event(s, result, started);
      return result;
    });
    if ('outcome' in admission) return this.respond(admission);
    // This intentionally controlled origin never fetches a user-supplied URL.
    // The delay is actual elapsed time; failures are injected, not real incidents.
    await new Promise((resolve) => setTimeout(resolve, admission.delay));
    const result = this.ctx.storage.transactionSync(() => {
      const s = this.read();
      const decision = complete(s, admission, Date.now());
      if (decision) {
        this.save(s);
        this.event(s, decision, started);
      }
      return decision;
    });
    return result
      ? this.respond(result)
      : json({ error: 'Lab reset while request was in flight' }, 409);
  }
  private respond(decision: Decision) {
    return json(
      {
        ...decision,
        payload:
          decision.status === 200
            ? { service: 'demo-store', message: 'The Internet is still open.' }
            : undefined,
      },
      decision.status,
      decision.retryAfter ? { 'Retry-After': String(decision.retryAfter) } : {},
    );
  }
}
async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/health')
      return json({
        ok: true,
        colo: colo(request),
        platform: 'Cloudflare Workers + Durable Objects',
      });
    if (!['/api/state', '/api/request', '/api/config', '/api/reset'].includes(url.pathname))
      return json({ error: 'Not found' }, 404);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin)
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    const id = request.headers.get('X-Lab-ID');
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return json({ error: 'A UUID v4 X-Lab-ID header is required' }, 400);
    if (!['GET', 'POST'].includes(request.method))
      return json({ error: 'Method not allowed' }, 405);
    let body: string | undefined;
    if (request.method === 'POST') {
      try {
        body = await boundedBody(request);
      } catch {
        return json({ error: 'Request exceeds 4 KB' }, 413);
      }
    }
    const stub = env.LABS.get(env.LABS.idFromName(id));
    const response = await stub.fetch(
      new Request(request.url, { method: request.method, headers: request.headers, body }),
    );
    const headers = new Headers(response.headers);
    headers.set('X-Edge-Colo', String(colo(request)));
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
