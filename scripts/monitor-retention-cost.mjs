import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

// Local-only regression. Baseline substitutes two pinned source files at
// build time; final mode bundles actual tracked source, including all triggers.
// Every upstream response and every stored evidence row is a controlled fixture.
// Default uses the checked-in baseline JSON and works with shallow CI checkout.
// Explicit --baseline additionally needs the pinned Git commit locally; fetch
// repository history before using that optional replay. Neither mode fetches.
const baseline = process.argv.includes('--baseline');
assert(
  process.argv.slice(2).every((arg) => arg === '--baseline'),
  'Only optional --baseline is supported; there is no native/production mode.',
);
const baselineCommit = '8072155094ea76a6e7a9f74e7f3357c39270d6f6';
const publishedBaseline = JSON.parse(
  await readFile('tests/fixtures/monitor-retention-cost-baseline.json', 'utf8'),
);
assert.equal(publishedBaseline.baselineCommit, baselineCommit);
const projectVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const variant = baseline ? 'baseline-3.4.0' : 'tracked';
const bundle = `output/monitor-retention-cost-worker/${variant}.js`;
const sourceFiles = baseline
  ? ['worker/monitor.ts', 'worker/incident-evidence.ts']
  : ['worker/monitor.ts', 'worker/incident-evidence.ts', 'worker/monitor-version-retention.ts'];
const fileHash = (value) => createHash('sha256').update(value).digest('hex');
const sourceSHA256 = {};
for (const path of sourceFiles)
  sourceSHA256[path] = fileHash(
    baseline ? execFileSync('git', ['show', baselineCommit + ':' + path]) : await readFile(path),
  );
