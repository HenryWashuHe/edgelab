import { DurableObject } from 'cloudflare:workers';
import app from '../../worker/index';
import { MonitorStore as ClockMonitorStore } from './monitor-clock';
import type { MonitorEnv } from '../../worker/monitor';
import { IncidentEvidence, MAX_ORPHAN_NOTE_CANDIDATES } from '../../worker/incident-evidence';
import {
  MAX_VERSION_RETENTION_CANDIDATES,
  MonitorVersionRetention,
} from '../../worker/monitor-version-retention';
import { captureBriefEvidence } from '../../worker/incident-brief-domain';
import type { IncidentDetail } from '../../worker/incident-evidence';
export { ReliabilityLab } from '../../worker/index';

type Statement = { query: string; args?: SqlStorageValue[] };
type CursorCost = { query: string; rowsRead: number; rowsWritten: number };

/** Fault inside the real MonitorStore cleanup transaction, after SQL executes. */
export class MonitorStore extends ClockMonitorStore {
  private fault: string | null = null;
  private completedOnly = false;
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    super(ctx, env);
    const execute = ctx.storage.sql.exec.bind(ctx.storage.sql);
    ctx.storage.sql.exec = ((query: string, ...args: SqlStorageValue[]) => {
      const cursor = execute(query, ...args);
      if (
        this.fault !== null &&
        query.includes(this.fault) &&
        (!this.completedOnly || args[2] === 'completed')
      ) {
        // RETURNING must finish synchronously before this injected late fault;
        // otherwise the test would interrupt an active cursor before deletion.
        cursor.toArray();
        this.fault = null;
        throw new Error('Injected local MonitorStore cleanup failure after SQL execution');
      }
      return cursor;
    }) as typeof ctx.storage.sql.exec;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture/arm') {
      const { contains, completedOnly } = (await request.json()) as {
        contains: string;
        completedOnly?: boolean;
      };
      this.fault = contains;
      this.completedOnly = completedOnly ?? false;
      return Response.json({ ok: true });
    }
    try {
      return await super.fetch(request);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  }
}

/** Local-only actual SQLite fixture. No account, deployed data, or AI binding. */
export class RetentionFixture extends DurableObject {
  private readonly versions: MonitorVersionRetention;
  private readonly notes: IncidentEvidence;
  private readonly cursors: CursorCost[] = [];
  private fault: string | null = null;
  private initializationFailure: string | null = null;

  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY,name TEXT NOT NULL,target TEXT NOT NULL,policy TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,created INTEGER NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS checks (service TEXT NOT NULL,slot INTEGER NOT NULL,at INTEGER NOT NULL,outcome TEXT NOT NULL,status INTEGER,latency INTEGER NOT NULL,revision INTEGER NOT NULL,observed_at INTEGER,PRIMARY KEY(service,slot))',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS checks_policy_version ON checks(service,revision)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS service_versions (service TEXT NOT NULL,revision INTEGER NOT NULL,recorded_at INTEGER NOT NULL,name TEXT NOT NULL,transport TEXT NOT NULL,assertion TEXT NOT NULL,policy TEXT NOT NULL,provenance TEXT NOT NULL,PRIMARY KEY(service,revision))',
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY,service TEXT NOT NULL,opened INTEGER NOT NULL,resolved INTEGER,acknowledged INTEGER,note TEXT NOT NULL DEFAULT '')",
    );
    sql.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(service) WHERE resolved IS NULL',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,action TEXT NOT NULL,service TEXT NOT NULL,detail TEXT NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_retention_mode (id INTEGER PRIMARY KEY CHECK(id=1),automatic INTEGER NOT NULL,fault TEXT)',
    );
    const mode = sql
      .exec<{ automatic: number; fault: string | null }>(
        'SELECT automatic,fault FROM fixture_retention_mode WHERE id=1',
      )
      .toArray()[0];
    this.fault = mode?.fault ?? null;
    const execute = sql.exec.bind(sql);
    sql.exec = ((query: string, ...args: SqlStorageValue[]) => {
      const cursor = execute(query, ...args);
      this.cursors.push({
        query,
        get rowsRead() {
          return cursor.rowsRead;
        },
        get rowsWritten() {
          return cursor.rowsWritten;
        },
      });
      // Throw after SQLite executed the real statement. The helper's actual
      // transaction must undo its mutations, not simply refuse to start them.
      if (this.fault !== null && query.includes(this.fault))
        throw new Error('Injected local retention failure after SQL execution');
      return cursor;
    }) as typeof sql.exec;
    this.versions = new MonitorVersionRetention(ctx.storage);
    this.notes = new IncidentEvidence(ctx.storage);
    if (mode?.automatic) {
      try {
        this.versions.ensureSchema();
        this.notes.ensureSchema();
      } catch (error) {
        // Keep test-only inspection usable after a constructor migration fault.
        this.initializationFailure = (error as Error).message;
      }
    }
  }

  private cost() {
    return {
      statements: this.cursors.length,
      rowsRead: this.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      rowsWritten: this.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    };
  }

  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const body = (await request.json()) as Statement & {
      statements?: Statement[];
      cutoff?: number;
      automatic?: boolean;
      fault?: string | null;
      which?: 'versions' | 'notes' | 'all';
      activeIds?: string[];
      detail?: IncidentDetail;
      now?: number;
    };
    this.cursors.length = 0;
    try {
      if (path === '/mode') {
        // Persisted fixture controls survive eviction but are not production APIs.
        this.fault = null;
        this.ctx.storage.sql.exec(
          'INSERT INTO fixture_retention_mode VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET automatic=excluded.automatic,fault=excluded.fault',
          body.automatic ? 1 : 0,
          body.fault ?? null,
        );
        this.fault = body.fault ?? null;
        return Response.json({ ok: true });
      }
      if (path === '/exec') {
        const cursor = this.ctx.storage.sql.exec(body.query, ...(body.args ?? []));
        const rows = cursor.toArray();
        return Response.json({ rows, ...this.cost() });
      }
      if (path === '/transaction') {
        this.ctx.storage.transactionSync(() => {
          for (const statement of body.statements ?? [])
            this.ctx.storage.sql.exec(statement.query, ...(statement.args ?? [])).toArray();
        });
        return Response.json({ ok: true, ...this.cost() });
      }
      if (path === '/schema') {
        if (body.which !== 'notes') this.versions.ensureSchema();
        if (body.which !== 'versions') this.notes.ensureSchema();
        this.initializationFailure = null;
        return Response.json({ ok: true, ...this.cost() });
      }
      if (path === '/prune') {
        const summary = this.versions.prune();
        return Response.json({
          ok: true,
          bound: MAX_VERSION_RETENTION_CANDIDATES,
          summary,
          ...this.cost(),
        });
      }
      if (path === '/notes-prune') {
        const summary = this.ctx.storage.transactionSync(() => this.notes.prune(body.cutoff!));
        return Response.json({
          ok: true,
          bound: MAX_ORPHAN_NOTE_CANDIDATES,
          summary,
          ...this.cost(),
        });
      }
      if (path === '/read') {
        const incidents = this.notes.list(body.activeIds ?? []);
        return Response.json({ incidents, ...this.cost() });
      }
      if (path === '/state')
        return Response.json({ initializationFailure: this.initializationFailure });
      if (path === '/capture')
        return Response.json(await captureBriefEvidence(body.detail!, body.now!));
      return new Response('Unknown local fixture route', { status: 404 });
    } catch (error) {
      return Response.json({ error: (error as Error).message, ...this.cost() }, { status: 500 });
    }
  }
}

export default app;
