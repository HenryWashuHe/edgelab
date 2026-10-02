import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'output/monitor-duplicate-cost');
const minute = 60000;
const historyMinutes = 4320;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pins = new Map();
const observations = [];
const runtimes = [];
let sourcesStable = false;
let stage = 'initialization';
let bundlePin;
let graph = [];
const startedAt = new Date().toISOString();
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
async function pin(path) {
  const key = relative(root, resolve(root, path)).replaceAll('\\', '/');
  assert(key && !key.startsWith('../'));
  const bytes = await readFile(resolve(root, key));
  if (pins.has(key)) assert.equal(pins.get(key).sha256, hash(bytes));
  pins.set(key, { path: key, bytes: bytes.length, sha256: hash(bytes) });
  return bytes;
}
async function bounded(promise, ms = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local operation deadline')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(predicate, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await bounded(Promise.resolve().then(predicate), ms)) return;
    await sleep(5);
  }
  assert.fail('Held probe startup deadline');
}
function delta(after, before) {
  const output = {};
  for (const key of [
    'statements',
    'rowsRead',
    'rowsWritten',
    'attemptedStatements',
    'failedStatements',
    'faultsFired',
    'nativeFaultsFired',
  ])
    output[key] = after[key] - before[key];
  output.operations = Object.fromEntries(
    Object.keys(after.operations).map((key) => [
      key,
      after.operations[key] - before.operations[key],
    ]),
  );
  output.failedCursorRowCost = output.failedStatements ? null : 'no-failed-cursor';
  assert.equal(output.failedStatements, 0);
  assert.equal(output.faultsFired, 0);
  assert.equal(output.nativeFaultsFired, 0);
  return output;
}
await mkdir(out, { recursive: true });
await rm(resolve(out, 'evidence.json'), { force: true });
const foundations = [
  'scripts/monitor-duplicate-cost.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
for (const file of foundations) await pin(file);
const packageInfo = JSON.parse((await pin('package.json')).toString());
const tsconfig = (await pin('tsconfig.json')).toString();
const inputs = new Map();
const compilation = await build({
  absWorkingDir: root,
  entryPoints: ['tests/fixtures/status-cache.ts'],
  outfile: resolve(out, 'worker.js'),
  write: false,
  bundle: true,
  metafile: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
  tsconfigRaw: tsconfig,
  plugins: [
    {
      name: 'exact-duplicate-tick-buffers',
      setup(builder) {
        builder.onLoad({ filter: /./ }, async (args) => {
          assert.equal(args.namespace, 'file');
          const path = relative(root, args.path).replaceAll('\\', '/');
          assert(/^(worker|tests\/fixtures)\//.test(path));
          const loader = { '.ts': 'ts', '.mjs': 'js' }[extname(path)];
          assert(loader);
          const bytes = await pin(path);
          inputs.set(path, pins.get(path));
          return { contents: bytes, loader, resolveDir: dirname(args.path) };
        });
      },
    },
  ],
});
assert.deepEqual(Object.keys(compilation.metafile.inputs).sort(), [...inputs.keys()].sort());
assert.equal(compilation.outputFiles.length, 1);
assert(
  Object.values(compilation.metafile.outputs)[0].imports.every(
    (x) => x.external && x.path === 'cloudflare:workers',
  ),
);
graph = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path));
const script = compilation.outputFiles[0].text;
bundlePin = {
  bytes: compilation.outputFiles[0].contents.length,
  sha256: hash(compilation.outputFiles[0].contents),
};
await writeFile(resolve(out, 'worker.js'), compilation.outputFiles[0].contents);

