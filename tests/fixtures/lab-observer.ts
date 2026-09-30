import gateway, { ReliabilityLab as ProductionLab } from '../../worker/index';
export { MonitorStore } from '../../worker/index';

type GatewayEnv = Parameters<typeof gateway.fetch>[1];
type FaultStage =
  | 'owner-save'
  | 'owner-alarm'
  | 'owner-alarm-after'
  | 'config-save'
  | 'admission-save'
  | 'completion-save'
  | 'event-insert'
  | 'observer-read';
type FaultReason = 'generic' | 'read-quota' | 'write-quota';
type Fault = { stage: FaultStage; reason: FaultReason };
type CursorCost = { rowsRead: number; rowsWritten: number };
type Operations = {
  kvGet: number;
  kvPut: number;
  kvDelete: number;
  alarmGet: number;
  alarmSet: number;
  alarmDelete: number;
};
const emptyOperations = (): Operations => ({
  kvGet: 0,
  kvPut: 0,
  kvDelete: 0,
  alarmGet: 0,
  alarmSet: 0,
  alarmDelete: 0,
});
const privateFault = (reason: FaultReason) =>
  new Error(
    (reason === 'read-quota'
      ? 'Exceeded allowed rows read in Durable Objects free tier. '
      : reason === 'write-quota'
        ? 'Exceeded allowed rows written in Durable Objects free tier. '
        : 'Injected storage failure. ') + 'fixture-private-observer-storage-detail',
  );

/**
 * Test-only instrumentation of real storage. The production class still owns
 * transactionSync, alarms, socket acceptance and hibernation; none is simulated.
 */
