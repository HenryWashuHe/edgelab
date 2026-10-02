import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { relative, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const MINUTE = 60000;
const base = Math.floor(Date.UTC(2026, 8, 29, 12) / MINUTE);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceBase = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const recipePaths = [
  'scripts/monitor-enrollment.test.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
const pins = async (paths) =>
  Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, hash(await readFile(path))])),
  );
const recipePins = await pins(recipePaths);
const sourcePins = {};
const compilation = await build({
  entryPoints: ['tests/fixtures/monitor-clock.ts'],
  bundle: true,
  write: false,
  metafile: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
  plugins: [
    {
      name: 'capture-actual-enrollment-inputs',
      setup(plugin) {
        plugin.onLoad({ filter: /\/(?:worker|tests\/fixtures)\/.*\.ts$/ }, async ({ path }) => {
          const bytes = await readFile(path);
          const file = relative(process.cwd(), path);
          sourcePins[file] = hash(bytes);
          return { contents: bytes.toString('utf8'), loader: 'ts' };
        });
      },
    },
  ],
});
for (const path of Object.keys(compilation.metafile.inputs)) {
  const file = relative(process.cwd(), resolve(path));
  assert(Object.hasOwn(sourcePins, file), 'Every bundle input must be captured');
  assert.equal(hash(await readFile(file)), sourcePins[file], file);
}
const script = compilation.outputFiles[0].text;
const target = {
  id: 'catalog',
  name: 'Controlled catalog',
  url: 'https://origin.internal/health',
  transport: 'origin',
  assertion: 'ok-json',
};
const observations = [];
const lifecycles = [];

