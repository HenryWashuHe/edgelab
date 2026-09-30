import app from '../../worker/index';
import { MonitorStore as ClockMonitorStore } from './monitor-clock';
import type { MonitorEnv } from '../../worker/monitor';
export { ReliabilityLab } from '../../worker/index';

/** Test-only cursor accounting; never bundled into the deployed gateway. */
export class MonitorStore extends ClockMonitorStore {
  private readonly costCursors: { rowsRead: number; rowsWritten: number }[];
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    const cursors: { rowsRead: number; rowsWritten: number }[] = [];
    const sql = ctx.storage.sql;
    const execute = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = execute(query, ...bindings);
      cursors.push(cursor);
      return cursor;
    }) as typeof sql.exec;
    super(ctx, env);
    this.costCursors = cursors;
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/test-cost-reset') {
      this.costCursors.length = 0;
      return Response.json({ ok: true });
    }
    if (path === '/test-cost')
      return Response.json({
        statements: this.costCursors.length,
        rowsRead: this.costCursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
        rowsWritten: this.costCursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
      });
    return super.fetch(request);
  }
}
export default app;