await mkdir('output/monitor-retention-cost-worker', { recursive: true });
await build({
  entryPoints: ['tests/fixtures/monitor-cost.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
  plugins: baseline
    ? [
        {
          name: 'pinned-before-retention',
          setup(plugin) {
            for (const relative of ['worker/monitor.ts', 'worker/incident-evidence.ts'])
              plugin.onLoad(
                { filter: new RegExp('/' + relative.replaceAll('.', '\\.') + '$') },
                () => ({
                  contents: execFileSync('git', ['show', baselineCommit + ':' + relative], {
                    encoding: 'utf8',
                  }),
                  loader: 'ts',
                }),
              );
          },
        },
      ]
    : [],
});

const MINUTE = 60000;
const RETENTION = 30 * 86400000;
const now = Date.UTC(2026, 8, 30, 12, 0, 1);
const end = Math.floor(now / MINUTE) - 1;
const samples = [],
  invariants = [];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const targetCount of [2, 5]) {
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    id: `service-${index}`,
    name: `Service ${index}`,
    url: 'https://origin.internal/health',
    transport: 'origin',
    assertion: 'ok-json',
  }));
  let originCalls = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: bundle,
          compatibilityDate: '2026-09-01',
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: { MONITOR_TARGETS: JSON.stringify(targets), AI_BRIEFS_ENABLED: 'false' },
          serviceBindings: {
            ORIGIN: async () => {
              originCalls++;
              return Response.json({ ok: true });
            },
          },
        },
      ],
    }),
  );
  try {
    const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
    const stub = ns.get(ns.idFromName('operations'));
    const clock = async (at) => {
      const response = await stub.fetch('https://monitor.internal/test-clock', {
        method: 'POST',
        body: JSON.stringify({ now: at }),
      });
      assert.equal(response.status, 200);
      await response.text();
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
    const status = async () => {
      const response = await mf.dispatchFetch('https://edgelab.example/api/ops/status?window=7d');
      assert.equal(response.status, 200);
      return response.json();
    };
    await clock(now);
    await status();
    const storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
      name: 'operations',
    });
    const policies = new Map();
    for (const target of targets) {
      const [service] = await storage.exec('SELECT * FROM services WHERE id=?', target.id);
      policies.set(target.id, service.policy);
      await storage.exec(
        'UPDATE services SET created=? WHERE id=?',
        (end - 719) * MINUTE,
        target.id,
      );
      await storage.exec(
        'UPDATE service_versions SET recorded_at=? WHERE service=?',
        (end - 719) * MINUTE,
        target.id,
      );
      for (let i = 0; i < 720; i += 12) {
        const slots = Array.from({ length: 12 }, (_, j) => end - 719 + i + j);
        await storage.exec(
          'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES ' +
            slots.map(() => '(?,?,?,?,?,?,?,?)').join(','),
          ...slots.flatMap((slot, j) => [
            target.id,
            slot,
            slot * MINUTE + 1020,
            'good',
            200,
            20,
            i + j + 1,
            slot * MINUTE + 1000,
          ]),
        );
        await storage.exec(
          'INSERT INTO jobs VALUES ' + slots.map(() => '(?,?,?,?,?)').join(','),
          ...slots.flatMap((slot) => [
            target.id,
            slot,
            'finished-fixture',
            slot * MINUTE + 30000,
            1,
          ]),
        );
      }
      for (let step = 0; step < 11; step++) {
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
    for (let i = 0; i < 720; i += 12) {
      const slots = Array.from({ length: 12 }, (_, j) => end - 719 + i + j);
      await storage.exec(
        'INSERT INTO scheduler_events(at,slot,status,detail) VALUES ' +
          slots.flatMap(() => ['(?,?,?,?)', '(?,?,?,?)']).join(','),
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
    for (let step = 0; step < 11; step++) {
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
    const sourceChecks = await storage.exec(
      'SELECT * FROM checks WHERE slot>=? AND slot<=? ORDER BY service,slot',
      end - 719,
      end,
    );
    await storage.exec('DELETE FROM monitor_check_dirty');
    await storage.exec('DELETE FROM monitor_check_cache');
    await tick(now);
    await status();
    async function measured(profile, step, at) {
      await stub.fetch('https://monitor.internal/test-cost-reset', { method: 'POST' });
      const callsBefore = originCalls;
      await tick(at);
      const meter = await stub.fetch('https://monitor.internal/test-cost');
      const value = {
        variant,
        targetCount,
        profile,
        step,
        ...(await meter.json()),
        controlledOriginCalls: originCalls - callsBefore,
      };
      samples.push(value);
      console.log(JSON.stringify(value));
      assert.equal(value.controlledOriginCalls, targetCount);
      await status();
    }
    for (let step = 1; step <= 3; step++)
      await measured('small-retained-metadata', step, now + step * MINUTE);

    for (const [index, target] of targets.entries()) {
      for (let i = 0; i < 720; i += 12) {
        const revisions = Array.from({ length: 12 }, (_, j) => i + j + 1);
        await storage.exec(
          'INSERT OR REPLACE INTO service_versions VALUES ' +
            revisions.map(() => '(?,?,?,?,?,?,?,?)').join(','),
          ...revisions.flatMap((revision) => [
            target.id,
            revision,
            (end - 720 + revision) * MINUTE,
            target.name,
            'origin',
            'ok-json',
            policies.get(target.id),
            'recorded',
          ]),
        );
      }
      const incident = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await storage.exec(
        'INSERT INTO incidents(id,service,opened) VALUES(?,?,?)',
        incident,
        target.id,
        now - MINUTE,
      );
      for (let i = 0; i < 100; i += 10) {
        const ids = Array.from({ length: 10 }, (_, j) => i + j);
        await storage.exec(
          'INSERT INTO incident_notes VALUES ' + ids.map(() => '(?,?,?,?)').join(','),
          ...ids.flatMap((id) => [
            `${target.id}-note-${id}`,
            incident,
            now,
            'Controlled private fixture note',
          ]),
        );
      }
    }
    const versions = await storage.exec('SELECT * FROM service_versions ORDER BY service,revision');
    const notes = await storage.exec('SELECT * FROM incident_notes ORDER BY id');
    const incidents = await storage.exec('SELECT * FROM incidents ORDER BY id');
    for (let step = 1; step <= 3; step++)
      await measured('growing-retained-metadata', step, now + (3 + step) * MINUTE);
    assert.deepEqual(
      await storage.exec(
        'SELECT * FROM checks WHERE slot>=? AND slot<=? ORDER BY service,slot',
        end - 719,
        end,
      ),
      sourceChecks,
    );
    assert.deepEqual(
      await storage.exec('SELECT * FROM service_versions ORDER BY service,revision'),
      versions,
    );
    assert.deepEqual(await storage.exec('SELECT * FROM incident_notes ORDER BY id'), notes);
    assert.deepEqual(await storage.exec('SELECT * FROM incidents ORDER BY id'), incidents);
    const snapshot = await status();
    const summaries = snapshot.services.map(
      ({ id, name, policy, status, state, budget, metrics, hourly }) => ({
        id,
        name,
        policy,
        status,
        state,
        budget,
        metrics,
        hourly,
      }),
    );
    invariants.push({
      targetCount,
      profile: 'growing-retained-metadata',
      sourceChecksUnchanged: true,
      referencedVersionsUnchanged: true,
      parentedNotesUnchanged: true,
      openIncidentsUnchanged: true,
      sourceHash: digest({ sourceChecks, versions, notes, incidents }),
      summaryHash: digest(summaries),
      sourceCheckCount: sourceChecks.length,
      protectedVersionCount: versions.length,
      retainedNotes: notes.length,
    });

    // A bounded queue has real write overhead during catch-up. Measure it rather
    // than claiming every cron workload is cheaper or always fits Free quotas.
    for (let i = 0; i < 96; i += 12) {
      const revisions = Array.from({ length: 12 }, (_, j) => 10000 + i + j);
      const target = targets[0];
      await storage.exec(
        'INSERT INTO service_versions VALUES ' + revisions.map(() => '(?,?,?,?,?,?,?,?)').join(','),
        ...revisions.flatMap((revision) => [
          target.id,
          revision,
          now,
          target.name,
          'origin',
          'ok-json',
          policies.get(target.id),
          'recorded',
        ]),
      );
      await storage.exec(
        'INSERT INTO incident_notes VALUES ' + revisions.map(() => '(?,?,?,?)').join(','),
        ...revisions.flatMap((revision) => [
          `orphan-${revision}`,
          'missing-parent',
          now,
          'Controlled orphan fixture note',
        ]),
      );
    }
    for (let step = 1; step <= 3; step++) {
      await measured('96-unused-versions-and-orphan-notes', step, now + (6 + step) * MINUTE);
      const remaining = baseline ? 0 : 96 - step * 32;
      assert.equal(
        (await storage.exec('SELECT COUNT(*) count FROM service_versions WHERE revision>=10000'))[0]
          .count,
        remaining,
        'Version cleanup must process exactly 32 FIFO candidates per completed cron.',
      );
      assert.equal(
        (
          await storage.exec("SELECT COUNT(*) count FROM incident_notes WHERE id LIKE 'orphan-%'")
        )[0].count,
        remaining,
        'Orphan cleanup must process exactly 32 FIFO candidates per completed cron.',
      );
      if (!baseline) {
        assert.equal(
          (await storage.exec('SELECT COUNT(*) count FROM monitor_version_gc'))[0].count,
          remaining,
        );
        assert.equal(
          (await storage.exec('SELECT COUNT(*) count FROM incident_note_gc'))[0].count,
          remaining,
        );
      }
    }
    assert.deepEqual(
      await storage.exec(
        'SELECT * FROM checks WHERE slot>=? AND slot<=? ORDER BY service,slot',
        end - 719,
        end,
      ),
      sourceChecks,
    );
    assert.deepEqual(
      await storage.exec('SELECT * FROM service_versions ORDER BY service,revision'),
      versions,
    );
    assert.deepEqual(await storage.exec('SELECT * FROM incident_notes ORDER BY id'), notes);
    assert.deepEqual(await storage.exec('SELECT * FROM incidents ORDER BY id'), incidents);
    invariants.push({
      targetCount,
      profile: '96-unused-versions-and-orphan-notes',
      sourceChecksUnchanged: true,
      referencedVersionsUnchanged: true,
      parentedNotesUnchanged: true,
      openIncidentsUnchanged: true,
      unusedVersionsRemoved: 96,
      orphanNotesRemoved: 96,
      queueEmpty: baseline
        ? null
        : (await storage.exec('SELECT COUNT(*) count FROM monitor_version_gc'))[0].count === 0 &&
          (await storage.exec('SELECT COUNT(*) count FROM incident_note_gc'))[0].count === 0,
    });
  } finally {
    await mf.dispose();
  }
}
const artifact = {
  measuredAt: new Date().toISOString(),
  variant,
  baselineCommit,
  sourceSHA256,
  bundleSHA256: fileHash(await readFile(bundle)),
  recipe: `node scripts/monitor-retention-cost.mjs${baseline ? ' --baseline' : ''}`,
  fixture:
    'Ephemeral actual Miniflare SQLite; 720 seeded checks per target; three consecutive measured cron minutes per profile; one check/job per target and two scheduler events expire each minute; growing profile has 720 referenced versions and 100 parented notes per target; catch-up has 96 global unused versions and 96 orphan notes.',
  clockWriteOverheadPerCron: 2,
  nativeInferenceCalls: 0,
  productionRequests: 0,
  limitations:
    'Controlled comparison of these workloads, not production account consumption, end-to-end CPU/billing or unlimited daily capacity. Catch-up includes real queue/AUTOINCREMENT/trigger writes. Five-target Free daily-write capacity is not claimed.',
  samples,
  invariants,
};
if (!baseline)
  for (const path of sourceFiles)
    assert.equal(
      fileHash(await readFile(path)),
      sourceSHA256[path],
      `Measured source changed during runtime: ${path}`,
    );
{
  const previous = publishedBaseline;
  const pairs = artifact.invariants.filter((row) => row.profile === 'growing-retained-metadata');
  for (const row of pairs) {
    const other = previous.invariants.find(
      (other) => other.targetCount === row.targetCount && other.profile === row.profile,
    );
    assert.equal(
      row.sourceHash,
      other.sourceHash,
      'Source parity differs between pinnedbaseline and tracked helper',
    );
    assert.equal(
      row.summaryHash,
      other.summaryHash,
      'Public summary/budget parity differs between pinnedbaseline and tracked helper',
    );
  }
  console.log('PASS baseline/tracked source and public summary/budget hashes match.');
}
if (baseline) {
  assert.deepEqual(
    artifact.sourceSHA256,
    publishedBaseline.sourceSHA256,
    'Pinned baseline source provenance changed.',
  );
  await writeFile(
    'output/monitor-retention-cost-baseline.json',
    JSON.stringify(artifact, null, 2) + '\n',
  );
} else {
  for (const targetCount of [2, 5]) {
    const small = samples.filter(
      (row) => row.targetCount === targetCount && row.profile === 'small-retained-metadata',
    );
    const grown = samples.filter(
      (row) => row.targetCount === targetCount && row.profile === 'growing-retained-metadata',
    );
    const catchup = samples.filter(
      (row) =>
        row.targetCount === targetCount && row.profile === '96-unused-versions-and-orphan-notes',
    );
    assert.equal(small.length, 3);
    assert.equal(grown.length, 3);
    assert.equal(catchup.length, 3);
    const smallMax = Math.max(...small.map((row) => row.rowsRead));
    for (const row of [...small, ...grown]) {
      assert(row.rowsRead < 500, 'Warm cron must not scan retained policy/note history.');
      if (targetCount === 2)
        assert(
          row.rowsWritten * 1440 < 100000,
          'Measured two-target steady cron shape exceeds Free daily writes.',
        );
    }
    assert(
      Math.max(...grown.map((row) => row.rowsRead)) <= smallMax + 32,
      'Retained metadata growth adds unbounded per-minute read cost.',
    );
    assert(
      Math.max(...grown.map((row) => row.rowsWritten)) <=
        Math.max(...small.map((row) => row.rowsWritten)),
      'Referenced/current metadata must not enqueue per-minute GC writes.',
    );
    for (const row of catchup) {
      assert(row.rowsRead < 1000, 'FIFO catch-up scanned more than its bounded candidates.');
      assert(row.rowsWritten < 300, 'FIFO catch-up exceeds the bounded fixture write budget.');
      assert(
        row.rowsWritten > Math.max(...small.map((row) => row.rowsWritten)),
        'Fixture failed to include actual GC/queue/trigger writes.',
      );
    }
  }
  const comparisons = [];
  for (const targetCount of [2, 5])
    for (const profile of [
      'small-retained-metadata',
      'growing-retained-metadata',
      '96-unused-versions-and-orphan-notes',
    ]) {
      const select = (report) =>
        report.samples
          .filter((row) => row.targetCount === targetCount && row.profile === profile)
          .map(({ rowsRead, rowsWritten }) => ({ rowsRead, rowsWritten }));
      comparisons.push({
        targetCount,
        profile,
        before: select(publishedBaseline),
        after: select(artifact),
      });
    }
  const report = {
    projectVersion,
    measuredAt: artifact.measuredAt,
    recipe: 'node scripts/monitor-retention-cost.mjs',
    optionalBaselineReplay: 'node scripts/monitor-retention-cost.mjs --baseline',
    baselineReplayPrerequisite:
      'Optional replay requires Git object 8072155094ea76a6e7a9f74e7f3357c39270d6f6 locally (fetch repository history first). Default shallow CI uses checked-in baseline measurements and hashes and never fetches Git or calls Cloudflare.',
    baseline: publishedBaseline,
    after: artifact,
    comparisons,
    guarantees: {
      sourceAndPublicSummaryHashParity: true,
      threeConsecutiveCronSamplesPerProfile: true,
      exactVersionCandidatesPerCatchupRun: 32,
      exactOrphanNotesPerCatchupRun: 32,
      nativeInferenceCalls: 0,
      productionRequests: 0,
    },
    limitations: artifact.limitations,
  };
  await writeFile(
    'output/monitor-retention-cost-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    'PASS bounded whole-cron costs, exact 32 + 32 catch-up and archived source/public summary parity.',
  );
}
