import gateway, { ReliabilityLab as ProductionLab } from '../../worker/index';
export { MonitorStore } from '../../worker/index';

type GatewayEnv = Parameters<typeof gateway.fetch>[1];
type TerminalKind = 'unavailable' | 'expired';
type Inspection = {
  enabled: boolean;
  action: string;
  saves: number;
  faultConfig: boolean;
  storageFaults: number;
  nativeSaveExecuted: boolean;
  selectedJoinedAt: number | null;
  terminalKind: TerminalKind | null;
  sendFailures: number;
  selectedOpenAtFailure: boolean;
  selectedSendAttempts: number;
  healthySendAttempts: number;
  selectedCloseAttempts: number;
  healthyCloseAttempts: number;
};

/** Local-only interposition: real SQL, native socket membership and native close. */
export class ReliabilityLab extends ProductionLab {
  private readonly inspection: Inspection;
  private readonly nativeSockets: DurableObjectState['getWebSockets'];
  private readonly bootId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: GatewayEnv) {
    const inspection: Inspection = {
      enabled: true,
      action: '',
      saves: 0,
      faultConfig: false,
      storageFaults: 0,
      nativeSaveExecuted: false,
      selectedJoinedAt: null,
      terminalKind: null,
      sendFailures: 0,
      selectedOpenAtFailure: false,
      selectedSendAttempts: 0,
      healthySendAttempts: 0,
      selectedCloseAttempts: 0,
      healthyCloseAttempts: 0,
    };
    const nativeSockets = ctx.getWebSockets.bind(ctx);
    Object.assign(ctx, {
      getWebSockets: (...args: Parameters<DurableObjectState['getWebSockets']>) =>
        nativeSockets(...args).map(
          (socket) =>
            new Proxy(socket, {
              get(target, property) {
                const selected =
                  target.deserializeAttachment()?.joinedAt === inspection.selectedJoinedAt;
                if (property === 'send')
                  return (message: string | ArrayBuffer | ArrayBufferView) => {
                    let terminal = false;
                    if (typeof message === 'string') {
                      const parsed = JSON.parse(message) as { kind?: string };
                      terminal = parsed.kind === inspection.terminalKind;
                    }
                    if (terminal) {
                      if (selected) inspection.selectedSendAttempts++;
                      else inspection.healthySendAttempts++;
                      if (selected && inspection.sendFailures === 0) {
                        inspection.sendFailures++;
                        inspection.selectedOpenAtFailure = target.readyState === WebSocket.OPEN;
                        throw new Error('Controlled terminal send failure');
                      }
                    }
                    return target.send(message);
                  };
                if (property === 'close')
                  return (code?: number, reason?: string) => {
                    if (inspection.terminalKind !== null) {
                      if (selected) inspection.selectedCloseAttempts++;
                      else inspection.healthyCloseAttempts++;
                    }
                    return target.close(code, reason);
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
        ),
    });
    const sql = ctx.storage.sql;
    const nativeExec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = nativeExec(query, ...bindings);
      const rows = cursor.toArray();
      if (inspection.enabled && query.startsWith('INSERT INTO state ')) {
        inspection.saves++;
        if (inspection.action === 'config' && inspection.saves === 2 && inspection.faultConfig) {
          inspection.faultConfig = false;
          inspection.storageFaults++;
          inspection.nativeSaveExecuted = true;
          throw new Error('Controlled storage failure. fixture-private-delivery-detail');
        }
      }
      return new Proxy(cursor, {
        get(target, property) {
          if (property === 'toArray') return () => rows.slice();
          if (property === 'one')
            return () => {
              if (rows.length !== 1) throw new Error('Expected one fixture SQL row');
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
    super(ctx, env);
    this.inspection = inspection;
    this.nativeSockets = nativeSockets;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__fixture/')) {
      this.inspection.enabled = false;
      try {
        if (path === '/__fixture/arm') {
          const body = (await request.json()) as { kind?: TerminalKind };
          if (body.kind !== 'unavailable' && body.kind !== 'expired')
            return Response.json({ error: 'Invalid fixture control' }, { status: 400 });
          const sockets = this.nativeSockets();
          const joined = sockets.map((socket) => socket.deserializeAttachment()?.joinedAt);
          if (sockets.length !== 2 || joined.some((value) => !Number.isSafeInteger(value)))
            return Response.json({ error: 'Invalid fixture membership' }, { status: 409 });
          if (new Set(joined).size !== 2)
            return Response.json({ error: 'Ambiguous fixture recipient' }, { status: 409 });
          this.inspection.selectedJoinedAt = Math.min(...joined);
          this.inspection.terminalKind = body.kind;
          this.inspection.faultConfig = body.kind === 'unavailable';
          return Response.json({ ok: true });
        }
        if (path === '/__fixture/deadline') {
          const body = (await request.json()) as { expiresAt?: number };
          if (!Number.isSafeInteger(body.expiresAt) || body.expiresAt! <= Date.now())
            return Response.json({ error: 'Invalid fixture deadline' }, { status: 400 });
          this.ctx.storage.kv.put('expiresAt', body.expiresAt);
          await this.ctx.storage.setAlarm(body.expiresAt!);
          return Response.json({ ok: true });
        }
        if (path === '/__fixture/inspect') {
          const tables = this.ctx.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('state','events')",
            )
            .toArray()
            .map(({ name }) => name);
          const sockets = this.nativeSockets();
          return Response.json({
            bootId: this.bootId,
            state: tables.includes('state')
              ? this.ctx.storage.sql.exec('SELECT value FROM state WHERE id=1').toArray()
              : [],
            events: tables.includes('events')
              ? this.ctx.storage.sql.exec('SELECT id,value FROM events ORDER BY id').toArray()
              : [],
            expiresAt: this.ctx.storage.kv.get('expiresAt') ?? null,
            alarmAt: await this.ctx.storage.getAlarm(),
            attachments: sockets.map((socket) => socket.deserializeAttachment()),
            openSockets: sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
            socketMembership: sockets.length,
            delivery: {
              sendFailures: this.inspection.sendFailures,
              selectedOpenAtFailure: this.inspection.selectedOpenAtFailure,
              selectedSendAttempts: this.inspection.selectedSendAttempts,
              healthySendAttempts: this.inspection.healthySendAttempts,
              selectedCloseAttempts: this.inspection.selectedCloseAttempts,
              healthyCloseAttempts: this.inspection.healthyCloseAttempts,
              storageFaults: this.inspection.storageFaults,
              nativeSaveExecuted: this.inspection.nativeSaveExecuted,
            },
          });
        }
        return Response.json({ error: 'Unknown fixture control' }, { status: 404 });
      } finally {
        this.inspection.enabled = true;
      }
    }
    this.inspection.action = path.split('/').pop() ?? '';
    this.inspection.saves = 0;
    return super.fetch(request);
  }
}

export default gateway;
