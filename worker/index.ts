import { MonitorStore, operatorAuthorized, type MonitorEnv } from './monitor';
export { MonitorStore };
import { callOrigin } from './origin-client';
import { DurableObject } from 'cloudflare:workers';
import {
  defaults,
  admit,
  complete,
  initialState,
  refill,
  validateConfig,
  type LabState,
  type LabEvent,
  type Decision,
} from './engine';
interface Env extends MonitorEnv {
  LABS: DurableObjectNamespace<ReliabilityLab>;
  ASSETS: Fetcher;
  ORIGIN: Fetcher;
  LAB_IDLE_TTL_MS?: string;
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
    this.ensureSchema();
  }
  private ensureSchema() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)',
    );
  }
  private read(): LabState {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM state WHERE id = 1')
      .toArray()[0];
    const s: LabState = row ? JSON.parse(row.value) : initialState(Date.now(), crypto.randomUUID());
    // Preserve existing v1 runs while adding the new timeout and real-response cache.
    s.config = { ...defaults, ...s.config };
    s.cachedPayload ??= null;
    if (!s.cachedPayload) s.cachedAt = null;
    return s;
  }
  private save(s: LabState) {
    this.ctx.storage.sql.exec(
      'INSERT INTO state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
      JSON.stringify(s),
    );
  }
  private event(
    s: LabState,
    decision: Decision,
    started: number,
    requestId: string,
    originAttempted = false,
  ) {
    const item = {
      ...decision,
      requestId,
      originAttempted,
      at: Date.now(),
      latencyMs: Date.now() - started,
      circuit: s.circuit,
    };
    this.ctx.storage.sql.exec('INSERT INTO events(value) VALUES (?)', JSON.stringify(item));
    this.ctx.storage.sql.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 180 FROM events)');
    return item;
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const expiresAt = this.ctx.storage.kv.get<number>('expiresAt');
      if (expiresAt && expiresAt > Date.now()) {
        await this.ctx.storage.setAlarm(expiresAt);
        return;
      }
      // Compatibility date >= 2026-02-24 also clears alarm metadata.
      await this.ctx.storage.deleteAll();
    });
  }
  private async touch() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      const configured = Number(this.env.LAB_IDLE_TTL_MS);
      const ttl = Number.isFinite(configured) && configured >= 100 ? configured : 86_400_000;
      const expiresAt = Date.now() + ttl;
      this.ctx.storage.kv.put('expiresAt', expiresAt);
      this.save(this.read());
      await this.ctx.storage.setAlarm(expiresAt);
    });
  }
  async fetch(request: Request): Promise<Response> {
    await this.touch();
    const requestId = crypto.randomUUID();
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
      return json({
        state: s,
        events,
        now: Date.now(),
        expiresAt: this.ctx.storage.kv.get('expiresAt'),
      });
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
      if ('outcome' in result) this.event(s, result, started, requestId);
      return result;
    });
    if ('outcome' in admission) return this.respond(admission, requestId);
    const originResult = await callOrigin(
      this.env.ORIGIN,
      admission.delay,
      admission.fails,
      admission.timeoutMs,
    );
    const result = this.ctx.storage.transactionSync(() => {
      if (!this.ctx.storage.kv.get('expiresAt')) return null;
      const s = this.read();
      const decision = complete(s, admission, Date.now(), originResult);
      if (decision) {
        this.save(s);
        this.event(s, decision, started, requestId, true);
      }
      return decision;
    });
    return result
      ? this.respond(result, requestId)
      : json({ error: 'Lab reset while request was in flight' }, 409);
  }
  private respond(decision: Decision, requestId: string) {
    const headers: Record<string, string> = {
      'X-Request-ID': requestId,
      'X-Response-Source': decision.outcome,
    };
    if (decision.retryAfter) headers['Retry-After'] = String(decision.retryAfter);
    if (decision.cacheAgeMs !== undefined)
      headers['Age'] = String(Math.floor(decision.cacheAgeMs / 1000));
    return json({ ...decision, requestId }, decision.status, headers);
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
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const stub = env.MONITORS.get(env.MONITORS.idFromName('operations'));
    const response = await stub.fetch(
      new Request('https://monitor.internal/tick', {
        method: 'POST',
        body: JSON.stringify({ slot: Math.floor(controller.scheduledTime / 60000) }),
      }),
    );
    if (!response.ok) throw new Error(`Monitoring schedule failed: ${response.status}`);
    console.log(JSON.stringify({ event: 'monitor.tick', ...((await response.json()) as object) }));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/health')
      return json({
        ok: true,
        colo: colo(request),
        platform: 'Cloudflare Workers + Durable Objects',
        version: '3.1.0',
        origin: 'service-binding',
      });
    if (url.pathname === '/api/ready') {
      if (request.method !== 'GET')
        return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
      return env.MONITORS.get(env.MONITORS.idFromName('operations')).fetch(
        'https://monitor.internal/ready',
      );
    }
    if (url.pathname.startsWith('/api/ops/')) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin)
        return json({ error: 'Cross-origin requests are not allowed' }, 403);
      const action = url.pathname.slice('/api/ops/'.length);
      const incidentDetail = /^incidents\/[0-9a-f-]{36}$/i.test(action);
      const method =
        ['status', 'audit', 'export'].includes(action) || incidentDetail ? 'GET' : 'POST';
      if (
        !['status', 'audit', 'export', 'policy', 'acknowledge', 'incident-note'].includes(action) &&
        !incidentDetail
      )
        return json({ error: 'Not found' }, 404);
      if (request.method !== method)
        return json({ error: 'Method not allowed' }, 405, { Allow: method });
      const authorized = await operatorAuthorized(request, env.OPERATOR_TOKEN);
      if (
        ((!['status', 'export'].includes(action) && !incidentDetail) ||
          (incidentDetail && request.headers.has('Authorization'))) &&
        !authorized
      )
        return json({ error: 'Operator token required' }, 401, { 'WWW-Authenticate': 'Bearer' });
      let body: string | undefined;
      if (method === 'POST') {
        try {
          body = await boundedBody(request);
        } catch {
          return json({ error: 'Request exceeds 4 KB' }, 413);
        }
        try {
          JSON.parse(body);
        } catch {
          return json({ error: 'Invalid JSON' }, 400);
        }
        if (
          !body ||
          JSON.parse(body) === null ||
          typeof JSON.parse(body) !== 'object' ||
          Array.isArray(JSON.parse(body))
        )
          return json({ error: 'JSON object required' }, 400);
      }
      const stub = env.MONITORS.get(env.MONITORS.idFromName('operations'));
      const internal = new URL(
        `https://monitor.internal/${action === 'export' ? 'status' : action}`,
      );
      internal.searchParams.set('window', url.searchParams.get('window') === '7d' ? '7d' : '24h');
      if (incidentDetail && url.searchParams.has('before'))
        internal.searchParams.set('before', url.searchParams.get('before')!);
      const response = await stub.fetch(
        new Request(internal, {
          method,
          body,
          headers: authorized ? { 'X-Operator-Authorized': 'true' } : {},
        }),
      );
      if (action === 'export' && response.ok) {
        const snapshot = (await response.json()) as object;
        return new Response(
          JSON.stringify(
            {
              schemaVersion: 4,
              exportedAt: new Date().toISOString(),
              measurement:
                'One sampled observation per current UTC minute. Late schedules are skipped, never backfilled. Finished minutes only. Legacy checks without an observation start timestamp are excluded from verified metrics. Gaps are unknown; maintenance is excluded; good checks meet the policy active when observed. Not global uptime.',
              ...snapshot,
            },
            null,
            2,
          ),
          {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': 'attachment; filename="edgelab-operations.json"',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
      return response;
    }
    if (!['/api/state', '/api/request', '/api/config', '/api/reset'].includes(url.pathname))
      return json({ error: 'Not found' }, 404);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin)
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    const id = request.headers.get('X-Lab-ID');
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      return json({ error: 'A UUID v4 X-Lab-ID header is required' }, 400);
    const allowed = url.pathname === '/api/state' ? 'GET' : 'POST';
    if (request.method !== allowed)
      return json({ error: 'Method not allowed' }, 405, { Allow: allowed });
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
