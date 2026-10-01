import gateway, { ReliabilityLab as ProductionLab } from '../../worker/index';
import type { LabEvent, LabState } from '../../worker/engine';
export { MonitorStore } from '../../worker/index';

type GatewayEnv = Parameters<typeof gateway.fetch>[1];
type SqlMeter = {
  attemptedStatements: number;
  statements: number;
  failedStatements: number;
  rowsRead: number;
  rowsWritten: number;
};
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
  transactionSync: number;
  transactionSyncFailed: number;
};
type NativeInvocations = {
  originFetch: number;
  originCompleted: number;
  originFailed: number;
  originInFlight: number;
};
type SourceMeter = {
  sql: SqlMeter;
  operations: Operations;
  nativeInvocations: NativeInvocations;
  labFetchesInFlight: number;
};
const emptySql = (): SqlMeter => ({
  attemptedStatements: 0,
  statements: 0,
  failedStatements: 0,
  rowsRead: 0,
  rowsWritten: 0,
});
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
  transactionSync: 0,
  transactionSyncFailed: 0,
});
const emptyNativeInvocations = (): NativeInvocations => ({
  originFetch: 0,
  originCompleted: 0,
  originFailed: 0,
  originInFlight: 0,
});
const emptySourceMeter = (): SourceMeter => ({
  sql: emptySql(),
  operations: emptyOperations(),
  nativeInvocations: emptyNativeInvocations(),
  labFetchesInFlight: 0,
});

/**
 * Local-only meter. Every source statement, transaction, binding fetch and alarm
 * delegates to the native runtime. Counters are API observations, not account
 * billing totals; KV and alarm work is reported separately from SQL cursors.
 */
