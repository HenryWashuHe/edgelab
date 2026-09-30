import { DurableObject } from 'cloudflare:workers';
import { MonitorCheckCache, MONITOR_CHECK_CACHE_SLOTS } from '../../worker/monitor-check-cache';
import { IncidentEvidence } from '../../worker/incident-evidence';

/** Isolated workerd fixture; no production routes, bindings, or inference. */
export class CheckCacheFixture extends DurableObject {
  private readonly cache: MonitorCheckCache;
  private readonly incidents: IncidentEvidence;
  private incidentRowsRead = 0;
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS checks (service TEXT NOT NULL, slot INTEGER NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, status INTEGER, latency INTEGER NOT NULL, revision INTEGER NOT NULL, observed_at INTEGER, PRIMARY KEY(service,slot))',
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY,service TEXT NOT NULL,opened INTEGER NOT NULL,resolved INTEGER,acknowledged INTEGER,note TEXT NOT NULL DEFAULT '')",
    );
    // Track the real cursors consumed by IncidentEvidence without changing its
    // production API or replacing SQLite with a mocked query implementation.
    const trackedSql = {
      exec: (query: string, ...args: SqlStorageValue[]) => {
        const cursor = ctx.storage.sql.exec(query, ...args);
        return {
          toArray: () => {
            const rows = cursor.toArray();
            this.incidentRowsRead += cursor.rowsRead;
            return rows;
          },
        };
      },
    };
    this.incidents = new IncidentEvidence({ sql: trackedSql } as unknown as DurableObjectStorage);
    this.incidents.ensureSchema();
    this.cache = new MonitorCheckCache(ctx.storage);
    this.cache.ensureSchema();
  }
  async fetch(request: Request) {
    const body = (await request.json()) as {
      service: string;
      end: number;
      count: number;
      nested?: boolean;
      query: string;
      args?: SqlStorageValue[];
      activeIds: string[];
    };
    const action = new URL(request.url).pathname;
    const sql = this.ctx.storage.sql;
    if (action === '/seed') {
      sql.exec(
        "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT OR IGNORE INTO checks SELECT ?,?-n,(?-n)*60000+1020,'good',200,20,1,(?-n)*60000+1000 FROM seq",
        body.count - 1,
        body.service,
        body.end,
        body.end,
        body.end,
      );
      return Response.json({ ok: true });
    }
    if (action === '/read') {
      const read = () => this.cache.read(body.service, body.end);
      const checks = body.nested ? this.ctx.storage.transactionSync(read) : read();
      return Response.json({ checks, diagnostics: this.cache.lastRead });
    }
    if (action === '/source') {
      const cursor = sql.exec(
        'SELECT service,slot,at,outcome,status,latency,revision,observed_at AS observedAt FROM checks WHERE service=? AND slot BETWEEN ? AND ? ORDER BY slot',
        body.service,
        Math.max(0, body.end - MONITOR_CHECK_CACHE_SLOTS + 1),
        body.end,
      );
      const checks = cursor.toArray();
      return Response.json({ checks, rowsRead: cursor.rowsRead });
    }
    if (action === '/exec') {
      const cursor = sql.exec(body.query, ...(body.args ?? []));
      const rows = cursor.toArray();
      return Response.json({ rows, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten });
    }
    if (action === '/invalidate') {
      this.cache.invalidateAll();
      return Response.json({ ok: true });
    }
    if (action === '/prune') {
      this.cache.prune(body.activeIds);
      return Response.json({ ok: true });
    }
    if (action === '/incidents') {
      this.incidentRowsRead = 0;
      const incidents = this.incidents.list(body.activeIds);
      return Response.json({ incidents, rowsRead: this.incidentRowsRead });
    }
    if (action === '/incident-schema') {
      this.incidents.ensureSchema();
      return Response.json({ ok: true });
    }
    return new Response('Unknown fixture action', { status: 404 });
  }
}
export default { fetch: () => new Response('Isolated cache fixture') };
