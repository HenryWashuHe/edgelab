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
import { IncidentEvidence, type IncidentPolicyVersion } from './incident-evidence';
import { classifyTick, monitoringReadiness } from './monitor-readiness';
import { BudgetSignals } from './budget-signals';
import { IncidentBriefs } from './incident-briefs';
import { MonitorCheckCache } from './monitor-check-cache';
import { MonitorVersionRetention } from './monitor-version-retention';
import {
  parseSchedulerDetail,
  publicSchedulerDetail,
  readCleanupRecord,
  type MetadataCleanup,
} from './metadata-cleanup';
export interface MonitorEnv {
  MONITORS: DurableObjectNamespace<MonitorStore>;
  ORIGIN: Fetcher;
  MONITOR_TARGETS?: string;
  OPERATOR_TOKEN?: string;
  AI?: Ai;
  AI_BRIEFS_ENABLED?: string;
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
type SchedulerEventRow = { at: number; slot: number; status: string; detail: string };
const reply = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
export class MonitorStore extends DurableObject<MonitorEnv> {
  private evidence: IncidentEvidence;
  private budgets: BudgetSignals;
  private briefs: IncidentBriefs;
  private checkCache: MonitorCheckCache;
  private versionRetention: MonitorVersionRetention;
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
    sql.exec('CREATE INDEX IF NOT EXISTS checks_policy_version ON checks(service,revision)');
    this.checkCache = new MonitorCheckCache(ctx.storage);
    this.checkCache.ensureSchema();
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
        // Keep projection invalidation atomic with the legacy timing reset.
        this.checkCache.invalidateAll();
      });
    }
    sql.exec(
      'CREATE TABLE IF NOT EXISTS service_versions (service TEXT NOT NULL, revision INTEGER NOT NULL, recorded_at INTEGER NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL, assertion TEXT NOT NULL, policy TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY(service,revision))',
    );
    this.versionRetention = new MonitorVersionRetention(ctx.storage);
    this.versionRetention.ensureSchema();
    sql.exec(
      'CREATE TABLE IF NOT EXISTS scheduler_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, slot INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS jobs (service TEXT NOT NULL, slot INTEGER NOT NULL, token TEXT NOT NULL, lease INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(service, slot))',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(slot)');
    sql.exec('CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(service,lease) WHERE done=0');
    sql.exec(
      "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, service TEXT NOT NULL, opened INTEGER NOT NULL, resolved INTEGER, acknowledged INTEGER, note TEXT NOT NULL DEFAULT '')",
    );
    sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(service) WHERE resolved IS NULL',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS incidents_retention ON incidents(resolved)');
    sql.exec('CREATE INDEX IF NOT EXISTS scheduler_events_retention ON scheduler_events(at)');
    sql.exec('CREATE INDEX IF NOT EXISTS scheduler_events_status ON scheduler_events(status,id)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, service TEXT NOT NULL, detail TEXT NOT NULL)',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS audit_retention ON audit(at)');
    this.evidence = new IncidentEvidence(ctx.storage);
    this.evidence.ensureSchema();
    this.budgets = new BudgetSignals(ctx.storage, this.checkCache);
    this.budgets.ensureSchema();
    this.briefs = new IncidentBriefs(ctx.storage, () => this.now());
    this.briefs.ensureSchema();
    sql.exec('CREATE INDEX IF NOT EXISTS incident_briefs_retention ON incident_briefs(created_at)');
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
    const briefAI = this.env.AI_BRIEFS_ENABLED === 'true' ? this.env.AI : undefined;
    if (request.method === 'GET' && url.pathname === '/status')
      return reply(this.snapshot(targets, url.searchParams.get('window') === '7d' ? 10080 : 1440));
    if (request.method === 'GET' && url.pathname === '/ready') {
      const monitoring = this.readiness(targets);
      return reply(
        { ok: monitoring.status === 'healthy', monitoring },
        monitoring.status === 'healthy' ? 200 : 503,
      );
    }
    const incidentBriefs = /^\/incidents\/([0-9a-f-]{36})\/briefs$/i.exec(url.pathname);
    const briefDetail = /^\/incident-briefs\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (incidentBriefs || briefDetail || url.pathname === '/incident-brief') {
      if (request.headers.get('X-Operator-Authorized') !== 'true')
        return reply({ error: 'Operator token required' }, 401);
      if (request.method === 'GET' && incidentBriefs) {
        const result = this.briefs.list(incidentBriefs[1], activeIds, this.now(), Boolean(briefAI));
        return reply(result.data, result.status);
      }
      if (request.method === 'GET' && briefDetail) {
        const result = this.briefs.read(briefDetail[1], activeIds, this.now());
        return reply(result.data, result.status);
      }
      if (request.method === 'POST' && url.pathname === '/incident-brief') {
        const result = await this.briefs.generate(
          await request.json(),
          activeIds,
          this.now(),
          briefAI,
        );
        return reply(result.data, result.status);
      }
      return reply({ error: 'Method not allowed' }, 405);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/incidents/')) {
      const raw = url.searchParams.get('before');
      const before = raw === null ? undefined : Number(raw);
      if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(before)))
        return reply({ error: 'before must be a nonnegative integer slot' }, 400);
      const detail = this.evidence.detail(
        url.pathname.slice('/incidents/'.length),
        activeIds,
        before,
        request.headers.get('X-Operator-Authorized') === 'true',
      );
      return detail ? reply(detail) : reply({ error: 'Incident not found' }, 404);
    }
    if (request.method === 'GET' && url.pathname === '/audit') {
      // An explicit authenticated audit read can inspect private cleanup counts.
      // Status/export use only their existing latest-20 public event query.
      const completed = this.rows<Omit<SchedulerEventRow, 'status'>>(
        "SELECT at,slot,detail FROM scheduler_events WHERE status='completed' ORDER BY id DESC LIMIT 1",
      )[0];
      return reply({
        events: this.rows('SELECT * FROM audit ORDER BY id DESC LIMIT 100').map((r) => ({
          ...r,
          detail: JSON.parse(String(r.detail)),
        })),
        incidents: this.rows<IncidentRow>('SELECT * FROM incidents ORDER BY opened DESC LIMIT 100'),
        lastCleanup: completed
          ? readCleanupRecord({
              at: completed.at,
              slot: completed.slot,
              cleanup: (parseSchedulerDetail(completed.detail) as { cleanup?: unknown } | null)
                ?.cleanup,
            })
          : null,
      });
    }
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
        const version = this.rows<
          Omit<IncidentPolicyVersion, 'recordedAt' | 'policy'> & {
            recorded_at: number;
            policy: string;
          }
        >(
          'SELECT * FROM service_versions WHERE service=? AND revision=?',
          target.id,
          service.revision,
        )[0];
        this.budgets.update({
          service: target.id,
          revision: service.revision,
          policy: JSON.parse(service.policy),
          policyRecordedAt: version.recorded_at,
          policyContext: {
            service: version.service,
            revision: version.revision,
            recordedAt: version.recorded_at,
            name: version.name,
            transport: version.transport,
            assertion: version.assertion,
            policy: JSON.parse(version.policy),
            provenance: version.provenance,
          },
          now: this.now(),
        });
      }
      this.ctx.storage.transactionSync(() => {
        const cutoff = this.now() - RETENTION;
        this.ctx.storage.sql.exec('DELETE FROM checks WHERE at < ?', cutoff);
        this.ctx.storage.sql.exec('DELETE FROM jobs WHERE slot < ?', Math.floor(cutoff / MINUTE));
        this.evidence.pruneResolvedNotes(cutoff);
        this.ctx.storage.sql.exec(
          'DELETE FROM incidents WHERE resolved IS NOT NULL AND resolved < ?',
          cutoff,
        );
        this.ctx.storage.sql.exec('DELETE FROM audit WHERE at < ?', cutoff);
        this.ctx.storage.sql.exec('DELETE FROM scheduler_events WHERE at < ?', cutoff);
        const orphanNotes = this.evidence.prune(cutoff);
        this.budgets.prune(cutoff, activeIds);
        this.briefs.prune(cutoff, activeIds);
        this.checkCache.prune(activeIds);
        const versions = this.versionRetention.prune();
        // Publication shares the cleanup transaction. Failed deletions, queue
        // progress or this final event write cannot leave a success receipt.
        this.scheduleEvent(slot, 'completed', {
          results,
          cleanup: { schemaVersion: 1, cutoff, versions, orphanNotes } satisfies MetadataCleanup,
        });
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
      return this.ctx.storage.transactionSync(() => {
        const service = this.rows<ServiceRow>(
          'SELECT * FROM services WHERE id=?',
          String(body.service),
        )[0];
        if (service.revision !== body.revision)
          return reply({ error: 'Policy changed. Refresh before saving.' }, 409);
        const previous: MonitorPolicy = JSON.parse(service.policy);
        let policy: MonitorPolicy;
        try {
          policy = validatePolicy(body.policy, previous);
        } catch (error) {
          return reply({ error: (error as Error).message }, 400);
        }
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
          before: previous,
          after: policy,
          revision: service.revision + 1,
        });
        return reply({ ok: true, revision: service.revision + 1 });
      });
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
      const windowChecks = this.checkCache
        .read(target.id, bounds.end)
        .filter((check) => check.slot >= bounds.start);
      const stats = { total: 0, observed: 0, good: 0, maintenance: 0, unverified: 0 };
      const latencies: number[] = [];
      const byHour = new Map<
        number,
        { at: number; total: number; good: number; maintenance: number; unverified: number }
      >();
      for (const check of windowChecks) {
        stats.total++;
        const hour = Math.floor(check.slot / 60) * 3600000;
        let hourly = byHour.get(hour);
        if (!hourly) {
          hourly = { at: hour, total: 0, good: 0, maintenance: 0, unverified: 0 };
          byHour.set(hour, hourly);
        }
        hourly.total++;
        if (check.observedAt === null) {
          stats.unverified++;
          hourly.unverified++;
        } else if (check.outcome === 'maintenance') {
          stats.maintenance++;
          hourly.maintenance++;
        } else {
          stats.observed++;
          latencies.push(check.latency);
          if (check.outcome === 'good') {
            stats.good++;
            hourly.good++;
          }
        }
      }
      latencies.sort((left, right) => left - right);
      const p95 = stats.observed ? latencies[Math.ceil(stats.observed * 0.95) - 1] : null;
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
        hourly: [...byHour.values()].sort((left, right) => left.at - right.at),
      };
    });
    return {
      version: '3.4.2',
      now,
      window: minutes === 1440 ? '24h' : '7d',
      retentionDays: 30,
      cadenceSeconds: 60,
      services,
      monitoring: this.readiness(targets),
      scheduler: this.rows<SchedulerEventRow>(
        'SELECT at,slot,status,detail FROM scheduler_events ORDER BY id DESC LIMIT 20',
      ).map(({ at, slot, status, detail }) => ({
        at,
        slot,
        status,
        detail: publicSchedulerDetail(status, parseSchedulerDetail(detail), { at, slot }),
      })),
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
