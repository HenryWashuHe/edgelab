import gateway, {
  ReliabilityLab as ProductionLab,
  MonitorStore as ProductionMonitor,
} from '../../worker/index';

let calls = 0;
type GatewayEnv = Parameters<typeof gateway.fetch>[1];
type FixtureEnv = GatewayEnv & {
  FIXTURE_REAL_LAB?: string;
  FIXTURE_REAL_MONITOR?: string;
  FIXTURE_CONFIG_FAILURE?: 'read' | 'write';
};

type MonitorFault = 'policy-read' | 'policy-write' | 'incident-read';
/** Test-only injection after target synchronization, not a production fault API. */
export class MonitorStore extends ProductionMonitor {
  private readonly injection: {
    next: MonitorFault | null;
    active: MonitorFault | null;
    serviceReads: number;
    policyWrites: number;
    incidentReads: number;
    fired: number;
  };
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    const injection = {
      next: null as MonitorFault | null,
      active: null as MonitorFault | null,
      serviceReads: 0,
      policyWrites: 0,
      incidentReads: 0,
      fired: 0,
    };
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      if (injection.active && query.startsWith('SELECT * FROM services WHERE id=')) {
        injection.serviceReads++;
        // One configured target is read by syncTargets before the policy read.
        if (injection.active === 'policy-read' && injection.serviceReads === 2) {
          injection.fired++;
          throw new Error(
            'Exceeded allowed rows read in Durable Objects free tier. fixture-private-monitor-detail',
          );
        }
      }
      if (
        injection.active === 'incident-read' &&
        query.startsWith('SELECT * FROM incidents WHERE id=')
      ) {
        injection.incidentReads++;
        injection.fired++;
        throw new Error(
          'Exceeded allowed rows read in Durable Objects free tier. fixture-private-monitor-detail',
        );
      }
      const cursor = execute(query, ...bindings);
      if (injection.active === 'policy-write' && query.startsWith('UPDATE services SET policy=')) {
        injection.policyWrites++;
        injection.fired++;
        // SQLite actually changes the row first: transaction rollback must undo
        // policy, revision and streak changes when this exception propagates.
        throw new Error(
          'Exceeded allowed rows written in Durable Objects free tier. fixture-private-monitor-detail',
        );
      }
      return cursor;
    }) as typeof sql.exec;
    super(ctx, env);
    this.injection = injection;
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__fixture/arm') {
      const body = (await request.json()) as { mode: MonitorFault };
      if (!['policy-read', 'policy-write', 'incident-read'].includes(body.mode))
        return Response.json({ error: 'Unknown fixture fault' }, { status: 400 });
      this.injection.next = body.mode;
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/sql') return Response.json(this.injection);
    this.injection.active = this.injection.next;
    this.injection.next = null;
    this.injection.serviceReads = this.injection.policyWrites = this.injection.incidentReads = 0;
    try {
      return await super.fetch(request);
    } finally {
      this.injection.active = null;
    }
  }
}

/** Actual Lab/SQLite with a fault inside the configuration transaction only. */
export class ReliabilityLab extends ProductionLab {
  private readonly injection: {
    armed: 'read' | 'write' | null;
    reads: number;
    writes: number;
    fired: number;
  };
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    const injection = { armed: null as 'read' | 'write' | null, reads: 0, writes: 0, fired: 0 };
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      if (injection.armed && query.startsWith('SELECT value FROM state ')) {
        injection.reads++;
        // The first read belongs to touch(); the second is inside config.
        if (injection.armed === 'read' && injection.reads === 2) {
          injection.fired++;
          throw new Error(
            'Exceeded allowed rows read in Durable Objects free tier. fixture-private-storage-detail',
          );
        }
      }
      const cursor = execute(query, ...bindings);
      if (injection.armed && query.startsWith('INSERT INTO state ')) {
        injection.writes++;
        // Throw after SQLite executes the second save, proving that the caller
        // rolls the actual mutation back rather than merely refusing a write.
        if (injection.armed === 'write' && injection.writes === 2) {
          injection.fired++;
          throw new Error(
            'Exceeded allowed rows written in Durable Objects free tier. fixture-private-storage-detail',
          );
        }
      }
      return cursor;
    }) as typeof sql.exec;
    super(ctx, env);
    this.injection = injection;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__fixture/sql') return Response.json(this.injection);
    this.injection.armed =
      new URL(request.url).pathname === '/api/config' &&
      request.headers.get('X-Fixture-Fail') === 'true'
        ? ((this.env as FixtureEnv).FIXTURE_CONFIG_FAILURE ?? null)
        : null;
    this.injection.reads = 0;
    this.injection.writes = 0;
    try {
      return await super.fetch(request);
    } finally {
      this.injection.armed = null;
    }
  }
}

/** Isolated runtime fixture: the namespace simulates a failing storage connection. */
export default {
  async fetch(request: Request, env: FixtureEnv) {
    if (new URL(request.url).pathname === '/__fixture/state')
      return Response.json({ fixture: 'LOCAL STORAGE FAILURE TEST', calls });
    if (env.FIXTURE_REAL_LAB === 'true' || env.FIXTURE_REAL_MONITOR === 'true')
      return gateway.fetch(request, env);
    const namespace = {
      idFromName: () => 'fixture-only',
      get: () => ({
        async fetch() {
          calls++;
          throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
        },
      }),
    } as unknown as GatewayEnv['MONITORS'];
    return gateway.fetch(request, {
      ...env,
      MONITORS: namespace,
      LABS: namespace as unknown as GatewayEnv['LABS'],
    });
  },
};
