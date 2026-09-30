import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

const MINUTE = 60000;
const RETENTION = 30 * 24 * 60 * MINUTE;
const samples = [];
await build({
  entryPoints: ['tests/fixtures/monitor-cost.ts'],
  outfile: 'output/monitor-cost-worker/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});

for (const targetCount of [2, 5]) {
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    id: `service-${index}`,
    name: `Service ${index}`,
    url: 'https://origin.internal/health',
    transport: 'origin',
    assertion: 'ok-json',
  }));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: 'output/monitor-cost-worker/index.js',
          compatibilityDate: '2026-09-01',
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: { MONITOR_TARGETS: JSON.stringify(targets) },
          serviceBindings: { ORIGIN: async () => Response.json({ ok: true }) },
        },
      ],
    }),
  );
  try {
    const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
    const stub = ns.get(ns.idFromName('operations'));
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 1000;
    const end = Math.floor(now / MINUTE) - 1;
    const clock = async (at) => {
      const response = await stub.fetch('https://monitor.internal/test-clock', {
        method: 'POST',
        body: JSON.stringify({ now: at }),
      });
      assert.equal(response.status, 200);
    };
    const tick = async (at) => {
      await clock(at);
      const response = await stub.fetch('https://monitor.internal/tick', {
        method: 'POST',
        body: JSON.stringify({ slot: Math.floor(at / MINUTE) }),
      });
      assert.equal(response.status, 200);
      await response.json();
    };
    const cost = async (action) => {
      await stub.fetch('https://monitor.internal/test-cost-reset', { method: 'POST' });
      const result = await action();
      const response = await stub.fetch('https://monitor.internal/test-cost');
      return { ...(await response.json()), result };
    };
    await clock(now);
    await (await mf.dispatchFetch('https://edgelab.example/api/ops/status')).json();
    const storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
      name: 'operations',
    });
    for (const target of targets) {
      await storage.exec(
        'UPDATE services SET created=? WHERE id=?',
        (end - 10079) * MINUTE,
        target.id,
      );
      await storage.exec(
        'UPDATE service_versions SET recorded_at=? WHERE service=?',
        (end - 10079) * MINUTE,
        target.id,
      );
      for (let batch = end - 10079; batch <= end; batch += 12) {
        const slots = Array.from(
          { length: Math.min(12, end - batch + 1) },
          (_, offset) => batch + offset,
        );
        await storage.exec(
          `INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES ${slots.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
          ...slots.flatMap((slot) => [
            target.id,
            slot,
            slot * MINUTE + 1020,
            'good',
            200,
            20,
            1,
            slot * MINUTE + 1000,
          ]),
        );
        await storage.exec(
          `INSERT INTO jobs VALUES ${slots.map(() => '(?,?,?,?,?)').join(',')}`,
          ...slots.flatMap((slot) => [
            target.id,
            slot,
            'finished-fixture',
            slot * MINUTE + 30000,
            1,
          ]),
        );
      }
      // One check/job expires per subsequent minute, simulating steady-state
      // retention without manufacturing thirty days of unrelated test history.
      for (let step = 0; step < 4; step++) {
        const slot = Math.floor((now - RETENTION) / MINUTE) - 1 + step;
        await storage.exec(
          'INSERT INTO checks VALUES(?,?,?,?,?,?,?,?)',
          target.id,
          slot,
          slot * MINUTE + 1020,
          'good',
          200,
          20,
          1,
          slot * MINUTE + 1000,
        );
        await storage.exec(
          'INSERT INTO jobs VALUES(?,?,?,?,?)',
          target.id,
          slot,
          'retention-fixture',
          slot * MINUTE + 30000,
          1,
        );
      }
    }
    for (let batch = end - 10079; batch <= end; batch += 12) {
      const slots = Array.from(
        { length: Math.min(12, end - batch + 1) },
        (_, offset) => batch + offset,
      );
      await storage.exec(
        `INSERT INTO scheduler_events(at,slot,status,detail) VALUES ${slots.flatMap(() => ['(?,?,?,?)', '(?,?,?,?)']).join(',')}`,
        ...slots.flatMap((slot) => [
          slot * MINUTE + 1000,
          slot,
          'started',
          '{}',
          slot * MINUTE + 1020,
          slot,
          'completed',
          '{}',
        ]),
      );
    }
    for (let step = 0; step < 4; step++) {
      const slot = Math.floor((now - RETENTION) / MINUTE) - 1 + step;
      await storage.exec(
        'INSERT INTO scheduler_events(at,slot,status,detail) VALUES(?,?,?,?),(?,?,?,?)',
        slot * MINUTE + 1000,
        slot,
        'started',
        '{}',
        slot * MINUTE + 1020,
        slot,
        'completed',
        '{}',
      );
    }
    await storage.exec('DELETE FROM monitor_check_dirty');
    await storage.exec('DELETE FROM monitor_check_cache');
    await tick(now);
    for (const window of ['24h', '7d'])
      await (
        await mf.dispatchFetch(`https://edgelab.example/api/ops/status?window=${window}`)
      ).json();
    for (let step = 1; step <= 3; step++) {
      await clock(now + step * MINUTE);
      const measured = await cost(() => tick(now + step * MINUTE));
      assert(measured.rowsRead < 500, `Cron scanned history: ${measured.rowsRead}`);
      if (targetCount === 2)
        assert(measured.rowsWritten * 1440 < 100000, 'Two-target cron exceeds Free daily writes');
      for (const window of ['24h', '7d']) {
        const status = await cost(async () => {
          const response = await mf.dispatchFetch(
            `https://edgelab.example/api/ops/status?window=${window}`,
          );
          assert.equal(response.status, 200);
          await response.json();
        });
        assert(status.rowsRead < 1000, `Status scanned history: ${status.rowsRead}`);
        const sample = {
          targetCount,
          step,
          operation: `status-${window}`,
          rowsRead: status.rowsRead,
          rowsWritten: status.rowsWritten,
        };
        samples.push(sample);
        console.log(JSON.stringify(sample));
      }
      const sample = {
        targetCount,
        step,
        operation: 'cron-with-retention',
        rowsRead: measured.rowsRead,
        rowsWritten: measured.rowsWritten,
        projectedDailyReads: measured.rowsRead * 1440,
        projectedDailyWrites: measured.rowsWritten * 1440,
        fitsFreeDailyWrites: measured.rowsWritten * 1440 <= 100000,
      };
      samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  } finally {
    await mf.dispose();
  }
}
await mkdir('output', { recursive: true });
await writeFile(
  'output/monitor-cost-results.json',
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      measurement: 'Actual Miniflare SQLite cursor rowsRead/rowsWritten, including trigger work.',
      fixture:
        'Synthetic seven-day history, three warm consecutive cron minutes, one check/job per target and two scheduler events expiring each minute. No production requests, history deletion, AI, or billing changes.',
      caveat:
        'Daily projections cover this measured cron shape only; fixture clock operations conservatively add overhead. Dashboard traffic and owner writes consume additional account quota. Free capacity for five targets is not claimed.',
      samples,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'PASS actual whole-monitor SQL reads stay bounded; measured two-target cron fits Free writes and larger configurations report their capacity limits',
);
