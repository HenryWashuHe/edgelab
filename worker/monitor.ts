import { DurableObject } from 'cloudflare:workers';
import {
  defaultPolicy,
  initialMonitorState,
  MINUTE,
  RETENTION,
  parseTargets,
  transition,
  validatePolicy,
  windowBounds,
  type MonitorPolicy,
  type MonitorState,
  type MonitorTarget,
  type ProbeResult,
} from './monitor-domain';
import { probe } from './monitor-probe';
export interface MonitorEnv {
  MONITORS: DurableObjectNamespace<MonitorStore>;
  ORIGIN: Fetcher;
  MONITOR_TARGETS?: string;
  OPERATOR_TOKEN?: string;
}
type ServiceRow = {
  id: string;
  name: string;
  target: string;
  policy: string;
  state: string;
  revision: number;
  created: number;
};
type CheckRow = {
  service: string;
  slot: number;
  at: number;
  outcome: ProbeResult['outcome'];
  status: number | null;
  latency: number;
  revision: number;
};
type IncidentRow = {
  id: string;
  service: string;
  opened: number;
  resolved: number | null;
  acknowledged: number | null;
  note: string;
};
const reply = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
export class MonitorStore extends DurableObject<MonitorEnv> {
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL, target TEXT NOT NULL, policy TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS checks (service TEXT NOT NULL, slot INTEGER NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, status INTEGER, latency INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(service, slot))',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS checks_retention ON checks(at)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS jobs (service TEXT NOT NULL, slot INTEGER NOT NULL, token TEXT NOT NULL, lease INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(service, slot))',
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, service TEXT NOT NULL, opened INTEGER NOT NULL, resolved INTEGER, acknowledged INTEGER, note TEXT NOT NULL DEFAULT '')",
    );
    sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(service) WHERE resolved IS NULL',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, service TEXT NOT NULL, detail TEXT NOT NULL)',
    );
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ) {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }
  private event(action: string, service: string, detail: unknown) {
    this.ctx.storage.sql.exec(
      'INSERT INTO audit(at,action,service,detail) VALUES(?,?,?,?)',
      Date.now(),
      action,
      service,
      JSON.stringify(detail),
    );
  }
  private syncTargets() {
    const targets = parseTargets(this.env.MONITOR_TARGETS);
    this.ctx.storage.transactionSync(() => {
      for (const target of targets) {
        const existing = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
        if (!existing) {
          this.ctx.storage.sql.exec(
            'INSERT INTO services VALUES(?,?,?,?,?,?,?)',
            target.id,
            target.name,
            JSON.stringify(target),
            JSON.stringify(defaultPolicy),
            JSON.stringify(initialMonitorState()),
            1,
            Date.now(),
          );
          this.event('service.created', target.id, { name: target.name });
        } else if (existing.target !== JSON.stringify(target)) {
          // Target edits are deployment changes; discard old in-flight results and reset streaks.
          const state: MonitorState = JSON.parse(existing.state);
          state.failures = state.successes = 0;
          state.lastSlot = null;
          this.ctx.storage.sql.exec(
            'UPDATE services SET name=?,target=?,revision=revision+1,state=? WHERE id=?',
            target.name,
            JSON.stringify(target),
            JSON.stringify(state),
            target.id,
          );
          this.event('service.target-updated', target.id, { revision: existing.revision + 1 });
        }
      }
    });
    return targets;
  }
  async fetch(request: Request): Promise<Response> {
    const targets = this.syncTargets();
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/status')
      return reply(this.snapshot(targets, url.searchParams.get('window') === '7d' ? 10080 : 1440));
    if (request.method === 'GET' && url.pathname === '/audit')
      return reply({
        events: this.rows('SELECT * FROM audit ORDER BY id DESC LIMIT 100').map((r) => ({
          ...r,
          detail: JSON.parse(String(r.detail)),
        })),
        incidents: this.rows<IncidentRow>('SELECT * FROM incidents ORDER BY opened DESC LIMIT 100'),
      });
    if (request.method !== 'POST') return reply({ error: 'Not found' }, 404);
    const body = (await request.json()) as Record<string, unknown>;
    if (url.pathname === '/tick') {
      const slot = body.slot;
      if (
        !Number.isInteger(slot) ||
        Number(slot) > Math.floor(Date.now() / MINUTE) ||
        Number(slot) < Math.floor(Date.now() / MINUTE) - 5
      )
        return reply({ error: 'Schedule outside accepted window' }, 400);
      const results = await Promise.all(targets.map((target) => this.check(target, Number(slot))));
      this.ctx.storage.transactionSync(() => {
        const cutoff = Date.now() - RETENTION;
        this.ctx.storage.sql.exec('DELETE FROM checks WHERE at < ?', cutoff);
        this.ctx.storage.sql.exec('DELETE FROM jobs WHERE slot < ?', Math.floor(cutoff / MINUTE));
        this.ctx.storage.sql.exec(
          'DELETE FROM incidents WHERE resolved IS NOT NULL AND resolved < ?',
          cutoff,
        );
        this.ctx.storage.sql.exec('DELETE FROM audit WHERE at < ?', cutoff);
      });
      return reply({ slot, results });
    }
    if (url.pathname === '/policy') {
      if (
        typeof body.service !== 'string' ||
        !targets.some((t) => t.id === body.service) ||
        !Number.isInteger(body.revision)
      )
        return reply({ error: 'Known service and revision required' }, 400);
      try {
        return this.ctx.storage.transactionSync(() => {
          const service = this.rows<ServiceRow>(
            'SELECT * FROM services WHERE id=?',
            String(body.service),
          )[0];
          if (service.revision !== body.revision)
            return reply({ error: 'Policy changed. Refresh before saving.' }, 409);
          const policy = validatePolicy(body.policy, JSON.parse(service.policy));
          const state: MonitorState = JSON.parse(service.state);
          state.failures = state.successes = 0;
          this.ctx.storage.sql.exec(
            'UPDATE services SET policy=?,revision=revision+1,state=? WHERE id=?',
            JSON.stringify(policy),
            JSON.stringify(state),
            service.id,
          );
          this.event('policy.updated', service.id, {
            before: JSON.parse(service.policy),
            after: policy,
            revision: service.revision + 1,
          });
          return reply({ ok: true, revision: service.revision + 1 });
        });
      } catch (error) {
        return reply({ error: (error as Error).message }, 400);
      }
    }
    if (url.pathname === '/acknowledge') {
      if (
        typeof body.incident !== 'string' ||
        typeof body.note !== 'string' ||
        !body.note.trim() ||
        body.note.length > 500
      )
        return reply({ error: 'Incident and a note of 1–500 characters required' }, 400);
      return this.ctx.storage.transactionSync(() => {
        const incident = this.rows<IncidentRow>(
          'SELECT * FROM incidents WHERE id=?',
          String(body.incident),
        )[0];
        if (!incident) return reply({ error: 'Incident not found' }, 404);
        if (incident.resolved) return reply({ error: 'Incident has already recovered' }, 409);
        if (incident.acknowledged) return reply({ ok: true, alreadyAcknowledged: true });
        this.ctx.storage.sql.exec(
          'UPDATE incidents SET acknowledged=?,note=? WHERE id=?',
          Date.now(),
          String(body.note).trim(),
          incident.id,
        );
        this.event('incident.acknowledged', incident.service, {
          incident: incident.id,
          note: body.note,
        });
        return reply({ ok: true });
      });
    }
    return reply({ error: 'Not found' }, 404);
  }
  private async check(target: MonitorTarget, slot: number) {
    const claim = this.ctx.storage.transactionSync(() => {
      const service = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
      if (this.rows('SELECT slot FROM checks WHERE service=? AND slot=?', target.id, slot).length)
        return null;
      if (
        this.rows(
          'SELECT slot FROM jobs WHERE service=? AND done=0 AND lease>?',
          target.id,
          Date.now(),
        ).length
      )
        return null;
      const token = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'INSERT INTO jobs VALUES(?,?,?,?,0) ON CONFLICT(service,slot) DO UPDATE SET token=excluded.token,lease=excluded.lease,done=0',
        target.id,
        slot,
        token,
        Date.now() + 30000,
      );
      return { token, service, policy: JSON.parse(service.policy) as MonitorPolicy };
    });
    if (!claim) return { service: target.id, result: 'duplicate-or-busy' };
    const result: ProbeResult = claim.policy.paused
      ? { outcome: 'maintenance', status: null, latencyMs: 0 }
      : await probe(target, claim.policy, this.env.ORIGIN);
    return this.ctx.storage.transactionSync(() => {
      const job = this.rows<{ token: string; done: number }>(
        'SELECT token,done FROM jobs WHERE service=? AND slot=?',
        target.id,
        slot,
      )[0];
      if (!job || job.token !== claim.token || job.done)
        return { service: target.id, result: 'superseded' };
      const current = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
      if (current.revision !== claim.service.revision) {
        this.ctx.storage.sql.exec(
          'DELETE FROM jobs WHERE service=? AND slot=? AND token=?',
          target.id,
          slot,
          claim.token,
        );
        return { service: target.id, result: 'policy-changed' };
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO checks VALUES(?,?,?,?,?,?,?)',
        target.id,
        slot,
        Date.now(),
        result.outcome,
        result.status,
        result.latencyMs,
        current.revision,
      );
      this.ctx.storage.sql.exec(
        'UPDATE jobs SET done=1 WHERE service=? AND slot=?',
        target.id,
        slot,
      );
      let state: MonitorState = JSON.parse(current.state);
      if (result.outcome === 'maintenance') {
        if (state.lastSlot === null || slot > state.lastSlot) {
          state.lastSlot = slot;
          state.failures = state.successes = 0;
        }
      } else {
        const next = transition(state, result.outcome === 'good', slot, claim.policy);
        state = next.state;
        if (next.change === 'open') {
          state.incidentId = crypto.randomUUID();
          this.ctx.storage.sql.exec(
            'INSERT INTO incidents(id,service,opened) VALUES(?,?,?)',
            state.incidentId,
            target.id,
            Date.now(),
          );
          this.event('incident.opened', target.id, {
            incident: state.incidentId,
            outcome: result.outcome,
          });
        } else if (next.change === 'resolve') {
          this.ctx.storage.sql.exec(
            'UPDATE incidents SET resolved=? WHERE id=?',
            Date.now(),
            state.incidentId,
          );
          this.event('incident.recovered', target.id, { incident: state.incidentId });
          state.incidentId = null;
        }
      }
      this.ctx.storage.sql.exec(
        'UPDATE services SET state=? WHERE id=?',
        JSON.stringify(state),
        target.id,
      );
      return { service: target.id, result: result.outcome };
    });
  }
  private snapshot(targets: MonitorTarget[], minutes: number) {
    const now = Date.now();
    const services = targets.map((target) => {
      const row = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
      const policy: MonitorPolicy = JSON.parse(row.policy);
      const state: MonitorState = JSON.parse(row.state);
      const latest =
        this.rows<CheckRow>(
          'SELECT * FROM checks WHERE service=? ORDER BY slot DESC LIMIT 1',
          target.id,
        )[0] ?? null;
      const bounds = windowBounds(row.created, now, minutes);
      const stats = this.rows<{
        total: number;
        observed: number;
        good: number;
        maintenance: number;
      }>(
        "SELECT COUNT(*) total, COALESCE(SUM(outcome!='maintenance'),0) observed, COALESCE(SUM(outcome='good'),0) good, COALESCE(SUM(outcome='maintenance'),0) maintenance FROM checks WHERE service=? AND slot BETWEEN ? AND ?",
        target.id,
        bounds.start,
        bounds.end,
      )[0];
      const p95 = stats.observed
        ? (this.rows<{ latency: number }>(
            "SELECT latency FROM checks WHERE service=? AND slot BETWEEN ? AND ? AND outcome!='maintenance' ORDER BY latency LIMIT 1 OFFSET ?",
            target.id,
            bounds.start,
            bounds.end,
            Math.ceil(stats.observed * 0.95) - 1,
          )[0]?.latency ?? null)
        : null;
      const eligible = bounds.expected - stats.maintenance;
      const allowedBad = stats.observed * (1 - policy.availabilityTarget / 100);
      return {
        id: target.id,
        name: target.name,
        transport: target.transport,
        assertion: target.assertion,
        createdAt: row.created,
        revision: row.revision,
        policy,
        latest,
        status: policy.paused
          ? 'maintenance'
          : !latest ||
              latest.revision !== row.revision ||
              latest.slot < Math.floor(now / MINUTE) - 2
            ? 'unknown'
            : state.incidentId
              ? 'incident'
              : latest.outcome === 'good'
                ? 'healthy'
                : 'degraded',
        state,
        metrics: {
          ...stats,
          expected: bounds.expected,
          missing: Math.max(0, bounds.expected - stats.total),
          coverage: eligible > 0 ? (100 * stats.observed) / eligible : null,
          goodRatio: stats.observed ? (100 * stats.good) / stats.observed : null,
          p95Ms: p95,
          budgetConsumed:
            allowedBad > 0 ? (100 * (stats.observed - stats.good)) / allowedBad : null,
          windowStart: bounds.start * MINUTE,
          windowEnd: (bounds.end + 1) * MINUTE,
        },
        history: this.rows<CheckRow>(
          'SELECT * FROM checks WHERE service=? ORDER BY slot DESC LIMIT 60',
          target.id,
        ),
        hourly: this.rows(
          "SELECT CAST(slot/60 AS INTEGER)*3600000 AS at, COUNT(*) AS total, SUM(outcome='good') AS good, SUM(outcome='maintenance') AS maintenance FROM checks WHERE service=? AND slot BETWEEN ? AND ? GROUP BY CAST(slot/60 AS INTEGER) ORDER BY at",
          target.id,
          bounds.start,
          bounds.end,
        ),
      };
    });
    const active = new Set(targets.map((t) => t.id));
    return {
      version: '3.0.0',
      now,
      window: minutes === 1440 ? '24h' : '7d',
      retentionDays: 30,
      cadenceSeconds: 60,
      services,
      incidents: this.rows<IncidentRow>('SELECT * FROM incidents ORDER BY opened DESC LIMIT 100')
        .filter((i) => active.has(i.service))
        .map(({ note: _note, ...publicIncident }) => publicIncident),
    };
  }
}
/** Authentication is enforced at the public Worker boundary, before reaching the singleton. */
export async function operatorAuthorized(request: Request, secret?: string) {
  if (!secret || secret.length < 32) return false;
  const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]{32,256})$/)?.[1];
  if (!token) return false;
  const encode = (s: string) => new TextEncoder().encode(s);
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(token)),
    crypto.subtle.digest('SHA-256', encode(secret)),
  ]);
  const left = new Uint8Array(a),
    right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
export type OperationsSnapshot = ReturnType<MonitorStore['snapshot']>;