export class ReliabilityLab extends ProductionLab {
  private readonly source: SourceMeter;
  private readonly diagnostics: { sql: SqlMeter; operations: Operations };
  private readonly native: {
    execute: SqlStorage['exec'];
    kvGet: DurableObjectStorage['kv']['get'];
    getAlarm: DurableObjectStorage['getAlarm'];
  };
  private readonly bootId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    const source = emptySourceMeter();
    const diagnostics = { sql: emptySql(), operations: emptyOperations() };
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    const kvGet = ctx.storage.kv.get.bind(ctx.storage.kv);
    const getAlarm = ctx.storage.getAlarm.bind(ctx.storage);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      source.sql.attemptedStatements++;
      let cursor: ReturnType<typeof execute>;
      let rows: Record<string, SqlStorageValue>[];
      try {
        cursor = execute(query, ...bindings);
        // Consume RETURNING and trigger work before measuring. Production then
        // receives the same real results through the cursor's normal interfaces.
        rows = cursor.toArray();
      } catch (error) {
        source.sql.failedStatements++;
        throw error;
      }
      source.sql.statements++;
      source.sql.rowsRead += cursor.rowsRead;
      source.sql.rowsWritten += cursor.rowsWritten;
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
          source.operations[counter]++;
          return Reflect.apply(original, kv, args);
        },
      });
    }
    for (const [method, counter] of [
      ['get', 'storageGet'],
      ['put', 'storagePut'],
      ['delete', 'storageDelete'],
      ['list', 'storageList'],
      ['deleteAll', 'storageDeleteAll'],
      ['getAlarm', 'alarmGet'],
      ['setAlarm', 'alarmSet'],
      ['deleteAlarm', 'alarmDelete'],
    ] as const) {
      const original = ctx.storage[method].bind(ctx.storage);
      Object.assign(ctx.storage, {
        [method]: (...args: unknown[]) => {
          source.operations[counter]++;
          return Reflect.apply(original, ctx.storage, args);
        },
      });
    }
    const transactionSync = ctx.storage.transactionSync.bind(ctx.storage);
    ctx.storage.transactionSync = ((callback: () => unknown) => {
      source.operations.transactionSync++;
      try {
        return transactionSync(callback);
      } catch (error) {
        source.operations.transactionSyncFailed++;
        throw error;
      }
    }) as typeof ctx.storage.transactionSync;

    const origin = new Proxy(env.ORIGIN, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'fetch')
          return async (...args: unknown[]) => {
            source.nativeInvocations.originFetch++;
            source.nativeInvocations.originInFlight++;
            try {
              const response = await Reflect.apply(value, target, args);
              // HTTP 503 is a resolved native fetch, not a rejected invocation.
              source.nativeInvocations.originCompleted++;
              return response;
            } catch (error) {
              source.nativeInvocations.originFailed++;
              throw error;
            } finally {
              source.nativeInvocations.originInFlight--;
            }
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, ORIGIN: origin });
    this.source = source;
    this.diagnostics = diagnostics;
    this.native = { execute, kvGet, getAlarm };
  }

  private diagnosticRows<T extends Record<string, SqlStorageValue>>(query: string): T[] {
    this.diagnostics.sql.attemptedStatements++;
    try {
      const cursor = this.native.execute<T>(query);
      const rows = cursor.toArray();
      this.diagnostics.sql.statements++;
      this.diagnostics.sql.rowsRead += cursor.rowsRead;
      this.diagnostics.sql.rowsWritten += cursor.rowsWritten;
      return rows;
    } catch (error) {
      this.diagnostics.sql.failedStatements++;
      throw error;
    }
  }

  private meter() {
    return {
      bootId: this.bootId,
      sql: { ...this.source.sql, failedCursorCost: null },
      operations: { ...this.source.operations },
      nativeInvocations: { ...this.source.nativeInvocations },
      labFetchesInFlight: this.source.labFetchesInFlight,
      diagnostics: {
        sql: { ...this.diagnostics.sql, failedCursorCost: null },
        operations: { ...this.diagnostics.operations },
      },
    };
  }

  private busy() {
    return this.source.labFetchesInFlight > 0 || this.source.nativeInvocations.originInFlight > 0;
  }

  private async inspect(): Promise<Response> {
    if (this.busy()) return Response.json({ error: 'Fixture source is busy' }, { status: 409 });
    const stateRows = this.diagnosticRows<{ id: number; value: string }>(
      'SELECT id,value FROM state ORDER BY id',
    );
    const eventRows = this.diagnosticRows<{ id: number; value: string }>(
      'SELECT id,value FROM events ORDER BY id',
    );
    this.diagnostics.operations.kvGet++;
    const expiresAt = this.native.kvGet<number>('expiresAt') ?? null;
    this.diagnostics.operations.alarmGet++;
    const alarmAt = await this.native.getAlarm();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ state: stateRows, events: eventRows, expiresAt, alarmAt }),
    );
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sourceHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const state = stateRows[0] ? (JSON.parse(stateRows[0].value) as LabState) : null;
    // The control returns only explicit safe fields. The opaque hash includes
    // full source strings for exact eviction parity without exposing payloads.
    return Response.json({
      bootId: this.bootId,
      sourceHash,
      state: state
        ? {
            revision: state.revision ?? null,
            committedAt: state.committedAt ?? null,
            config: {
              capacity: state.config.capacity,
              refillPerSecond: state.config.refillPerSecond,
              failureThreshold: state.config.failureThreshold,
              cooldownMs: state.config.cooldownMs,
              originLatencyMs: state.config.originLatencyMs,
              originTimeoutMs: state.config.originTimeoutMs,
              staleFallback: state.config.staleFallback,
              originMode: state.config.originMode,
            },
            tokens: state.tokens,
            updatedAt: state.updatedAt,
            circuit: state.circuit,
            generation: state.generation,
            failures: state.failures,
            openedAt: state.openedAt,
            probeDeadline: state.probeDeadline,
            cachedAt: state.cachedAt,
            cachePresent: state.cachedPayload !== null,
            originCalls: state.originCalls,
            total: state.total,
            counts: {
              origin: state.counts.origin,
              stale: state.counts.stale,
              limited: state.counts.limited,
              blocked: state.counts.blocked,
              error: state.counts.error,
            },
          }
        : null,
      events: eventRows.map(({ id, value }) => {
        const event = JSON.parse(value) as LabEvent;
        return {
          id,
          at: event.at,
          latencyMs: event.latencyMs,
          outcome: event.outcome,
          status: event.status,
          circuit: event.circuit,
          originAttempted: event.originAttempted,
        };
      }),
      eventCount: eventRows.length,
      expiresAt,
      alarmAt,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__fixture/')) {
      if (path === '/__fixture/meter' && request.method === 'GET')
        return Response.json(this.meter());
      if (path === '/__fixture/meter-reset' && request.method === 'POST') {
        if (this.busy()) return Response.json({ error: 'Fixture source is busy' }, { status: 409 });
        this.source.sql = emptySql();
        this.source.operations = emptyOperations();
        this.source.nativeInvocations = emptyNativeInvocations();
        return Response.json({ ok: true });
      }
      if (path === '/__fixture/inspect' && request.method === 'GET') return this.inspect();
      return Response.json({ error: 'Unknown fixture operation' }, { status: 404 });
    }
    this.source.labFetchesInFlight++;
    try {
      return await super.fetch(request);
    } finally {
      this.source.labFetchesInFlight--;
    }
  }
}

