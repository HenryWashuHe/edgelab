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
import { IncidentEvidence } from './incident-evidence';
import { classifyTick, monitoringReadiness } from './monitor-readiness';
import { BudgetSignals } from './budget-signals';
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
  observedAt: number | null;
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
  private evidence: IncidentEvidence;
  private budgets: BudgetSignals;
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
    // Existing observations cannot prove when their probe started. Preserve them as
    // legacy evidence, but never invent a timestamp or include them in verified SLOs.
    const columns = sql.exec<{ name: string }>('PRAGMA table_info(checks)').toArray();
    if (!columns.some((column) => column.name === 'observed_at')) {
      ctx.storage.transactionSync(() => {
        sql.exec('ALTER TABLE checks ADD COLUMN observed_at INTEGER');
        for (const row of sql
          .exec<{ id: string; state: string }>('SELECT id,state FROM services')
          .toArray()) {
          const state: MonitorState = JSON.parse(row.state);
          state.failures = state.successes = 0;
          state.lastSlot = null;
          sql.exec('UPDATE services SET state=? WHERE id=?', JSON.stringify(state), row.id);
        }
      });
    }
    sql.exec(
      'CREATE TABLE IF NOT EXISTS service_versions (service TEXT NOT NULL, revision INTEGER NOT NULL, recorded_at INTEGER NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL, assertion TEXT NOT NULL, policy TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY(service,revision))',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS scheduler_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, slot INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL)',
    );
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
    this.evidence = new IncidentEvidence(ctx.storage);
    this.evidence.ensureSchema();
    this.budgets = new BudgetSignals(ctx.storage);
    this.budgets.ensureSchema();
  }
  /** Overridden only by the workerd test fixture; production uses wall-clock time. */
  protected now() {
    return Date.now();
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
      this.now(),
      action,
      service,
      JSON.stringify(detail),
    );
  }
  private recordVersion(
    target: MonitorTarget,
    revision: number,
    policy: MonitorPolicy,
    provenance: string,
  ) {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
      target.id,
      revision,
      this.now(),
      target.name,
      target.transport,
      target.assertion,
      JSON.stringify(policy),
      provenance,
    );
  }
  private scheduleEvent(slot: number, status: string, detail: unknown) {
    this.ctx.storage.sql.exec(
      'INSERT INTO scheduler_events(at,slot,status,detail) VALUES(?,?,?,?)',
      this.now(),
      slot,
      status,
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
            this.now(),
          );
          this.recordVersion(target, 1, defaultPolicy, 'recorded');
          this.event('service.created', target.id, { name: target.name });
        } else {
          this.recordVersion(
            JSON.parse(existing.target),
            existing.revision,
            JSON.parse(existing.policy),
            'recovered-current',
          );
          if (existing.target === JSON.stringify(target)) continue;
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
          this.recordVersion(
            target,
            existing.revision + 1,
            JSON.parse(existing.policy),
            'recorded',
          );
          this.event('service.target-updated', target.id, { revision: existing.revision + 1 });
        }
      }
    });
    return targets;
  }
  async fetch(request: Request): Promise<Response> {
    const targets = this.syncTargets();
    const activeIds = targets.map((target) => target.id);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/status')
      return reply(this.snapshot(targets, url.searchParams.get('window') === '7d' ? 10080 : 1440));
    if (request.method === 'GET' && url.pathname === '/ready') {
      const monitoring = this.readiness(targets);
      return reply(
        { ok: monitoring.status === 'healthy', monitoring },
        monitoring.status === 'healthy' ? 200 : 503,
      );
    }
    if (request.method === 'GET' && url.pathname.startsWith('/incidents/')) {
      const raw = url.searchParams.get('before');
      if (raw !== null && !/^\d+$/.test(raw))
        return reply({ error: 'before must be a nonnegative integer slot' }, 400);
      try {
        const detail = this.evidence.detail(
          url.pathname.slice('/incidents/'.length),
          activeIds,
          raw === null ? undefined : Number(raw),
          request.headers.get('X-Operator-Authorized') === 'true',
        );
        return detail ? reply(detail) : reply({ error: 'Incident not found' }, 404);
      } catch (error) {
        return reply({ error: (error as Error).message }, 400);
      }
    }
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
      const timing = classifyTick(Number(slot), this.now());
      if (typeof slot !== 'number' || timing.status === 'invalid')
        return reply({ error: 'Schedule outside current minute' }, 400);
      if (!timing.accepted) {
        this.scheduleEvent(slot, 'skipped-late', { reason: timing.reason });
        return reply({ slot, status: timing.status, results: [] });
      }
      this.scheduleEvent(slot, 'started', {});
      const results = await Promise.all(targets.map((target) => this.check(target, Number(slot))));
      // Evaluate finished-minute history once per scheduled run, never on dashboard reads.
      for (const target of targets) {
        const service = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
        const version = this.rows<{ recorded_at: number }>(
          'SELECT recorded_at FROM service_versions WHERE service=? AND revision=?',
          target.id,
          service.revision,
        )[0];
        this.budgets.update({
          service: target.id,
          revision: service.revision,
          policy: JSON.parse(service.policy),
          policyRecordedAt: version.recorded_at,
          now: this.now(),
        });
      }
      this.ctx.storage.transactionSync(() => {
        this.scheduleEvent(slot, 'completed', { results });
        const cutoff = this.now() - RETENTION;
        this.ctx.storage.sql.exec('DELETE FROM checks WHERE at < ?', cutoff);
        this.ctx.storage.sql.exec('DELETE FROM jobs WHERE slot < ?', Math.floor(cutoff / MINUTE));
        this.ctx.storage.sql.exec(
          'DELETE FROM incidents WHERE resolved IS NOT NULL AND resolved < ?',
          cutoff,
        );
        this.ctx.storage.sql.exec('DELETE FROM audit WHERE at < ?', cutoff);
        this.ctx.storage.sql.exec('DELETE FROM scheduler_events WHERE at < ?', cutoff);
        this.evidence.prune(cutoff);
        this.budgets.prune(cutoff, activeIds);
        this.ctx.storage.sql.exec(
          'DELETE FROM service_versions WHERE NOT EXISTS(SELECT 1 FROM checks WHERE checks.service=service_versions.service AND checks.revision=service_versions.revision) AND NOT EXISTS(SELECT 1 FROM services WHERE services.id=service_versions.service AND services.revision=service_versions.revision)',
        );
      });
      return reply({ slot, results });
    }
    if (url.pathname === '/incident-note') {
      const result = this.evidence.addNote(body, activeIds);
      return reply(result.data, result.status);
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
          this.recordVersion(
            targets.find((target) => target.id === service.id)!,
            service.revision + 1,
            policy,
            'recorded',
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
        if (!incident || !activeIds.includes(incident.service))
          return reply({ error: 'Incident not found' }, 404);
        if (incident.resolved) return reply({ error: 'Incident has already recovered' }, 409);
        if (incident.acknowledged) return reply({ ok: true, alreadyAcknowledged: true });
        this.ctx.storage.sql.exec(
          'UPDATE incidents SET acknowledged=?,note=? WHERE id=?',
          this.now(),
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
    const observedAt = this.now();
    if (!classifyTick(slot, observedAt).accepted)
      return { service: target.id, result: 'window-closed' };
    const claim = this.ctx.storage.transactionSync(() => {
      const service = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
      if (this.rows('SELECT slot FROM checks WHERE service=? AND slot=?', target.id, slot).length)
        return null;
      if (
        this.rows(
          'SELECT slot FROM jobs WHERE service=? AND done=0 AND lease>?',
          target.id,
          observedAt,
        ).length
      )
        return null;
      const token = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'INSERT INTO jobs VALUES(?,?,?,?,0) ON CONFLICT(service,slot) DO UPDATE SET token=excluded.token,lease=excluded.lease,done=0',
        target.id,
        slot,
        token,
        observedAt + 30000,
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
        'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
        target.id,
        slot,
        this.now(),
        result.outcome,
        result.status,
        result.latencyMs,
        current.revision,
        observedAt,
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
            this.now(),
          );
          this.event('incident.opened', target.id, {
            incident: state.incidentId,
            outcome: result.outcome,
          });
        } else if (next.change === 'resolve') {
          this.ctx.storage.sql.exec(
            'UPDATE incidents SET resolved=? WHERE id=?',
            this.now(),
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
  private readiness(targets: MonitorTarget[]) {
    const started = this.rows<{ at: number }>(
      "SELECT at FROM scheduler_events WHERE status='started' ORDER BY id DESC LIMIT 1",
    )[0];
    const completed = this.rows<{ at: number; slot: number }>(
      "SELECT at,slot FROM scheduler_events WHERE status='completed' ORDER BY id DESC LIMIT 1",
    )[0];
    return monitoringReadiness({
      now: this.now(),
      lastStartedAt: started?.at ?? null,
      lastCompletedAt: completed?.at ?? null,
      lastSlot: completed?.slot ?? null,
      services: targets.map((target) => {
        const row = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
        const latest = this.rows<{ observed_at: number | null; revision: number }>(
          'SELECT observed_at,revision FROM checks WHERE service=? ORDER BY slot DESC LIMIT 1',
          target.id,
        )[0];
        return {
          paused: (JSON.parse(row.policy) as MonitorPolicy).paused,
          lastObservedAt: latest?.revision === row.revision ? latest.observed_at : null,
        };
      }),
    });
  }
  private snapshot(targets: MonitorTarget[], minutes: number) {
    const now = this.now();
    const services = targets.map((target) => {
      const row = this.rows<ServiceRow>('SELECT * FROM services WHERE id=?', target.id)[0];
      const policy: MonitorPolicy = JSON.parse(row.policy);
      const state: MonitorState = JSON.parse(row.state);
      const latest =
        this.rows<CheckRow>(
          'SELECT service,slot,at,outcome,status,latency,revision,observed_at AS observedAt FROM checks WHERE service=? ORDER BY slot DESC LIMIT 1',
          target.id,
        )[0] ?? null;
      const bounds = windowBounds(row.created, now, minutes);
      const stats = this.rows<{
        total: number;
        observed: number;
        good: number;
        maintenance: number;
        unverified: number;
      }>(
        "SELECT COUNT(*) total, COALESCE(SUM(outcome!='maintenance' AND observed_at IS NOT NULL),0) observed, COALESCE(SUM(outcome='good' AND observed_at IS NOT NULL),0) good, COALESCE(SUM(outcome='maintenance' AND observed_at IS NOT NULL),0) maintenance, COALESCE(SUM(observed_at IS NULL),0) unverified FROM checks WHERE service=? AND slot BETWEEN ? AND ?",
        target.id,
        bounds.start,
        bounds.end,
      )[0];
      const p95 = stats.observed
        ? (this.rows<{ latency: number }>(
            "SELECT latency FROM checks WHERE service=? AND slot BETWEEN ? AND ? AND outcome!='maintenance' AND observed_at IS NOT NULL ORDER BY latency LIMIT 1 OFFSET ?",
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
              latest.observedAt === null ||
              latest.revision !== row.revision ||
              now - latest.observedAt > 180000 ||
              latest.observedAt > now
            ? 'unknown'
            : state.incidentId
              ? 'incident'
              : latest.outcome === 'good'
                ? 'healthy'
                : 'degraded',
        state,
        budget: this.budgets.read(target.id, row.revision, now),
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
          'SELECT service,slot,at,outcome,status,latency,revision,observed_at AS observedAt FROM checks WHERE service=? ORDER BY slot DESC LIMIT 60',
          target.id,
        ),
        hourly: this.rows(
          "SELECT CAST(slot/60 AS INTEGER)*3600000 AS at, COUNT(*) AS total, SUM(outcome='good' AND observed_at IS NOT NULL) AS good, SUM(outcome='maintenance' AND observed_at IS NOT NULL) AS maintenance, SUM(observed_at IS NULL) AS unverified FROM checks WHERE service=? AND slot BETWEEN ? AND ? GROUP BY CAST(slot/60 AS INTEGER) ORDER BY at",
          target.id,
          bounds.start,
          bounds.end,
        ),
      };
    });
    return {
      version: '3.2.0',
      now,
      window: minutes === 1440 ? '24h' : '7d',
      retentionDays: 30,
      cadenceSeconds: 60,
      services,
      monitoring: this.readiness(targets),
      scheduler: this.rows(
        'SELECT at,slot,status,detail FROM scheduler_events ORDER BY id DESC LIMIT 20',
      ).map((event) => ({ ...event, detail: JSON.parse(String(event.detail)) })),
      incidents: this.evidence.list(targets.map((target) => target.id)),
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
