import gateway, {
  ReliabilityLab as ProductionLab,
  MonitorStore as ProductionMonitor,
} from '../../worker/index';
import type { LabEvent, LabState } from '../../worker/engine';
import { LAB_ADMISSION_LANE_KEY } from '../../worker/lab-admission';

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
let runtimeSource = emptySourceMeter();
let labConstructors = 0;
let monitorProbeInvocations = emptyNativeInvocations();
/** Monitor source work stays outside Lab meters; its origin call still delegates. */
export class MonitorStore extends ProductionMonitor {
  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    const origin = new Proxy(env.ORIGIN, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'fetch')
          return async (...args: unknown[]) => {
            monitorProbeInvocations.originFetch++;
            monitorProbeInvocations.originInFlight++;
            try {
              const response = await Reflect.apply(value, target, args);
              monitorProbeInvocations.originCompleted++;
              return response;
            } catch (error) {
              monitorProbeInvocations.originFailed++;
              throw error;
            } finally {
              monitorProbeInvocations.originInFlight--;
            }
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, ORIGIN: origin });
  }
}
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
    labConstructors++;
    const diagnostics = { sql: emptySql(), operations: emptyOperations() };
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    const kvGet = ctx.storage.kv.get.bind(ctx.storage.kv);
    const getAlarm = ctx.storage.getAlarm.bind(ctx.storage);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      source.sql.attemptedStatements++;
      runtimeSource.sql.attemptedStatements++;
      let cursor: ReturnType<typeof execute>;
      let rows: Record<string, SqlStorageValue>[];
      try {
        cursor = execute(query, ...bindings);
        // Consume RETURNING and trigger work before measuring. Production then
        // receives the same real results through the cursor's normal interfaces.
        rows = cursor.toArray();
      } catch (error) {
        source.sql.failedStatements++;
        runtimeSource.sql.failedStatements++;
        throw error;
      }
      source.sql.statements++;
      runtimeSource.sql.statements++;
      source.sql.rowsRead += cursor.rowsRead;
      runtimeSource.sql.rowsRead += cursor.rowsRead;
      source.sql.rowsWritten += cursor.rowsWritten;
      runtimeSource.sql.rowsWritten += cursor.rowsWritten;
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
          runtimeSource.operations[counter]++;
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
          runtimeSource.operations[counter]++;
          return Reflect.apply(original, ctx.storage, args);
        },
      });
    }
    const transactionSync = ctx.storage.transactionSync.bind(ctx.storage);
    ctx.storage.transactionSync = ((callback: () => unknown) => {
      source.operations.transactionSync++;
      runtimeSource.operations.transactionSync++;
      try {
        return transactionSync(callback);
      } catch (error) {
        source.operations.transactionSyncFailed++;
        runtimeSource.operations.transactionSyncFailed++;
        throw error;
      }
    }) as typeof ctx.storage.transactionSync;

    const origin = new Proxy(env.ORIGIN, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'fetch')
          return async (...args: unknown[]) => {
            source.nativeInvocations.originFetch++;
            runtimeSource.nativeInvocations.originFetch++;
            source.nativeInvocations.originInFlight++;
            runtimeSource.nativeInvocations.originInFlight++;
            try {
              const response = await Reflect.apply(value, target, args);
              // HTTP 503 is a resolved native fetch, not a rejected invocation.
              source.nativeInvocations.originCompleted++;
              runtimeSource.nativeInvocations.originCompleted++;
              return response;
            } catch (error) {
              source.nativeInvocations.originFailed++;
              runtimeSource.nativeInvocations.originFailed++;
              throw error;
            } finally {
              source.nativeInvocations.originInFlight--;
              runtimeSource.nativeInvocations.originInFlight--;
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
    runtimeSource.labFetchesInFlight++;
    try {
      return await super.fetch(request);
    } finally {
      this.source.labFetchesInFlight--;
      runtimeSource.labFetchesInFlight--;
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

type LocalLane = 'owner' | 'observer';
type LocalFault = 'native' | 'missing' | 'throw' | 'malformed';
let localFaults: Record<LocalLane, LocalFault> = { owner: 'native', observer: 'native' };
let settingOverride: { active: boolean; value?: string } = { active: false };
let nativeAdmission = { owner: 0, observer: 0 };
let controlledFaultCalls = 0;
function observedAdmission(binding: unknown, lane: LocalLane) {
  const fault = localFaults[lane];
  if (fault === 'missing') return undefined;
  if (fault !== 'native')
    return {
      limit: async () => {
        controlledFaultCalls++;
        if (fault === 'throw') throw new Error('local-admission-private-error-canary');
        return { success: 'true', privateDetail: 'local-admission-private-error-canary' };
      },
    };
  if (!binding || typeof binding !== 'object') return binding;
  return new Proxy(binding, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'limit')
        return (...args: unknown[]) => {
          nativeAdmission[lane]++;
          if (JSON.stringify(args) !== JSON.stringify([{ key: LAB_ADMISSION_LANE_KEY }]))
            throw new Error('Unexpected local admission key shape');
          return Reflect.apply(value, target, args);
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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

/** Shared by real fetch and narrow local scheduled-handler invocation. */
function meteredEnv(env: GatewayEnv): GatewayEnv {
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
  return {
    ...env,
    LABS: labs,
    LAB_ADMISSION_ENABLED: settingOverride.active
      ? settingOverride.value
      : env.LAB_ADMISSION_ENABLED,
    LAB_OWNER_LIMITER: observedAdmission(env.LAB_OWNER_LIMITER, 'owner'),
    LAB_OBSERVER_LIMITER: observedAdmission(env.LAB_OBSERVER_LIMITER, 'observer'),
  };
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
    if (path === '/__fixture/admission-meter' && request.method === 'GET')
      return Response.json({
        gateway: gatewayMeter,
        labConstructors,
        lab: runtimeSource,
        nativeAdmission,
        controlledFaultCalls,
        monitorProbeInvocations,
      });
    if (path === '/__fixture/admission-reset' && request.method === 'POST') {
      if (
        gatewayInFlight ||
        runtimeSource.labFetchesInFlight ||
        runtimeSource.nativeInvocations.originInFlight ||
        monitorProbeInvocations.originInFlight
      )
        return Response.json({ error: 'Fixture source is busy' }, { status: 409 });
      gatewayMeter = emptyGatewayMeter();
      runtimeSource = emptySourceMeter();
      labConstructors = 0;
      nativeAdmission = { owner: 0, observer: 0 };
      controlledFaultCalls = 0;
      monitorProbeInvocations = emptyNativeInvocations();
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/admission-fault' && request.method === 'POST') {
      const body = (await request.json()) as { lane?: LocalLane; mode?: LocalFault };
      if (
        !['owner', 'observer'].includes(body.lane ?? '') ||
        !['native', 'missing', 'throw', 'malformed'].includes(body.mode ?? '')
      )
        return Response.json({ error: 'Invalid local fault control' }, { status: 400 });
      localFaults[body.lane!] = body.mode!;
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/admission-setting' && request.method === 'POST') {
      const body = (await request.json()) as { mode?: string };
      if (!['native', 'undefined', 'false', 'true', 'malformed'].includes(body.mode ?? ''))
        return Response.json({ error: 'Invalid local setting control' }, { status: 400 });
      settingOverride = {
        active: body.mode !== 'native',
        value:
          body.mode === 'undefined' ? undefined : body.mode === 'malformed' ? 'TRUE' : body.mode,
      };
      return Response.json({ ok: true });
    }
    if (path === '/__fixture/scheduled-current' && request.method === 'POST') {
      // Invoke the unchanged real handler with the actual current UTC time.
      // This is a local event control, not a deployed Cron Trigger simulation.
      gatewayInFlight++;
      try {
        await gateway.scheduled(
          { scheduledTime: Date.now(), cron: '* * * * *', noRetry() {} },
          meteredEnv(env),
        );
        return Response.json({ ok: true });
      } finally {
        gatewayInFlight--;
      }
    }
    if (path.startsWith('/__fixture/'))
      return Response.json({ error: 'Unknown fixture operation' }, { status: 404 });
    gatewayMeter.gatewayRequests++;
    gatewayInFlight++;
    try {
      return await gateway.fetch(request, meteredEnv(env));
    } finally {
      gatewayInFlight--;
    }
  },
};