async function run(targetCount, kind) {
  // Choose enough room in the real current minute for setup and bounded local probes.
  // This never adjusts the actor clock, invents a future slot or retries a failed tick.
  const phase = Date.now() % minute;
  const waitStartedAt = Date.now();
  if (phase >= 45000) await bounded(sleep(minute - phase + 20), 17000);
  const realMinuteWaitMs = Date.now() - waitStartedAt;
  assert(realMinuteWaitMs <= 17000, 'Actual minute wait exceeded its local bound');
  const targets = Array.from({ length: targetCount }, (_, i) => ({
    id: `target-${i}`,
    name: `Controlled target ${i}`,
    url: 'https://origin.internal/health',
    transport: 'origin',
    assertion: 'ok-json',
  }));
  let held = kind === 'overlap';
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let probes = 0;
  let pending;
  const lifecycle = {
    targetCount,
    kind,
    initialMinutePhaseMs: phase,
    realMinuteWaitMs,
    disposed: false,
    originCalls: 0,
  };
  runtimes.push(lifecycle);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      host: '127.0.0.1',
      port: 0,
      log: new Log(LogLevel.NONE),
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          script,
          compatibilityDate: '2026-09-01',
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: {
            MONITOR_TARGETS: JSON.stringify(targets),
            AI_BRIEFS_ENABLED: 'false',
            LAB_ADMISSION_ENABLED: 'false',
          },
          serviceBindings: {
            ORIGIN: async () => {
              probes++;
              lifecycle.originCalls++;
              if (held) await hold;
              return Response.json({ ok: true });
            },
            ASSETS: async () => new Response('Local fixture', { status: 404 }),
          },
        },
      ],
    }),
  );
  try {
    await bounded(mf.ready, 15000);
    const ns = await bounded(mf.getDurableObjectNamespace('MONITORS', 'gateway'));
    const stub = ns.get(ns.idFromName('operations'));
    const call = async (path, body) => {
      const response = await bounded(
        stub.fetch('https://monitor.internal' + path, {
          method: body === undefined ? 'GET' : 'POST',
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await bounded(response.text());
      return { status: response.status, data: JSON.parse(text) };
    };
    const cost = async () => {
      const result = await call('/__fixture/cost');
      assert.equal(result.status, 200);
      return result.data;
    };
    const tick = async (slot) => {
      const result = await call('/tick', { slot });
      assert.equal(result.status, 200);
      return result.data;
    };
    // Bootstrap/native schema and manual seed lie outside all measured intervals.
    const bootstrap = await call('/export');
    assert.equal(bootstrap.status, 200);
    const storage = await bounded(
      mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', { name: 'operations' }),
    );
    const seedEnd = Math.floor(Date.now() / minute) - 1;
    for (const target of targets) {
      await bounded(
        storage.exec(
          'UPDATE services SET created=?,state=? WHERE id=?',
          (seedEnd - historyMinutes + 1) * minute,
          JSON.stringify({
            failures: 0,
            successes: historyMinutes,
            lastSlot: seedEnd,
            incidentId: null,
          }),
          target.id,
        ),
      );
      await bounded(
        storage.exec(
          'UPDATE service_versions SET recorded_at=? WHERE service=?',
          (seedEnd - historyMinutes + 1) * minute,
          target.id,
        ),
      );
      for (let start = seedEnd - historyMinutes + 1; start <= seedEnd; start += 12) {
        const slots = Array.from(
          { length: Math.min(12, seedEnd - start + 1) },
          (_, i) => start + i,
        );
        await bounded(
          storage.exec(
            'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES ' +
              slots.map(() => '(?,?,?,?,?,?,?,?)').join(','),
            ...slots.flatMap((slot) => [
              target.id,
              slot,
              slot * minute + 1020,
              'good',
              200,
              20,
              1,
              slot * minute + 1000,
            ]),
          ),
        );
        await bounded(
          storage.exec(
            'INSERT INTO jobs(service,slot,token,lease,done) VALUES ' +
              slots.map(() => '(?,?,?,?,?)').join(','),
            ...slots.flatMap((slot) => [
              target.id,
              slot,
              'seeded-completed',
              slot * minute + 30000,
              1,
            ]),
          ),
        );
      }
    }
    await bounded(
      storage.exec(
        'INSERT INTO scheduler_events(at,slot,status,detail) VALUES(?,?,?,?),(?,?,?,?)',
        seedEnd * minute + 1000,
        seedEnd,
        'started',
        '{}',
        seedEnd * minute + 1020,
        seedEnd,
        'completed',
        '{}',
      ),
    );
    // Materialize real projections before cron measurements, as the existing steady-state recipe does.
    const warm = await call('/export');
    assert.equal(warm.status, 200);
    assert.equal(probes, 0);
    const probeStart = Date.now();
    // A real minute boundary is not fabricated: refuse this run if it cannot fit a bounded probe/duplicate interval.
    assert(
      probeStart % minute < 55000,
      'Current minute almost ended; rerun whole profile, do not alter actor clock',
    );
    const slot = Math.floor(probeStart / minute);
    assert.equal(seedEnd, slot - 1, 'Seed/current minute crossed; do not invent clock or backfill');
    const before = await cost();
    let results;
    let isolatedDuplicate;
    let inFlightReadiness;
    let inFlightCheckSlots;
    let inFlightCurrentChecks;
    let beforeFinishedDuplicateChecks;
    if (kind === 'ordinary') {
      const ordinary = await tick(slot);
      assert(ordinary.results.every((x) => x.result === 'good'));
      assert.equal(probes, targetCount);
      const after = await cost();
      beforeFinishedDuplicateChecks = await bounded(
        storage.exec(
          'SELECT service,slot,revision,outcome,observed_at AS observedAt,at FROM checks WHERE slot=? ORDER BY service',
          slot,
        ),
      );
      assert.equal(beforeFinishedDuplicateChecks.length, targetCount);
      const beforeDuplicate = await cost();
      const priorProbes = probes;
      const duplicate = await tick(slot);
      assert(duplicate.results.every((x) => x.result === 'duplicate-or-busy'));
      assert.equal(probes, priorProbes);
      const afterDuplicate = await cost();
      observations.push({
        targetCount,
        kind: 'ordinary-current-minute',
        slot,
        realClockAtStart: probeStart,
        results: ordinary.results,
        cost: delta(after, before),
        probes: targetCount,
      });
      isolatedDuplicate = delta(afterDuplicate, beforeDuplicate);
      results = [ordinary, duplicate];
    } else {
      pending = tick(slot);
      await waitFor(() => probes === targetCount);
      const afterClaim = await cost();
      const duplicate = await tick(slot);
      assert(duplicate.results.every((x) => x.result === 'duplicate-or-busy'));
      assert.equal(probes, targetCount);
      const afterDuplicate = await cost();
      isolatedDuplicate = delta(afterDuplicate, afterClaim);
      // Diagnostics themselves are deliberately outside the isolated duplicate meter interval.
      inFlightReadiness = await call('/ready');
      assert.equal(inFlightReadiness.status, 200);
      assert.equal(inFlightReadiness.data.monitoring.status, 'healthy');
      assert.equal(inFlightReadiness.data.monitoring.lastSlot, slot);
      inFlightCheckSlots = await bounded(
        storage.exec('SELECT service,MAX(slot) AS latestSlot FROM checks GROUP BY service'),
      );
      assert.equal(inFlightCheckSlots.length, targetCount);
      assert(inFlightCheckSlots.every((row) => row.latestSlot === slot - 1));
      inFlightCurrentChecks = await bounded(
        storage.exec('SELECT service,slot FROM checks WHERE slot=?', slot),
      );
      assert.deepEqual(inFlightCurrentChecks, []);
      const diagnosticsAfter = await cost();
      held = false;
      release();
      const first = await pending;
      assert(first.results.every((x) => x.result === 'good'));
      assert.equal(probes, targetCount);
      const after = await cost();
      const diagnosticCost = delta(diagnosticsAfter, afterDuplicate);
      const combined = delta(after, before);
      // Remove only directly measured diagnostic work. No hypothetical per-call average.
      for (const key of [
        'statements',
        'rowsRead',
        'rowsWritten',
        'attemptedStatements',
        'failedStatements',
        'faultsFired',
        'nativeFaultsFired',
      ])
        combined[key] -= diagnosticCost[key];
      for (const key of Object.keys(combined.operations))
        combined.operations[key] -= diagnosticCost.operations[key];
      observations.push({
        targetCount,
        kind: 'overlapping-pair-combined',
        slot,
        realClockAtStart: probeStart,
        firstResults: first.results,
        duplicateResults: duplicate.results,
        cost: combined,
        excludedDiagnosticCost: diagnosticCost,
        probes: targetCount,
      });
      results = [first, duplicate];
    }
    assert.equal(Math.floor(Date.now() / minute), slot, 'Minute fence crossed during native tick');
    const jobs = await bounded(
      storage.exec('SELECT service,slot,done FROM jobs WHERE slot=? ORDER BY service', slot),
    );
    const checks = await bounded(
      storage.exec(
        'SELECT service,slot,revision,outcome,observed_at AS observedAt,at FROM checks WHERE slot=? ORDER BY service',
        slot,
      ),
    );
    assert.equal(jobs.length, targetCount);
    assert(jobs.every((x) => x.done === 1));
    assert.equal(checks.length, targetCount);
    if (beforeFinishedDuplicateChecks)
      assert.deepEqual(
        checks,
        beforeFinishedDuplicateChecks,
        'Duplicate must preserve actual observation/completion times',
      );
    assert(checks.every((x) => x.outcome === 'good' && Math.floor(x.observedAt / minute) === slot));
    const events = await bounded(
      storage.exec(
        'SELECT at,slot,status,detail FROM scheduler_events WHERE slot=? ORDER BY id',
        slot,
      ),
    );
    assert.equal(events.filter((x) => x.status === 'started').length, 2);
    assert.equal(events.filter((x) => x.status === 'completed').length, 2);
    const completed = events
      .filter((x) => x.status === 'completed')
      .map((x) => ({ ...x, detail: JSON.parse(x.detail) }));
    assert(completed.every((x) => x.detail.cleanup.schemaVersion === 1));
    const ready = await call('/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.data.monitoring.status, 'healthy');
    const final = await call('/export');
    assert.equal(final.status, 200);
    assert(final.data.services.every((x) => x.budget.evaluationStatus === 'current'));
    observations.push({
      targetCount,
      kind:
        kind === 'ordinary' ? 'same-slot-finished-duplicate' : 'same-slot-overlapping-duplicate',
      slot,
      cost: isolatedDuplicate,
      extraProbes: 0,
      currentRows: { jobs, checks },
      completedEvents: completed,
      finalReadiness: ready.data,
      inFlightReadiness: inFlightReadiness ?? null,
      inFlightLatestCheckSlots: inFlightCheckSlots ?? null,
      inFlightCurrentChecks: inFlightCurrentChecks ?? null,
      beforeFinishedDuplicateChecks: beforeFinishedDuplicateChecks ?? null,
      budgetState: final.data.services.map((x) => ({
        service: x.id,
        evaluationStatus: x.budget.evaluationStatus,
        computedAt: x.budget.evaluation.computedAt,
        state: x.budget.evaluation.state,
      })),
      orderedResults: results.map((x) => x.results),
      seed: { verifiedMinutesPerService: historyMinutes, seedLastSlot: seedEnd },
    });
  } finally {
    held = false;
    release();
    if (pending) await Promise.allSettled([pending]);
    await mf.dispose();
    lifecycle.disposed = true;
  }
}

try {
  stage = 'native profiles';
  for (const targets of [2, 5])
    for (const kind of ['ordinary', 'overlap']) await run(targets, kind);
  stage = 'source stability';
  for (const [path, p] of pins) assert.equal(hash(await readFile(resolve(root, path))), p.sha256);
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    baseCommit,
  );
  assert(runtimes.every((x) => x.disposed));
  sourcesStable = true;
  const report = {
    schemaVersion: 1,
    kind: 'edgelab-local-current-minute-duplicate-tick',
    startedAt,
    measuredAt: new Date().toISOString(),
    sourceBaseCommit: baseCommit,
    sourceProjectVersion: packageInfo.version,
    environment: {
      node: process.version,
      esbuild: esbuildVersion,
      miniflare: JSON.parse(
        await readFile(resolve(root, 'node_modules/miniflare/package.json'), 'utf8'),
      ).version,
      compatibilityDate: '2026-09-01',
      clock: 'native Date.now; optional fixture clock endpoint never invoked',
      entryPath:
        'Direct native MonitorStore /tick through its real Durable Object stub; no gateway scheduled handler or CronTrigger delivery invoked',
      cf: false,
      telemetry: false,
    },
    sourcePins: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path)),
    buildGraph: graph,
    bundle: bundlePin,
    sourcesStable,
    observations,
    runtimes,
    meterBoundary: {
      cursor:
        'Real SQLite execute + toArray completion, including trigger/index consumed row accounting. Instrumentation delegates actual SQL/KV/alarm APIs.',
      failedCursorCost:
        'Failed SQL has no cursor: cost unknown, never zero. No SQL failure occurred in this workload.',
      exclusions:
        'Constructor/schema/enrollment, manual seeding, explicit projection warming and verification/readiness reads excluded from tick intervals; overlapping pair subtracts only separately measured readiness call.',
    },
    limits: [
      'Controlled local origin response only, no actual provider/account/production/browser calls.',
      'Real current minute only, no fixed/advanced clock, old-minute replay or backfill. Setup waits for a new real minute when less than15seconds remain, without replaying a failed tick.',
      'One ordinary and one overlap profile per target count; not a throughput/load/billing/capacity or natural cron-duplication measurement.',
      'Each duplicate is a separate native MonitorStore /tick invocation. Gateway scheduled handling, CronTrigger delivery and naturally occurring duplicates are not exercised. Completion diagnostics do not assert a new probe; result lists disclose duplicate-or-busy.',
      'Seeded4320-minute good histories/jobs with no expiry candidates; these are measured empty-retention tick paths, not saturated cleanup.',
    ],
    externalCalls: { provider: 0, account: 0, production: 0, browser: 0 },
  };
  await writeFile(resolve(out, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        passed: true,
        measuredAt: report.measuredAt,
        observations: observations.map((x) => ({
          targetCount: x.targetCount,
          kind: x.kind,
          cost: x.cost,
          probes: x.probes ?? x.extraProbes,
        })),
        runtimes,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    resolve(out, 'failed-attempt.json'),
    JSON.stringify(
      {
        stage,
        at: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Unknown local failure',
        observations,
        runtimes,
        sourcePins: [...pins.values()],
      },
      null,
      2,
    ) + '\n',
  );
  throw error;
}