export class ReliabilityLab extends ProductionLab {
  private readonly inspection: {
    enabled: boolean;
    cursors: CursorCost[];
    operations: Operations;
    fault: Fault | null;
    action: string;
    saves: number;
    faultsFired: number;
    observerHeaderNames: string[];
  };
  private readonly fixtureBootId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    const inspection = {
      enabled: true,
      cursors: [] as CursorCost[],
      operations: emptyOperations(),
      fault: null as Fault | null,
      action: '',
      saves: 0,
      faultsFired: 0,
      observerHeaderNames: [] as string[],
    };
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = execute(query, ...bindings);
      // Finish actual SQL, including RETURNING and all trigger effects, before
      // accounting or throwing. Replay consumed rows for the application's API.
      const rows = cursor.toArray();
      if (inspection.enabled) inspection.cursors.push(cursor);
      if (query.startsWith('INSERT INTO state ')) inspection.saves++;
      const fault = inspection.fault;
      const fire =
        inspection.enabled &&
        fault &&
        ((fault.stage === 'observer-read' &&
          inspection.action === 'observe' &&
          query.startsWith('SELECT value FROM state ')) ||
          (query.startsWith('INSERT INTO state ') &&
            ((fault.stage === 'owner-save' && inspection.saves === 1) ||
              (fault.stage === 'config-save' &&
                inspection.action === 'config' &&
                inspection.saves === 2) ||
              (fault.stage === 'admission-save' &&
                inspection.action === 'request' &&
                inspection.saves === 2) ||
              (fault.stage === 'completion-save' &&
                inspection.action === 'request' &&
                inspection.saves === 3))) ||
          (fault.stage === 'event-insert' &&
            inspection.action === 'request' &&
            query.startsWith('INSERT INTO events')));
      if (fire) {
        inspection.fault = null;
        inspection.faultsFired++;
        throw privateFault(fault.reason);
      }
      return new Proxy(cursor, {
        get(target, property) {
          if (property === 'toArray') return () => rows.slice();
          if (property === 'one')
            return () => {
              if (rows.length !== 1) throw new Error('Expected exactly one SQL result row');
              return rows[0];
            };
          if (property === Symbol.iterator) return () => rows[Symbol.iterator]();
          if (property === 'raw')
            return function* () {
              for (const row of rows) yield target.columnNames.map((name) => row[name]);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof sql.exec;
    const kv = ctx.storage.kv;
    for (const [method, counter] of [
      ['get', 'kvGet'],
      ['put', 'kvPut'],
      ['delete', 'kvDelete'],
    ] as const) {
      const original = kv[method].bind(kv);
      Object.assign(kv, {
        [method]: (...args: unknown[]) => {
          if (inspection.enabled) inspection.operations[counter]++;
          return Reflect.apply(original, kv, args);
        },
      });
    }
    for (const [method, counter] of [
      ['getAlarm', 'alarmGet'],
      ['setAlarm', 'alarmSet'],
      ['deleteAlarm', 'alarmDelete'],
    ] as const) {
      const original = ctx.storage[method].bind(ctx.storage);
      Object.assign(ctx.storage, {
        [method]: (...args: unknown[]) => {
          if (inspection.enabled) inspection.operations[counter]++;
          if (
            inspection.enabled &&
            method === 'setAlarm' &&
            (inspection.fault?.stage === 'owner-alarm' ||
              inspection.fault?.stage === 'owner-alarm-after')
          ) {
            const stage = inspection.fault.stage;
            const reason = inspection.fault.reason;
            inspection.fault = null;
            inspection.faultsFired++;
            if (stage === 'owner-alarm-after')
              return Promise.resolve(Reflect.apply(original, ctx.storage, args)).then(() => {
                throw privateFault(reason);
              });
            // This counts an attempted invocation, without an awaited native
            // storage flush. The runtime may reset unconfirmed storage work.
            throw privateFault(reason);
          }
          return Reflect.apply(original, ctx.storage, args);
        },
      });
    }
    super(ctx, env);
    this.inspection = inspection;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__fixture/')) {
      this.inspection.enabled = false;
      try {
        if (path === '/__fixture/meter-reset') {
          this.inspection.cursors.length = 0;
          this.inspection.operations = emptyOperations();
          return Response.json({ ok: true });
        }
        if (path === '/__fixture/meter')
          return Response.json({
            sql: {
              statements: this.inspection.cursors.length,
              rowsRead: this.inspection.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
              rowsWritten: this.inspection.cursors.reduce(
                (sum, cursor) => sum + cursor.rowsWritten,
                0,
              ),
            },
            operations: this.inspection.operations,
            faultsFired: this.inspection.faultsFired,
          });
        if (path === '/__fixture/arm') {
          const body = (await request.json()) as Fault;
          if (
            ![
              'owner-save',
              'owner-alarm',
              'owner-alarm-after',
              'config-save',
              'admission-save',
              'completion-save',
              'event-insert',
              'observer-read',
            ].includes(body.stage) ||
            !['generic', 'read-quota', 'write-quota'].includes(body.reason)
          )
            return Response.json({ error: 'Invalid fixture fault' }, { status: 400 });
          this.inspection.fault = body;
          return Response.json({ ok: true });
        }
        if (path === '/__fixture/deadline') {
          const body = (await request.json()) as { expiresAt: number; alarmAt?: number };
          this.ctx.storage.kv.put('expiresAt', body.expiresAt);
          await this.ctx.storage.setAlarm(body.alarmAt ?? body.expiresAt);
          return Response.json({ ok: true });
        }
        if (path === '/__fixture/clear-deadline') {
          this.ctx.storage.kv.delete('expiresAt');
          await this.ctx.storage.deleteAlarm();
          return Response.json({ ok: true });
        }
        if (path === '/__fixture/inspect') {
          const tables = this.ctx.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('state','events')",
            )
            .toArray()
            .map(({ name }) => name);
          return Response.json({
            bootId: this.fixtureBootId,
            state: tables.includes('state')
              ? this.ctx.storage.sql.exec('SELECT value FROM state WHERE id=1').toArray()
              : [],
            events: tables.includes('events')
              ? this.ctx.storage.sql.exec('SELECT id,value FROM events ORDER BY id').toArray()
              : [],
            expiresAt: this.ctx.storage.kv.get('expiresAt') ?? null,
            alarmAt: await this.ctx.storage.getAlarm(),
            attachments: this.ctx.getWebSockets().map((socket) => socket.deserializeAttachment()),
            socketStates: this.ctx.getWebSockets().map((socket) => socket.readyState),
            observerHeaderNames: this.inspection.observerHeaderNames,
          });
        }
        return Response.json({ error: 'Unknown fixture operation' }, { status: 404 });
      } finally {
        this.inspection.enabled = true;
      }
    }
    this.inspection.action = path.split('/').pop() ?? '';
    if (this.inspection.action === 'observe')
      this.inspection.observerHeaderNames = [...request.headers.keys()].sort();
    this.inspection.saves = 0;
    return super.fetch(request);
  }
}

let namespaceCalls = 0;
/** Routes exist in this fixture only, never in the deployed gateway. */
export default {
  async fetch(request: Request, env: GatewayEnv) {
    const path = new URL(request.url).pathname;
    if (path === '/__fixture/gateway') {
      if (request.method === 'POST') namespaceCalls = 0;
      return Response.json({ namespaceCalls });
    }
    const labs = new Proxy(env.LABS, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (['idFromName', 'get', 'getByName'].includes(String(property)))
          return (...args: unknown[]) => {
            namespaceCalls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return gateway.fetch(request, { ...env, LABS: labs });
  },
};
