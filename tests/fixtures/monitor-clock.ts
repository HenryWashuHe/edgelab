import app, { MonitorStore as ProductionMonitorStore } from '../../worker/index';
import type { MonitorEnv } from '../../worker/monitor';
export { ReliabilityLab } from '../../worker/index';

/** Test-only clock lives in SQLite so eviction exercises the same timeline. */
export class MonitorStore extends ProductionMonitorStore {
  constructor(ctx: DurableObjectState, env: MonitorEnv) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_clock (at INTEGER NOT NULL)');
    super(ctx, env);
  }
  protected override now() {
    const row = this.ctx.storage.sql
      .exec<{ at: number }>('SELECT at FROM test_clock LIMIT 1')
      .toArray()[0];
    return row?.at ?? Date.now();
  }
  override async fetch(request: Request): Promise<Response> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_clock (at INTEGER NOT NULL)');
    if (new URL(request.url).pathname === '/test-clock') {
      const { now } = (await request.json()) as { now: number };
      if (!Number.isSafeInteger(now) || now < 0)
        return new Response('Invalid clock', { status: 400 });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM test_clock');
        this.ctx.storage.sql.exec('INSERT INTO test_clock VALUES(?)', now);
      });
      return new Response('ok');
    }
    return super.fetch(request);
  }
}
export default app;