async function withRuntime(name, run) {
  const persistence = await mkdtemp(join(tmpdir(), 'edgelab-enrollment-'));
  let mf;
  let good = false;
  let originCalls = 0;
  let hold;
  const lifecycle = {
    case: name,
    reloads: 0,
    nativeEvictions: 0,
    disposed: false,
    tempRemoved: false,
  };
  lifecycles.push(lifecycle);
  const deadline = Date.now() + 15000;
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native enrollment fixture deadline exceeded')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const options = (targets) =>
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      host: '127.0.0.1',
      port: 0,
      log: new Log(LogLevel.NONE),
      unsafeInspectDurableObjects: true,
      durableObjectsPersist: persistence,
      workers: [
        {
          name: 'enrollment',
          modules: true,
          script,
          compatibilityDate: '2026-09-01',
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: { MONITOR_TARGETS: JSON.stringify(targets), AI_BRIEFS_ENABLED: 'false' },
          serviceBindings: {
            ORIGIN: async () => {
              originCalls++;
              const currentHold = hold;
              if (currentHold) {
                currentHold.started();
                await currentHold.released;
                currentHold.returned = true;
              }
              return Response.json({ ok: good }, { status: good ? 200 : 503 });
            },
          },
        },
      ],
    });
  let stub;
  let storage;
  const freshHandles = async () => {
    const ns = await bounded(mf.getDurableObjectNamespace('MONITORS', 'enrollment'));
    stub = ns.get(ns.idFromName('operations'));
    storage = await bounded(
      mf.unsafeGetDurableObjectStorage('enrollment', 'MonitorStore', { name: 'operations' }),
    );
  };
  const call = async (path, body) => {
    const response = await bounded(
      stub.fetch(`https://monitor.internal/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      }),
    );
    return { status: response.status, data: await bounded(response.json()) };
  };
  const sql = (...args) => bounded(storage.exec(...args));
  const clock = async (now) => {
    const response = await bounded(
      stub.fetch('https://monitor.internal/test-clock', {
        method: 'POST',
        body: JSON.stringify({ now }),
        signal: AbortSignal.timeout(10000),
      }),
    );
    assert.equal(response.status, 200);
    await bounded(response.text());
  };
  const read = async () => {
    const response = await call('export');
    assert.equal(response.status, 200);
    return response.data;
  };
  const tick = async (slot) => {
    await clock(slot * MINUTE + 1000);
    const response = await call('tick', { slot });
    assert.equal(response.status, 200);
    return response.data;
  };
  const policy = async (revision, patch) => {
    const response = await call('policy', { service: target.id, revision, policy: patch });
    assert.equal(response.status, 200);
    assert.equal(response.data.revision, revision + 1);
  };
  const reload = async (targets) => {
    await bounded(mf.setOptions(options(targets)));
    lifecycle.reloads++;
    await freshHandles();
  };
  try {
    mf = new Miniflare(options([target]));
    await bounded(mf.ready);
    await freshHandles();
    await clock(base * MINUTE);
    await read();
    await run({
      call,
      sql,
      clock,
      read,
      tick,
      policy,
      reload,
      bounded,
      good(value) {
        good = value;
      },
      get originCalls() {
        return originCalls;
      },
      holdProbe() {
        let started;
        let release;
        const began = new Promise((resolve) => (started = resolve));
        const released = new Promise((resolve) => (release = resolve));
        const currentHold = { started, released, release, returned: false };
        hold = currentHold;
        return {
          began,
          release,
          get returned() {
            return currentHold.returned;
          },
        };
      },
      async evict() {
        await bounded(
          mf.unsafeEvictDurableObject('enrollment', 'MonitorStore', { name: 'operations' }),
        );
        lifecycle.nativeEvictions++;
        await freshHandles();
      },
    });
    lifecycle.originCalls = originCalls;
  } finally {
    hold?.release();
    try {
      if (mf) {
        await mf.dispose();
        lifecycle.disposed = true;
      }
    } finally {
      await rm(persistence, { recursive: true, force: true });
      lifecycle.tempRemoved = true;
    }
  }
}

test(
  'native removal and unchanged re-enrollment retain an active incident and preserve missing minutes',
  { timeout: 30000 },
  async () => {
    await withRuntime('retained-incident-and-recovery-gap', async (f) => {
      await f.policy(1, {
        failureThreshold: 2,
        recoveryThreshold: 3,
        timeoutMs: 1000,
        latencyObjectiveMs: 500,
        availabilityTarget: 99.5,
      });
      await f.tick(base);
      await f.tick(base + 1);
      f.good(true);
      await f.tick(base + 2);
      const retained = (await f.read()).services[0];
      const incident = (await f.read()).incidents[0];
      assert.equal(retained.createdAt, base * MINUTE);
      assert.equal(retained.revision, 2);
      assert.equal(retained.state.successes, 1);
      assert.equal(retained.state.incidentId, incident.id);
      assert.equal(incident.resolved, null);
      const stored = await f.sql('SELECT * FROM services');
      const checks = await f.sql('SELECT * FROM checks ORDER BY slot');
      const incidents = await f.sql('SELECT * FROM incidents');
      const callsBeforeRemoval = f.originCalls;
      await f.reload([]);
      for (const slot of [base + 3, base + 4]) {
        assert.deepEqual((await f.tick(slot)).results, []);
        const absent = await f.read();
        assert.deepEqual(absent.services, []);
        assert.deepEqual(absent.incidents, []);
      }
      assert.equal(f.originCalls, callsBeforeRemoval);
      assert.deepEqual(await f.sql('SELECT * FROM services'), stored);
      assert.deepEqual(await f.sql('SELECT * FROM checks ORDER BY slot'), checks);
      assert.deepEqual(await f.sql('SELECT * FROM incidents'), incidents);
      assert.equal(
        (await f.sql("SELECT COUNT(*) count FROM checks WHERE outcome='maintenance'"))[0].count,
        0,
      );
      await f.reload([target]);
      await f.clock((base + 5) * MINUTE);
      const readded = await f.read();
      for (const field of ['createdAt', 'revision', 'policy', 'state', 'history']) {
        assert.deepEqual(readded.services[0][field], retained[field], field);
      }
      assert.deepEqual(readded.incidents[0], incident);
      await f.tick(base + 5);
      let recovering = (await f.read()).services[0];
      assert.equal(recovering.state.successes, 1);
      assert.equal(recovering.state.incidentId, incident.id);
      await f.tick(base + 6);
      assert.equal((await f.read()).services[0].state.successes, 2);
      assert.equal((await f.read()).incidents[0].resolved, null);
      await f.tick(base + 7);
      assert.equal((await f.read()).services[0].state.incidentId, null);
      assert.notEqual((await f.read()).incidents[0].resolved, null);
      await f.clock((base + 8) * MINUTE);
      const finished = (await f.read()).services[0];
      assert.equal(finished.metrics.expected, 8);
      assert.equal(finished.metrics.total, 6);
      assert.equal(finished.metrics.observed, 6);
      assert.equal(finished.metrics.missing, 2);
      assert.equal(finished.metrics.maintenance, 0);
      assert.equal(finished.metrics.coverage, 75);
      assert.equal(
        (await f.sql('SELECT * FROM checks WHERE slot IN (?,?)', base + 3, base + 4)).length,
        0,
      );
      observations.push({
        phase: 'retained-incident-and-recovery-gap',
        revision: retained.revision,
        retainedChecks: checks.length,
        absentMinutes: 2,
        absentProbeCalls: 0,
        recoveryStreakAfterGap: recovering.state.successes,
        finishedExpected: finished.metrics.expected,
        finishedObserved: finished.metrics.observed,
        finishedMissing: finished.metrics.missing,
        finishedMaintenance: finished.metrics.maintenance,
        coverage: finished.metrics.coverage,
        incidentRetained: true,
        originalCreatedPolicyHistoryRetained: true,
        resolvedAfterThreeConsecutiveChecks: true,
      });
    });
  },
);

test(
  'a genuinely absent minute resets consecutive failures after unchanged re-enrollment',
  { timeout: 30000 },
  async () => {
    await withRuntime('failure-gap', async (f) => {
      await f.policy(1, { failureThreshold: 2 });
      await f.tick(base);
      const before = (await f.read()).services[0];
      assert.equal(before.state.failures, 1);
      assert.equal(before.state.incidentId, null);
      await f.reload([]);
      const calls = f.originCalls;
      assert.deepEqual((await f.tick(base + 1)).results, []);
      assert.equal(f.originCalls, calls);
      await f.reload([target]);
      await f.tick(base + 2);
      const afterGap = (await f.read()).services[0];
      assert.equal(afterGap.revision, before.revision);
      assert.equal(afterGap.state.failures, 1);
      assert.equal(afterGap.state.incidentId, null);
      await f.tick(base + 3);
      assert.notEqual((await f.read()).services[0].state.incidentId, null);
      observations.push({
        phase: 'failure-gap',
        revision: afterGap.revision,
        absentProbeCalls: 0,
        failureStreakAfterGap: afterGap.state.failures,
        incidentOpenedAfterTwoConsecutiveChecks: true,
      });
    });
  },
);

test(
  'normalized-equivalent targets preserve revision; a changed target requires a new observation for readiness',
  { timeout: 30000 },
  async () => {
    await withRuntime('target-revision-and-readiness', async (f) => {
      f.good(true);
      await f.tick(base);
      assert.equal((await f.call('ready')).status, 200);
      const original = (await f.read()).services[0];
      await f.reload([{ ...target, url: 'https://origin.internal:443/health' }]);
      const equivalent = (await f.read()).services[0];
      assert.equal(equivalent.revision, original.revision);
      assert.equal(equivalent.createdAt, original.createdAt);
      assert.deepEqual(equivalent.policy, original.policy);
      assert.deepEqual(equivalent.history, original.history);
      assert.equal((await f.call('ready')).status, 200);
      await f.reload([{ ...target, url: 'https://origin.internal/replacement-health' }]);
      const changed = (await f.read()).services[0];
      assert.equal(changed.revision, original.revision + 1);
      assert.equal(changed.createdAt, original.createdAt);
      assert.deepEqual(changed.policy, original.policy);
      assert.deepEqual(changed.history, original.history);
      assert.equal(changed.state.failures, 0);
      assert.equal(changed.state.successes, 0);
      assert.equal(changed.state.lastSlot, null);
      assert.equal(changed.status, 'unknown');
      const missingCurrent = await f.call('ready');
      assert.equal(missingCurrent.status, 503);
      assert.equal(missingCurrent.data.monitoring.status, 'partial');
      await f.tick(base + 1);
      const current = (await f.read()).services[0];
      assert.equal(current.latest.revision, changed.revision);
      assert.equal(current.latest.observedAt, (base + 1) * MINUTE + 1000);
      assert.equal((await f.call('ready')).status, 200);
      observations.push({
        phase: 'target-revision-and-readiness',
        originalRevision: original.revision,
        equivalentRevision: equivalent.revision,
        changedRevision: changed.revision,
        oldObservationReadyStatus: missingCurrent.status,
        oldObservationReadiness: missingCurrent.data.monitoring.status,
        currentObservationReadyStatus: 200,
        createdPolicyHistoryRetained: true,
      });
    });
  },
);

test(
  'local forced eviction waits for the held monitor probe timeout and retains its completed check',
  { timeout: 30000 },
  async () => {
    await withRuntime('held-probe-native-eviction-drain', async (f) => {
      f.good(true);
      const held = f.holdProbe();
      const pending = f.tick(base).then(
        (value) => ({ kind: 'response', value }),
        () => ({ kind: 'rejected' }),
      );
      await f.bounded(held.began);
      const claimed = await f.sql('SELECT slot,done FROM jobs WHERE service=?', target.id);
      assert.deepEqual(claimed, [{ slot: base, done: 0 }]);
      await f.evict();
      assert.equal(held.returned, false);
      const persistedBeforeRelease = await f.sql(
        'SELECT slot,outcome,revision FROM checks WHERE service=? AND slot=?',
        target.id,
        base,
      );
      assert.deepEqual(persistedBeforeRelease, [{ slot: base, outcome: 'timeout', revision: 1 }]);
      held.release();
      const completed = await f.bounded(pending);
      assert.equal(completed.kind, 'response');
      assert.equal(completed.value.results[0].result, 'timeout');
      assert.deepEqual(await f.sql('SELECT slot,done FROM jobs WHERE service=?', target.id), [
        { slot: base, done: 1 },
      ]);
      await f.clock((base + 1) * MINUTE);
      const restored = (await f.read()).services[0];
      assert.equal(restored.revision, 1);
      assert.equal(restored.latest.outcome, 'timeout');
      await f.tick(base + 1);
      assert.equal((await f.read()).services[0].latest.revision, 1);
      assert.equal((await f.call('ready')).status, 200);
      observations.push({
        phase: 'held-probe-native-eviction-drain',
        claimedJobs: claimed.length,
        oldInvocation: completed.kind,
        oldOutcome: completed.value.results[0].result,
        originReturnedBeforeRelease: false,
        completedChecksAtEvictionReturn: persistedBeforeRelease.length,
        retainedCompletedJobs: 1,
        newObservationRevision: 1,
        recoveredReadyStatus: 200,
      });
    });
  },
);

test(
  'configuration reload during an actual held probe records its native lifecycle outcome',
  { timeout: 30000 },
  async () => {
    await withRuntime('held-probe-configuration-reload', async (f) => {
      f.good(true);
      const held = f.holdProbe();
      const pending = f.tick(base).then(
        (value) => ({ kind: 'response', value }),
        () => ({ kind: 'rejected' }),
      );
      await f.bounded(held.began);
      assert.deepEqual(await f.sql('SELECT slot,done FROM jobs WHERE service=?', target.id), [
        { slot: base, done: 0 },
      ]);
      await f.reload([{ ...target, url: 'https://origin.internal/replacement-health' }]);
      const changed = (await f.read()).services[0];
      const rowsAtReload = await f.sql(
        'SELECT slot,outcome,revision FROM checks WHERE service=? AND slot=?',
        target.id,
        base,
      );
      held.release();
      const completed = await f.bounded(pending);
      // Proxy rejection does not acknowledge native completion. Observe storage
      // again after the old probe's complete default timeout interval instead.
      await f.bounded(new Promise((resolve) => setTimeout(resolve, 3100)));
      const rowsAfterRelease = await f.sql(
        'SELECT slot,outcome,revision FROM checks WHERE service=? AND slot=?',
        target.id,
        base,
      );
      assert.equal(changed.revision, 2);
      assert.deepEqual(rowsAfterRelease, rowsAtReload);
      assert(rowsAfterRelease.every(({ revision }) => revision === 1));
      const ready = await f.call('ready');
      assert.equal(ready.status, 503);
      await f.tick(base + 1);
      assert.equal((await f.read()).services[0].latest.revision, 2);
      assert.equal((await f.call('ready')).status, 200);
      observations.push({
        phase: 'held-probe-configuration-reload',
        oldInvocation: completed.kind,
        oldResult: completed.kind === 'response' ? completed.value.results[0].result : 'rejected',
        changedRevision: changed.revision,
        checksAtReloadReturn: rowsAtReload.length,
        checksAfterRelease: rowsAfterRelease.length,
        observationWaitMs: 3100,
        currentRevisionChecksBeforeNewTick: 0,
        oldObservationReadyStatus: ready.status,
        newObservationRevision: 2,
        recoveredReadyStatus: 200,
      });
    });
  },
);

after(async () => {
  assert.deepEqual(await pins(Object.keys(sourcePins)), sourcePins);
  assert.deepEqual(await pins(recipePaths), recipePins);
  assert.equal(observations.length, 5);
  assert.equal(lifecycles.length, 5);
  assert(lifecycles.every(({ disposed, tempRemoved }) => disposed && tempRemoved));
  await mkdir('output/monitor-enrollment', { recursive: true });
  await writeFile(
    'output/monitor-enrollment/evidence.json',
    JSON.stringify(
      {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        sourceBase,
        sourcePins,
        recipePins,
        bundle: {
          bytes: Buffer.byteLength(script),
          sha256: hash(script),
          inputs: Object.keys(compilation.metafile.inputs).sort(),
          external: ['cloudflare:workers'],
        },
        sourceStableThroughDisposal: true,
        environment: {
          node: process.version,
          platform: process.platform,
          ...Object.fromEntries(
            await Promise.all(
              ['miniflare', 'esbuild', 'workerd'].map(async (name) => [
                name,
                JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version,
              ]),
            ),
          ),
          nativeLocalSQLite: true,
          accountCalls: 0,
        },
        boundary:
          'The unchanged tracked monitor-clock fixture overrides only the clock through native SQLite. Actual maintained MonitorStore executes with controlled configuration, synthetic Node ORIGIN service responses and native SQLite. Gateway code is bundled/exported; its fetch routes are not exercised. Configuration reloads use Miniflare.setOptions and fresh handles; no live instance environment is mutated. Reads use native Durable Object stub.fetch exports/readiness, not rendered browser or external HTTP. Local forced eviction waited for the monitor timeout completion and did not prevent its check insert. The separate held-probe reload samples persisted checks after release and a 3100ms wait; a proxy rejection alone is not a native completion acknowledgement. These operations do not execute or measure Cloudflare deployment propagation, global partitions, natural failure frequency, account costs or customer value. Installed native binaries are identified by package versions/lock rather than independently hashed.',
        lifecycles,
        observations,
      },
      null,
      2,
    ) + '\n',
  );
});
