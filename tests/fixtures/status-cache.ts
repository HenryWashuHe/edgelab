import app from '../../worker/index';
import { MonitorStore as ProductionMonitorStore, type MonitorEnv } from '../../worker/monitor';
export { ReliabilityLab } from '../../worker/index';

type Cost = { query: string; rowsRead: number; rowsWritten: number };
type Operations = {
  kvGet: number;
  kvPut: number;
  kvDelete: number;
  kvList: number;
  storageGet: number;
  storagePut: number;
  storageDelete: number;
  storageList: number;
  storageDeleteAll: number;
  alarmGet: number;
  alarmSet: number;
  alarmDelete: number;
};
const emptyOperations = (): Operations => ({
  kvGet: 0,
  kvPut: 0,
  kvDelete: 0,
  kvList: 0,
  storageGet: 0,
  storagePut: 0,
  storageDelete: 0,
  storageList: 0,
  storageDeleteAll: 0,
  alarmGet: 0,
  alarmSet: 0,
  alarmDelete: 0,
});

/** Local-only instrumentation; every cursor and transaction is real workerd SQLite. */
export class MonitorStore extends ProductionMonitorStore {
  private clock: number | undefined;
  private readonly meter: {
    cursors: Cost[];
    operations: Operations;
    fault: { contains: string; completedOnly: boolean; native: boolean } | null;
    fired: number;
    attemptedStatements: number;
    failedStatements: number;
    nativeFaultsFired: number;
  };
  private readonly bootId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    const meter = {
      cursors: [] as Cost[],
      operations: emptyOperations(),
      fault: null as { contains: string; completedOnly: boolean; native: boolean } | null,
      fired: 0,
      attemptedStatements: 0,
      failedStatements: 0,
      nativeFaultsFired: 0,
    };
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    sql.exec = ((query: string, ...args: SqlStorageValue[]) => {
      meter.attemptedStatements++;
      let cursor: ReturnType<typeof execute>;
      try {
        cursor = execute(query, ...args);
      } catch (error) {
        meter.failedStatements++;
        throw error;
      }
      // Execute RETURNING/trigger effects to completion before measurement or
      // injected error; the real transaction must undo any resulting writes.
      const rows = cursor.toArray();
      meter.cursors.push({ query, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten });
      if (
        meter.fault &&
        query.includes(meter.fault.contains) &&
        (!meter.fault.completedOnly || args[2] === 'completed')
      ) {
        const native = meter.fault.native;
        meter.fault = null;
        meter.fired++;
        if (native) {
          // The selected statement and triggers really completed. Now invoke
          // the captured original API: its native SQLite exception must cause
          // the production transaction to roll those effects back. A failed
          // attempt has no cursor, so never invent rowsRead/rowsWritten for it.
          meter.attemptedStatements++;
          try {
            execute('SELECT 1 FROM __fixture_missing_native_sql_table').toArray();
          } catch (error) {
            meter.failedStatements++;
            if (
              String(error).includes('no such table') &&
              String(error).includes('__fixture_missing_native_sql_table')
            )
              meter.nativeFaultsFired++;
            throw error;
          }
          throw new Error('Expected actual native missing-table failure');
        }
        throw new Error('Injected executed SQLite failure: fixture-private-storage-canary');
      }
      return new Proxy(cursor, {
        get(target, property) {
          if (property === 'toArray') return () => rows.slice();
          if (property === 'one')
            return () => {
              if (rows.length !== 1) throw new Error('Expected exactly one real SQL result');
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
      ['list', 'kvList'],
    ] as const) {
      const original = kv[method].bind(kv);
      Object.assign(kv, {
        [method]: (...args: unknown[]) => {
          meter.operations[counter]++;
          return Reflect.apply(original, kv, args);
        },
      });
    }
    // Cover the legacy storage aliases too; no SQL/KV API can silently evade a
    // zero-work assertion. Counts describe invoked APIs, never billed units.
    for (const [method, counter] of [
      ['get', 'storageGet'],
      ['put', 'storagePut'],
      ['delete', 'storageDelete'],
      ['list', 'storageList'],
      ['deleteAll', 'storageDeleteAll'],
    ] as const) {
      const original = ctx.storage[method].bind(ctx.storage);
      Object.assign(ctx.storage, {
        [method]: (...args: unknown[]) => {
          meter.operations[counter]++;
          return Reflect.apply(original, ctx.storage, args);
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
          meter.operations[counter]++;
          return Reflect.apply(original, ctx.storage, args);
        },
      });
    }
    super(ctx, env);
    this.meter = meter;
  }

  protected override now() {
    return this.clock ?? Date.now();
  }

  private cost() {
    return {
      bootId: this.bootId,
      statements: this.meter.cursors.length,
      rowsRead: this.meter.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      rowsWritten: this.meter.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
      operations: { ...this.meter.operations },
      faultsFired: this.meter.fired,
      attemptedStatements: this.meter.attemptedStatements,
      failedStatements: this.meter.failedStatements,
      nativeFaultsFired: this.meter.nativeFaultsFired,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__fixture/cost') return Response.json(this.cost());
    if (path === '/__fixture/reset-cost') {
      this.meter.cursors.length = 0;
      this.meter.operations = emptyOperations();
      this.meter.fired = 0;
      this.meter.attemptedStatements = 0;
      this.meter.failedStatements = 0;
      this.meter.nativeFaultsFired = 0;
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/clock') {
      const body = (await request.json()) as { now?: number; invalid?: string };
      this.clock = body.invalid === 'nan' ? NaN : body.invalid === 'infinity' ? Infinity : body.now;
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/targets') {
      const body = (await request.json()) as { raw: string };
      this.env.MONITOR_TARGETS = body.raw;
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/arm') {
      const body = (await request.json()) as {
        contains: string;
        completedOnly?: boolean;
        native?: boolean;
      };
      this.meter.fault = {
        contains: body.contains,
        completedOnly: body.completedOnly ?? false,
        native: body.native ?? false,
      };
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/sql') {
      const body = (await request.json()) as {
        statements: { query: string; args?: SqlStorageValue[] }[];
      };
      const results = this.ctx.storage.transactionSync(() =>
        body.statements.map(({ query, args }) =>
          this.ctx.storage.sql.exec(query, ...(args ?? [])).toArray(),
        ),
      );
      return Response.json({ results });
    }
    return super.fetch(request);
  }
}

export default app;
