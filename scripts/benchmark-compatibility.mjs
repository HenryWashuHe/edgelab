import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { build, version as esbuildVersion } from 'esbuild';
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare';

// This check deliberately accepts no URL, credentials, workload or output-path
// arguments. It never imports/executes benchmark.mjs or its artifact writer.
const root = fileURLToPath(new URL('..', import.meta.url));
const recipe = 'scripts/benchmark-compatibility.mjs';
const directory = 'output/benchmark-compatibility';
const clientTimeoutMs = 5000;
const overallTimeoutMs = 60000;
const disposalTimeoutMs = 10000;
const started = performance.now();
const controller = new AbortController();
const overallTimer = setTimeout(() => controller.abort(), overallTimeoutMs);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (path) => readFile(resolve(root, path));
const runtimes = [];
const privateCapabilities = [];
let stage = 'arguments';
let sequence = 0;
let totalOwnerCalls = 0;
let totalHealthCalls = 0;
let totalControlCalls = 0;
let totalDiagnosticCalls = 0;

class DeadlineFailure extends Error {
  constructor() {
    super('Local compatibility deadline exceeded');
  }
}
async function bounded(promise, maximumMs, cleanup = false) {
  const remaining = overallTimeoutMs - (performance.now() - started);
  const timeoutMs = cleanup ? maximumMs : Math.min(maximumMs, Math.max(1, remaining));
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineFailure()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function timeLeft() {
  if (controller.signal.aborted || performance.now() - started >= overallTimeoutMs)
    throw new DeadlineFailure();
}
const numeric = (value) => {
  assert(Number.isSafeInteger(value) && value >= 0);
  return value;
};
const pick = (value, keys) => Object.fromEntries(keys.map((key) => [key, numeric(value[key])]));
function publicMeter(raw) {
  // Only static numeric fields cross this boundary; no raw response/diagnostic
  // object, capability, request ID, source row, private payload or provider error.
  return {
    gateway: pick(raw.gateway, [
      'gatewayRequests',
      'namespaceIdFromName',
      'namespaceGet',
      'namespaceGetByName',
      'stubFetch',
      'stubCompleted',
      'stubFailed',
      'stubInFlight',
    ]),
    labConstructors: numeric(raw.labConstructors),
    sourceSql: pick(raw.lab.sql, [
      'attemptedStatements',
      'statements',
      'failedStatements',
      'rowsRead',
      'rowsWritten',
    ]),
    sourceOperations: pick(raw.lab.operations, [
      'kvGet',
      'kvPut',
      'kvDelete',
      'kvList',
      'storageGet',
      'storagePut',
      'storageDelete',
      'storageList',
      'storageDeleteAll',
      'alarmGet',
      'alarmSet',
      'alarmDelete',
      'transactionSync',
      'transactionSyncFailed',
    ]),
    origin: pick(raw.lab.nativeInvocations, [
      'originFetch',
      'originCompleted',
      'originFailed',
      'originInFlight',
    ]),
    labFetchesInFlight: numeric(raw.lab.labFetchesInFlight),
    nativeAdmission: pick(raw.nativeAdmission, ['owner', 'observer']),
  };
}

async function run() {
  assert.equal(process.argv.length, 2);
  stage = 'build-inputs';
  const options = {
    absWorkingDir: root,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    metafile: true,
    write: false,
    logLevel: 'silent',
  };
  const specifications = [
    {
      ...options,
      entryPoints: ['tests/fixtures/lab-admission.ts'],
      outfile: `${directory}/gateway.js`,
      external: ['cloudflare:workers'],
    },
    { ...options, entryPoints: ['worker/origin.ts'], outfile: `${directory}/origin.js` },
  ];
  const discovered = await bounded(
    Promise.all(specifications.map((specification) => build(specification))),
    10000,
  );
  const inputGraphs = Object.fromEntries(
    discovered.map((result, i) => [
      i === 0 ? 'gateway' : 'origin',
      Object.keys(result.metafile.inputs).sort(),
    ]),
  );
  const additionalInputs = [
    recipe,
    'scripts/benchmark-control.mjs',
    'scripts/benchmark.mjs',
    'package.json',
    'package-lock.json',
  ];
  const sourcePaths = [
    ...new Set([...Object.values(inputGraphs).flat(), ...additionalInputs]),
  ].sort();
  assert(
    sourcePaths.every(
      (path) =>
        !path.startsWith('/') && !path.startsWith('../') && !path.startsWith('node_modules/'),
    ),
  );
  const sourceSHA256 = Object.fromEntries(
    await bounded(
      Promise.all(sourcePaths.map(async (path) => [path, sha(await read(path))])),
      clientTimeoutMs,
    ),
  );
  const inputsCapturedBeforeBuildAt = new Date().toISOString();
  const historicalPaths = [
    'docs/evidence/benchmark-local.json',
    'docs/evidence/benchmark-live.json',
  ];
  const historicalBefore = await bounded(
    Promise.all(historicalPaths.map(async (path) => sha(await read(path)))),
    clientTimeoutMs,
  );
  const packageVersion = JSON.parse((await read('package.json')).toString()).version;
  assert.equal(typeof packageVersion, 'string');
  const { measureBenchmarkTrial } = await import('./benchmark-control.mjs');
  stage = 'build-workers';
  const built = await bounded(
    Promise.all(specifications.map((specification) => build(specification))),
    10000,
  );
  for (const [i, result] of built.entries())
    assert.deepEqual(
      Object.keys(result.metafile.inputs).sort(),
      inputGraphs[i === 0 ? 'gateway' : 'origin'],
    );
  const scripts = built.map((result) => result.outputFiles[0].text);
  const report = {
    schemaVersion: 1,
    kind: 'edgelab-local-benchmark-helper-compatibility',
    measuredAt: new Date().toISOString(),
    sourceProjectVersion: packageVersion,
    environment: {
      node: process.version,
      esbuild: esbuildVersion,
      miniflare: JSON.parse((await read('node_modules/miniflare/package.json')).toString()).version,
      workerd: JSON.parse((await read('node_modules/workerd/package.json')).toString()).version,
      compatibilityDate: '2026-09-01',
      remoteCalls: 0,
      productionCalls: 0,
      nativeInferenceCalls: 0,
    },
    deadlines: { clientTimeoutMs, overallTimeoutMs, disposalTimeoutMs },
    provenance: {
      sourceSHA256,
      inputGraphs,
      additionalInputs,
      inputsCapturedBeforeBuildAt,
      bundleSHA256: { gateway: sha(scripts[0]), origin: sha(scripts[1]) },
      metafileSHA256: {
        gateway: sha(JSON.stringify(built[0].metafile)),
        origin: sha(JSON.stringify(built[1].metafile)),
      },
      buildWrite: false,
      boundary:
        'Complete project-local Worker build input hashes plus exact helper/CLI/recipe/package/lock. Actual gateway/Lab/origin imports, with tracked local admission instrumentation only. Installed runtime binaries are identified by versions/lock, not independently hashed. Native limiter internal SQLite and diagnostic reads are outside Lab source measurement.',
    },
    assertions: [],
    samples: [],
    observedGatewayVersions: [],
    limitations: [
      'Two concurrency2 compatibility cohorts, not a performance benchmark or production capacity measurement.',
      'Local native RateLimit uses Miniflare SQLite-backed counters. Production limits are permissive, per location and eventually consistent; local2/60 is not the deployed allowance.',
      'Receipt sequence proves local settlement ordering; client timing is descriptive only. No production network/CPU/account/billing/browser claim.',
      'Failed cohort legitimately commits the admitted origin sibling. Its pre-Lab refusal never becomes an engine-limited event; zero writes is not claimed for the whole cohort.',
      'Only a successful ignored compatibility report is written. The benchmark CLI/sample-report writer and historical artifacts remain untouched.',
    ],
  };

  async function runtime(enabled) {
    timeLeft();
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        log: new Log(LogLevel.NONE),
        telemetry: { enabled: false },
        workers: [
          {
            name: 'gateway',
            modules: true,
            script: scripts[0],
            compatibilityDate: '2026-09-01',
            durableObjects: {
              LABS: { className: 'ReliabilityLab', useSQLite: true },
              MONITORS: { className: 'MonitorStore', useSQLite: true },
            },
            bindings: {
              AI_BRIEFS_ENABLED: 'false',
              LAB_ADMISSION_ENABLED: enabled ? 'true' : 'false',
              MONITOR_TARGETS: '[]',
            },
            serviceBindings: { ORIGIN: 'origin' },
            ratelimits: {
              LAB_OWNER_LIMITER: { namespace_id: '22001', simple: { limit: 2, period: 60 } },
              LAB_OBSERVER_LIMITER: { namespace_id: '22002', simple: { limit: 1, period: 60 } },
            },
          },
          {
            name: 'origin',
            modules: true,
            script: scripts[1],
            compatibilityDate: '2026-09-01',
          },
        ],
      }),
    );
    runtimes.push(mf);
    await bounded(mf.ready, 10000);
    const dispatch = (url, init = {}) => {
      timeLeft();
      return bounded(
        mf.dispatchFetch(url, {
          ...init,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(clientTimeoutMs)]),
        }),
        clientTimeoutMs,
      );
    };
    const health = await dispatch('http://localhost/api/health');
    totalHealthCalls++;
    assert.equal(health.status, 200);
    const healthBody = await bounded(health.json(), clientTimeoutMs);
    assert.equal(healthBody.version, packageVersion);
    report.observedGatewayVersions.push(healthBody.version);
    const reset = await dispatch('http://localhost/__fixture/admission-reset', { method: 'POST' });
    totalControlCalls++;
    assert.equal(reset.status, 200);
    assert.equal((await bounded(reset.json(), clientTimeoutMs)).ok, true);
    const id = randomUUID(); // capability stays in process
    privateCapabilities.push(id);
    const calls = [];
    let inFlight = 0;
    const call = async (path, body) => {
      assert(totalOwnerCalls < 7);
      totalOwnerCalls++;
      inFlight++;
      const item = { path, completedSequence: null, status: null };
      calls.push(item);
      try {
        const response = await dispatch(`http://localhost/api/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'X-Lab-ID': id,
            Origin: 'http://localhost',
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        item.completedSequence = ++sequence;
        item.status = response.status;
        return response;
      } finally {
        inFlight--;
      }
    };
    const meter = async () => {
      const response = await dispatch('http://localhost/__fixture/admission-meter');
      totalControlCalls++;
      assert.equal(response.status, 200);
      return publicMeter(await bounded(response.json(), clientTimeoutMs));
    };
    const inspect = async () => {
      // Meter snapshot precedes this separate diagnostic; sourceHash/state rows
      // and private IDs are never copied into the report.
      const namespace = await bounded(
        mf.getDurableObjectNamespace('LABS', 'gateway'),
        clientTimeoutMs,
      );
      const response = await bounded(
        namespace.get(namespace.idFromName(id)).fetch('http://local.fixture/__fixture/inspect'),
        clientTimeoutMs,
      );
      totalDiagnosticCalls++;
      assert.equal(response.status, 200);
      return bounded(response.json(), clientTimeoutMs);
    };
    return { call, calls, meter, inspect, inFlight: () => inFlight };
  }

  stage = 'healthy-runtime';
  const healthyRuntime = await runtime(false);
  stage = 'healthy-trial';
  const healthy = await bounded(measureBenchmarkTrial(healthyRuntime.call, 2), 10000);
  const healthyMeter = await healthyRuntime.meter();
  assert.equal(healthy.accepted, 2);
  assert.equal(healthy.limited, 0);
  assert.equal(healthy.originCalls, 2);
  assert.deepEqual(
    healthyRuntime.calls.map((call) => call.path),
    ['config', 'request', 'request', 'state'],
  );
  assert.equal(healthyMeter.nativeAdmission.owner, 0);
  assert.equal(healthyMeter.origin.originCompleted, 2);
  assert.equal(healthyMeter.origin.originInFlight, 0);
  assert.equal(healthyMeter.labFetchesInFlight, 0);
  assert(healthyMeter.sourceSql.statements > 0 && healthyMeter.sourceSql.rowsWritten > 0);
  report.samples.push({
    scenario: 'healthy-legacy-bypass',
    concurrency: 2,
    returnedSample: healthy,
    meter: healthyMeter,
  });
  report.assertions.push(
    'Actual native outcomes/trace/source headers and exact SQLite state/history pass the helper',
  );

  stage = 'admission-runtime';
  const gated = await runtime(true);
  stage = 'minute-headroom';
  // Check AFTER mf.ready, health and meter setup. Wait once before any gated
  // owner call; no failed POST, request replay or admission-backoff loop.
  const remaining = 60000 - (Date.now() % 60000);
  if (remaining < 15000)
    await bounded(new Promise((done) => setTimeout(done, remaining + 20)), 15050);
  timeLeft();
  assert(60000 - (Date.now() % 60000) >= 15000);
  const slot = Math.floor(Date.now() / 60000);
  const returned = [];
  let rejectionSequence = null;
  let sanitizedFailure = false;
  stage = 'admission-trial';
  await assert.rejects(
    bounded(
      measureBenchmarkTrial(gated.call, 2).then((sample) => returned.push(sample)),
      10000,
    ),
    (error) => {
      rejectionSequence = ++sequence;
      sanitizedFailure =
        error instanceof Error &&
        error.message.includes(
          'gateway admission refused the request call before reaching the Lab',
        ) &&
        error.message.includes('No completed benchmark report is produced') &&
        privateCapabilities.every((id) => !error.message.includes(id));
      return sanitizedFailure;
    },
  );
  assert.equal(Math.floor(Date.now() / 60000), slot);
  const gatedMeter = await gated.meter();
  assert.equal(returned.length, 0);
  assert.equal(gated.inFlight(), 0);
  assert.deepEqual(
    gated.calls.map((call) => call.path),
    ['config', 'request', 'request'],
  );
  assert.deepEqual(
    gated.calls
      .slice(1)
      .map((call) => call.status)
      .sort(),
    [200, 429],
  );
  const refused = gated.calls.find((call) => call.status === 429);
  const admitted = gated.calls.find((call) => call.path === 'request' && call.status === 200);
  assert(refused.completedSequence < admitted.completedSequence);
  assert(rejectionSequence > admitted.completedSequence);
  assert.equal(gatedMeter.nativeAdmission.owner, 3);
  assert.equal(gatedMeter.gateway.stubFetch, 2);
  assert.equal(gatedMeter.gateway.stubInFlight, 0);
  assert.equal(gatedMeter.origin.originFetch, 1);
  assert.equal(gatedMeter.origin.originCompleted, 1);
  assert.equal(gatedMeter.origin.originInFlight, 0);
  assert.equal(gatedMeter.labFetchesInFlight, 0);
  stage = 'separate-diagnostics';
  const frozen = await gated.inspect();
  assert.equal(frozen.eventCount, 1);
  assert.equal(frozen.state.total, 1);
  assert.equal(frozen.state.originCalls, 1);
  assert.equal(frozen.state.counts.origin, 1);
  assert.equal(frozen.state.counts.limited, 0);
  report.samples.push({
    scenario: 'native-admission-refusal-with-settled-sibling',
    concurrency: 2,
    nativeOwnerLimit: 2,
    periodSeconds: 60,
    returnedSampleCount: 0,
    stateRouteCallsAfterRefusal: 0,
    refusedBeforeAdmittedSibling: true,
    rejectionAfterSiblingCompletion: true,
    sanitizedFailure,
    persistedDecisions: { total: 1, origin: 1, engineLimited: 0, events: 1 },
    meter: gatedMeter,
  });
  report.assertions.push(
    'Native pre-Lab refusal is sanitized and never counted as a committed engine-limited event',
  );
  report.assertions.push(
    'Helper rejection follows the real origin sibling settlement, with no state call/sample/retry/benchmark writer',
  );
  return { report, sourcePaths, sourceSHA256, historicalPaths, historicalBefore };
}

let result;
let failure;
try {
  result = await run();
} catch (error) {
  failure = {
    stage,
    code: error instanceof DeadlineFailure ? 'deadline-exceeded' : 'check-failed',
  };
} finally {
  controller.abort();
  clearTimeout(overallTimer);
  try {
    const disposed = await bounded(
      Promise.allSettled(runtimes.map((mf) => mf.dispose())),
      disposalTimeoutMs,
      true,
    );
    if (!disposed.every((item) => item.status === 'fulfilled'))
      failure = { stage: 'dispose-runtimes', code: 'check-failed' };
  } catch {
    failure = { stage: 'dispose-runtimes', code: 'deadline-exceeded' };
  }
}
if (!failure) {
  try {
    stage = 'source-stability';
    const { report, sourcePaths, sourceSHA256, historicalPaths, historicalBefore } = result;
    const after = Object.fromEntries(
      await bounded(
        Promise.all(sourcePaths.map(async (path) => [path, sha(await read(path))])),
        clientTimeoutMs,
      ),
    );
    assert.deepEqual(after, sourceSHA256);
    const historicalAfter = await bounded(
      Promise.all(historicalPaths.map(async (path) => sha(await read(path)))),
      clientTimeoutMs,
    );
    assert.deepEqual(historicalAfter, historicalBefore);
    assert.equal(totalOwnerCalls, 7);
    report.calls = {
      owner: totalOwnerCalls,
      health: totalHealthCalls,
      controls: totalControlCalls,
      diagnostics: totalDiagnosticCalls,
    };
    report.sourceStableDuringRun = true;
    report.ephemeralRuntimesDisposed = true;
    report.historicalArtifactsUnchanged = true;
    report.benchmarkWriterInvocations = 0;
    stage = 'privacy';
    const serialized = JSON.stringify(report, null, 2) + '\n';
    assert(privateCapabilities.every((id) => !serialized.includes(id)));
    assert(
      !/X-Lab-ID|requestId|cachedPayload|OPERATOR_TOKEN|private-error-canary/.test(serialized),
    );
    stage = 'publish-report';
    await bounded(mkdir(resolve(root, directory), { recursive: true }), clientTimeoutMs);
    const file = resolve(root, `${directory}/result.json`);
    const temporary = `${file}.tmp`;
    try {
      await bounded(writeFile(temporary, serialized), clientTimeoutMs);
      await bounded(rename(temporary, file), clientTimeoutMs);
    } finally {
      await bounded(rm(temporary, { force: true }), clientTimeoutMs);
    }
    console.log(JSON.stringify({ passed: 3, scenarios: 2, ownerCalls: 7, allDisposed: true }));
  } catch (error) {
    failure = {
      stage,
      code: error instanceof DeadlineFailure ? 'deadline-exceeded' : 'check-failed',
    };
  }
}
if (failure) {
  // No arbitrary exception value, message, stack or raw response crosses here.
  console.error(JSON.stringify({ ok: false, stage: failure.stage, code: failure.code }));
  process.exitCode = 1;
}
