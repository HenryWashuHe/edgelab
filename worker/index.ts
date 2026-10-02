import { MonitorStore, operatorAuthorized, type MonitorEnv } from './monitor';
import { createLabForwarder, createMonitorForwarder } from './monitor-forwarder';
import { readRequestBody, type RequestBodyResult } from './request-body';
export { MonitorStore };
const forwardMonitor = createMonitorForwarder();
const forwardLab = createLabForwarder();
import { callOrigin } from './origin-client';
import {
  LAB_OBSERVER_PROTOCOL,
  LAB_OBSERVER_SNAPSHOT_EVENTS,
  MAX_LAB_OBSERVERS,
  MAX_LAB_OBSERVER_FRAME_BYTES,
  captureLabObserverFrame,
  parseLabObserverProtocols,
  serializeLabObserverFrame,
  type LabObserverDataFrame,
  type LabObserverTerminalFrame,
} from './lab-observer';
import { DurableObject } from 'cloudflare:workers';
import { admitLabRequest, type LabAdmissionConfig } from './lab-admission';
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
interface Env extends MonitorEnv, LabAdmissionConfig {
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
  private schemaPresent = false;
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
    this.schemaPresent = true;
  }
  private readExisting(): LabState | null {
    // A successful idle delete removes the tables in this still-warm instance.
    // Observation must report absence without recreating them or renewing the lease.
    if (!this.schemaPresent) return null;
    const row = this.ctx.storage.sql
      .exec<{ value: string }>('SELECT value FROM state WHERE id = 1')
      .toArray()[0];
    if (!row) return null;
    const s: LabState = JSON.parse(row.value);
    // Preserve existing v1 runs while adding the new timeout and real-response cache.
    s.config = { ...defaults, ...s.config };
    s.cachedPayload ??= null;
    if (!s.cachedPayload) s.cachedAt = null;
    return s;
  }
  private read(): LabState {
    return this.readExisting() ?? initialState(Date.now(), crypto.randomUUID());
  }
  private save(s: LabState, now = Date.now()) {
    const previous = Number.isSafeInteger(s.revision) && s.revision! >= 0 ? s.revision! : 0;
    if (previous >= Number.MAX_SAFE_INTEGER) throw new Error('Lab revision exhausted');
    s.revision = previous + 1;
    s.committedAt = now;
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
    const id = this.ctx.storage.sql
      .exec<{ id: number }>(
        'INSERT INTO events(value) VALUES (?) RETURNING id',
        JSON.stringify(item),
      )
      .toArray()[0].id;
    this.ctx.storage.sql.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 180 FROM events)');
    return { ...item, id } satisfies LabEvent;
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const expiresAt = this.ctx.storage.kv.get<number>('expiresAt');
        if (expiresAt && expiresAt > Date.now()) {
          await this.ctx.storage.setAlarm(expiresAt);
          return;
        }
        // Compatibility date >= 2026-02-24 also clears alarm metadata.
        await this.ctx.storage.deleteAll();
        this.schemaPresent = false;
        // Close the expired run before a queued owner request can create a new one.
        this.terminal('expired', 4001);
      } catch (error) {
        this.terminal('unavailable', 1011);
        throw error;
      }
    });
  }
  private async touch() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      const configured = Number(this.env.LAB_IDLE_TTL_MS);
      const ttl = Number.isSafeInteger(configured) && configured >= 100 ? configured : 86_400_000;
      const now = Date.now();
      const expiresAt = now + ttl;
      const committed = this.ctx.storage.transactionSync(() => {
        const previous = this.readExisting();
        const priorDeadline = this.ctx.storage.kv.get<number>('expiresAt');
        const expired =
          Number.isSafeInteger(priorDeadline) && priorDeadline! >= 0 && priorDeadline! <= now;
        let s = previous ?? initialState(now, crypto.randomUUID());
        if (expired) {
          // Alarm delivery may be delayed. A known expired run cannot be revived by owner activity.
          this.ctx.storage.sql.exec('DELETE FROM events');
          s = initialState(now, crypto.randomUUID());
          s.revision = previous?.revision;
        }
        this.ctx.storage.kv.put('expiresAt', expiresAt);
        this.save(s, now);
        return { frame: captureLabObserverFrame(s, 'update', [], now, expiresAt), expired };
      });
      await this.ctx.storage.setAlarm(expiresAt);
      // Keep ordering until both the source commit and required alarm setup succeed.
      if (committed.expired) this.terminal('expired', 4001);
      else this.publish(committed.frame);
    });
  }
  private frame(s: LabState, events: LabEvent[] = [], deadline?: number): LabObserverDataFrame {
    const expiresAt = deadline ?? this.ctx.storage.kv.get<number>('expiresAt');
    if (!expiresAt) throw new Error('Lab deadline unavailable');
    return captureLabObserverFrame(s, 'update', events, Date.now(), expiresAt);
  }
  private publish(frame: LabObserverDataFrame) {
    const encoded = serializeLabObserverFrame(frame);
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(encoded);
      } catch {
        try {
          ws.close(1011, 'Lab observer unavailable');
        } catch {
          // A closed recipient cannot affect an already committed owner action.
        }
      }
    }
  }
  private terminal(kind: LabObserverTerminalFrame['kind'], code: number) {
    const encoded = serializeLabObserverFrame({
      schemaVersion: 1,
      kind,
      reason: kind === 'expired' ? 'idle-expired' : 'lab-unavailable',
      now: Date.now(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(encoded);
      } catch {
        // Notification failure must not skip the independent close attempt.
      }
      try {
        ws.close(
          code,
          kind === 'expired' ? 'Lab idle deadline expired' : 'Lab observer unavailable',
        );
      } catch {
        // Cleanup is best effort; continue closing the remaining recipients.
      }
    }
  }
  private observe(request: Request): Response {
    const url = new URL(request.url);
    const invalid = observerRequestFailure(request, url);
    if (invalid) return invalid;
    const now = Date.now();
    const s = this.readExisting();
    if (!s) {
      this.terminal('unavailable', 1011);
      return json({ error: 'No existing lab run' }, 404);
    }
    const expiresAt = this.ctx.storage.kv.get<number>('expiresAt');
    if (!expiresAt) {
      this.terminal('unavailable', 1011);
      return json({ error: 'Lab deadline unavailable' }, 503);
    }
    if (expiresAt <= now) {
      this.terminal('expired', 4001);
      return json({ error: 'Lab idle deadline expired' }, 410);
    }
    if (
      this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length >=
      MAX_LAB_OBSERVERS
    )
      return json({ error: 'Live observer limit reached' }, 429);
    const events = this.ctx.storage.sql
      .exec<{ id: number; value: string }>(
        'SELECT id, value FROM events ORDER BY id DESC LIMIT ?',
        LAB_OBSERVER_SNAPSHOT_EVENTS,
      )
      .toArray()
      .map((row) => ({ ...JSON.parse(row.value), id: row.id }) as LabEvent);
    const encoded = serializeLabObserverFrame(
      captureLabObserverFrame(s, 'snapshot', events, now, expiresAt),
    );
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      schemaVersion: 1,
      protocol: LAB_OBSERVER_PROTOCOL,
      joinedAt: now,
    });
    server.send(encoded);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': LAB_OBSERVER_PROTOCOL, 'Cache-Control': 'no-store' },
    });
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const bytes =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    ws.close(
      bytes > MAX_LAB_OBSERVER_FRAME_BYTES ? 1009 : 1008,
      bytes > MAX_LAB_OBSERVER_FRAME_BYTES
        ? 'Observer message too large'
        : 'Observer channel is read-only',
    );
  }
  webSocketClose(ws: WebSocket) {
    // Runtime close handling removes the socket; do not echo arbitrary close text or invalid codes.
    try {
      ws.close();
    } catch {
      // The peer may have already completed the close handshake.
    }
  }
  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, 'Lab observer unavailable');
    } catch {
      // A disconnected observer requires no storage cleanup.
    }
  }
  async fetch(request: Request): Promise<Response> {
    try {
      return await this.fetchLab(request);
    } catch (error) {
      this.terminal('unavailable', 1011);
      throw error;
    }
  }
  private async fetchLab(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').pop();
    // Observation cannot seed a run, save state, or renew the owner-maintained deadline.
    if (action === 'observe') return this.observe(request);
    await this.touch();
    const requestId = crypto.randomUUID();
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
      const frame = this.ctx.storage.transactionSync(() => {
        const previous = this.read();
        this.ctx.storage.sql.exec('DELETE FROM events');
        const s = initialState(Date.now(), crypto.randomUUID());
        s.revision = previous.revision;
        this.save(s);
        return this.frame(s);
      });
      this.publish(frame);
      return json({ ok: true });
    }
    if (action === 'config') {
      let patch: unknown;
      try {
        patch = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const result = this.ctx.storage.transactionSync(() => {
        const s = this.read();
        refill(s, Date.now());
        try {
          s.config = validateConfig(patch, s.config);
        } catch (e) {
          return { response: json({ error: (e as Error).message }, 400), frame: null };
        }
        s.tokens = Math.min(s.tokens, s.config.capacity);
        this.save(s);
        return { response: json({ ok: true }), frame: this.frame(s) };
      });
      if (result.frame) this.publish(result.frame);
      return result.response;
    }
    if (action !== 'request') return json({ error: 'Not found' }, 404);
    const started = Date.now();
    const admitted = this.ctx.storage.transactionSync(() => {
      const s = this.read();
      const result = admit(s, started);
      this.save(s);
      const event = 'outcome' in result ? this.event(s, result, started, requestId) : null;
      return { result, frame: this.frame(s, event ? [event] : []) };
    });
    this.publish(admitted.frame);
    const admission = admitted.result;
    if ('outcome' in admission) return this.respond(admission, requestId);
    const originResult = await callOrigin(
      this.env.ORIGIN,
      admission.delay,
      admission.fails,
      admission.timeoutMs,
    );
    const completed = this.ctx.storage.transactionSync(() => {
      const expiresAt = this.ctx.storage.kv.get<number>('expiresAt');
      if (!expiresAt || expiresAt <= Date.now()) return null;
      const s = this.read();
      const decision = complete(s, admission, Date.now(), originResult);
      if (decision) {
        this.save(s);
        const event = this.event(s, decision, started, requestId, true);
        return { decision, frame: this.frame(s, [event], expiresAt) };
      }
      return null;
    });
    if (completed) this.publish(completed.frame);
    return completed
      ? this.respond(completed.decision, requestId)
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
function observerRequestFailure(request: Request, url: URL): Response | null {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
  if (request.headers.get('Origin') !== url.origin)
    return json({ error: 'Same-origin observer request required' }, 403);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    return json({ error: 'WebSocket upgrade required' }, 426, { Upgrade: 'websocket' });
  if (url.search || !parseLabObserverProtocols(request.headers.get('Sec-WebSocket-Protocol')))
    return json({ error: 'Exact observer protocol pair required' }, 400);
  return null;
}
function requestBodyFailure(result: Exclude<RequestBodyResult, { kind: 'body' }>): Response {
  if (result.kind === 'too-large') return json({ error: 'Request exceeds 4 KB' }, 413);
  if (result.kind === 'timeout') return json({ error: 'Request body timed out' }, 408);
  return json({ error: 'Request body could not be read' }, 400);
}
export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const stub = env.MONITORS.get(env.MONITORS.idFromName('operations'));
    const response = await forwardMonitor(
      stub,
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
        version: '3.12.5',
        origin: 'service-binding',
      });
    if (url.pathname === '/api/ready') {
      if (request.method !== 'GET')
        return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
      return forwardMonitor(
        env.MONITORS.get(env.MONITORS.idFromName('operations')),
        new Request('https://monitor.internal/ready'),
      );
    }
    if (url.pathname.startsWith('/api/ops/')) {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin)
        return json({ error: 'Cross-origin requests are not allowed' }, 403);
      const action = url.pathname.slice('/api/ops/'.length);
      const incidentDetail = /^incidents\/[0-9a-f-]{36}$/i.test(action);
      const incidentBriefs = /^incidents\/[0-9a-f-]{36}\/briefs$/i.test(action);
      const briefDetail = /^incident-briefs\/[0-9a-f-]{36}$/i.test(action);
      const method =
        ['status', 'audit', 'export'].includes(action) ||
        incidentDetail ||
        incidentBriefs ||
        briefDetail
          ? 'GET'
          : 'POST';
      if (
        ![
          'status',
          'audit',
          'export',
          'policy',
          'acknowledge',
          'incident-note',
          'incident-brief',
        ].includes(action) &&
        !incidentDetail &&
        !incidentBriefs &&
        !briefDetail
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
        const result = await readRequestBody(request);
        if (result.kind !== 'body') return requestBodyFailure(result);
        body = result.body;
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
      const internal = new URL(`https://monitor.internal/${action}`);
      internal.searchParams.set('window', url.searchParams.get('window') === '7d' ? '7d' : '24h');
      if (incidentDetail && url.searchParams.has('before'))
        internal.searchParams.set('before', url.searchParams.get('before')!);
      const response = await forwardMonitor(
        stub,
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
    if (url.pathname === '/api/observe') {
      const invalid = observerRequestFailure(request, url);
      if (invalid) return invalid;
      const admission = await admitLabRequest(env, 'observer');
      if (admission) return admission;
      const id = parseLabObserverProtocols(request.headers.get('Sec-WebSocket-Protocol'))!;
      const response = await forwardLab(
        env.LABS.get(env.LABS.idFromName(id)),
        new Request(request.url, {
          method: 'GET',
          headers: {
            Origin: request.headers.get('Origin')!,
            Upgrade: 'websocket',
            'Sec-WebSocket-Protocol': request.headers.get('Sec-WebSocket-Protocol')!,
          },
        }),
      );
      const headers = new Headers(response.headers);
      headers.set('X-Edge-Colo', String(colo(request)));
      if (response.status === 101 && response.webSocket)
        return new Response(null, { status: 101, headers, webSocket: response.webSocket });
      return new Response(response.body, { status: response.status, headers });
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
      const result = await readRequestBody(request);
      if (result.kind !== 'body') return requestBodyFailure(result);
      body = result.body;
    }
    const admission = await admitLabRequest(env, 'owner');
    if (admission) return admission;
    const stub = env.LABS.get(env.LABS.idFromName(id));
    const response = await forwardLab(
      stub,
      new Request(request.url, { method: request.method, headers: request.headers, body }),
    );
    const headers = new Headers(response.headers);
    headers.set('X-Edge-Colo', String(colo(request)));
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