type GatewayMeter = {
  gatewayRequests: number;
  namespaceIdFromName: number;
  namespaceGet: number;
  namespaceGetByName: number;
  stubFetch: number;
  stubCompleted: number;
  stubFailed: number;
  stubInFlight: number;
};
const emptyGatewayMeter = (): GatewayMeter => ({
  gatewayRequests: 0,
  namespaceIdFromName: 0,
  namespaceGet: 0,
  namespaceGetByName: 0,
  stubFetch: 0,
  stubCompleted: 0,
  stubFailed: 0,
  stubInFlight: 0,
});
let gatewayMeter = emptyGatewayMeter();
let gatewayInFlight = 0;

function meteredStub(stub: DurableObjectStub): DurableObjectStub {
  return new Proxy(stub, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'fetch')
        return async (...args: unknown[]) => {
          gatewayMeter.stubFetch++;
          gatewayMeter.stubInFlight++;
          try {
            const response = await Reflect.apply(value, target, args);
            gatewayMeter.stubCompleted++;
            return response;
          } catch (error) {
            gatewayMeter.stubFailed++;
            throw error;
          } finally {
            gatewayMeter.stubInFlight--;
          }
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** All controls and instrumentation exist only in this local fixture bundle. */
export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/__fixture/gateway-meter' && request.method === 'GET')
      return Response.json({ ...gatewayMeter });
    if (path === '/__fixture/gateway-meter-reset' && request.method === 'POST') {
      if (gatewayInFlight > 0 || gatewayMeter.stubInFlight > 0)
        return Response.json({ error: 'Fixture gateway is busy' }, { status: 409 });
      gatewayMeter = emptyGatewayMeter();
      return Response.json({ ok: true });
    }
    if (path.startsWith('/__fixture/'))
      return Response.json({ error: 'Unknown fixture operation' }, { status: 404 });
    gatewayMeter.gatewayRequests++;
    const labs = new Proxy(env.LABS, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'idFromName')
          return (...args: unknown[]) => {
            gatewayMeter.namespaceIdFromName++;
            return Reflect.apply(value, target, args);
          };
        if (property === 'get' || property === 'getByName')
          return (...args: unknown[]) => {
            if (property === 'get') gatewayMeter.namespaceGet++;
            else gatewayMeter.namespaceGetByName++;
            return meteredStub(Reflect.apply(value, target, args));
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    gatewayInFlight++;
    try {
      return await gateway.fetch(request, { ...env, LABS: labs });
    } finally {
      gatewayInFlight--;
    }
  },
};
