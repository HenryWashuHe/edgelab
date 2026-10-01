import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build, version as esbuildVersion } from 'esbuild';

// This is a bounded local cost recipe, not a load generator for a deployed URL.
if (process.argv.length !== 2)
  throw new Error('This isolated recipe accepts no remote URL or workload arguments');
const directory = 'output/lab-storm';
const bundles = { gateway: `${directory}/gateway.js`, origin: `${directory}/origin.js` };
await mkdir(directory, { recursive: true });
const buildOptions = [
  {
    entryPoints: ['tests/fixtures/lab-storm.ts'],
    outfile: bundles.gateway,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    external: ['cloudflare:workers'],
    metafile: true,
  },
  {
    entryPoints: ['worker/origin.ts'],
    outfile: bundles.origin,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    metafile: true,
  },
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Discover both complete dependency graphs without publishing bundles. Hash
// every project input BEFORE the actual tested build, then require its graph
// to match discovery and its inputs to remain identical after the runtime run.
const discovered = await Promise.all(
  buildOptions.map((options) => build({ ...options, write: false })),
);
const inputGraphs = Object.fromEntries(
  discovered.map((result, index) => [
    index === 0 ? 'gateway' : 'origin',
    Object.keys(result.metafile.inputs).sort(),
  ]),
);
const additionalInputs = ['scripts/lab-storm.mjs', 'package.json', 'package-lock.json'];
const sourcePaths = [
  ...new Set([...Object.values(inputGraphs).flat(), ...additionalInputs]),
].sort();
assert(
  sourcePaths.every(
    (path) => !path.startsWith('/') && !path.startsWith('../') && !path.startsWith('node_modules/'),
  ),
  'Build inputs remain project-local',
);
const sourceSHA256 = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(path))])),
);
const inputsCapturedBeforeBuildAt = new Date().toISOString();
const built = await Promise.all(buildOptions.map((options) => build(options)));
for (const [index, result] of built.entries())
  assert.deepEqual(
    Object.keys(result.metafile.inputs).sort(),
    inputGraphs[index === 0 ? 'gateway' : 'origin'],
    'Tested build graph matches pre-hashed discovery inputs',
  );
const metafileSHA256 = Object.fromEntries(
  built.map((result, index) => [
    index === 0 ? 'gateway' : 'origin',
    hash(JSON.stringify(result.metafile)),
  ]),
);
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const outcomes = ['origin', 'stale', 'limited', 'blocked', 'error'];
const operationKeys = [
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
];
const gatewayKeys = [
  'gatewayRequests',
  'namespaceIdFromName',
  'namespaceGet',
  'namespaceGetByName',
  'stubFetch',
  'stubCompleted',
  'stubFailed',
  'stubInFlight',
];
const sqlKeys = [
  'attemptedStatements',
  'statements',
  'failedStatements',
  'rowsRead',
  'rowsWritten',
];
const nativeKeys = ['originFetch', 'originCompleted', 'originFailed', 'originInFlight'];
const number = (value, label) => {
  assert(Number.isSafeInteger(value) && value >= 0, `Invalid numeric fixture counter: ${label}`);
  return value;
};
const numericProjection = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, number(value[key], key)]));
const stateCounters = (state) => ({
  total: number(state.total, 'total'),
  originCalls: number(state.originCalls, 'originCalls'),
  counts: numericProjection(state.counts, outcomes),
});
const sum = (values) => Object.values(values).reduce((total, value) => total + value, 0);
function meterProjection(value) {
  return {
    sql: { ...numericProjection(value.sql, sqlKeys), failedCursorCost: null },
    operations: numericProjection(value.operations, operationKeys),
    nativeInvocations: numericProjection(value.nativeInvocations, nativeKeys),
    diagnostics: {
      scope: 'cumulative-local-controls-only',
      sql: { ...numericProjection(value.diagnostics.sql, sqlKeys), failedCursorCost: null },
      operations: numericProjection(value.diagnostics.operations, operationKeys),
    },
  };
}
function aggregateMeters(meters) {
  const projected = meters.map(meterProjection);
  const aggregate = (pick, keys) =>
    Object.fromEntries(
      keys.map((key) => [key, projected.reduce((total, meter) => total + pick(meter)[key], 0)]),
    );
  return {
    sql: { ...aggregate((meter) => meter.sql, sqlKeys), failedCursorCost: null },
    operations: aggregate((meter) => meter.operations, operationKeys),
    nativeInvocations: aggregate((meter) => meter.nativeInvocations, nativeKeys),
    diagnostics: {
      scope: 'cumulative-local-controls-only',
      sql: { ...aggregate((meter) => meter.diagnostics.sql, sqlKeys), failedCursorCost: null },
      operations: aggregate((meter) => meter.diagnostics.operations, operationKeys),
    },
  };
}
function responseCounts(responses) {
  const counts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
  const statuses = { 200: 0, 429: 0, 502: 0, 503: 0, 504: 0 };
  for (const response of responses) {
    assert(Object.hasOwn(counts, response.data.outcome), 'Unexpected experiment outcome');
    assert(Object.hasOwn(statuses, response.status), 'Unexpected experiment status');
    counts[response.data.outcome]++;
    statuses[response.status]++;
  }
  return { counts, statuses };
}
function reconcile(before, after, responses, meter) {
  const counted = responseCounts(responses);
  assert.equal(after.total - before.total, responses.length, 'Every decision counted once');
  for (const outcome of outcomes)
    assert.equal(
      after.counts[outcome] - before.counts[outcome],
      counted.counts[outcome],
      'Stored outcome delta matches completed responses',
    );
  assert.equal(sum(after.counts), after.total, 'Every admitted/denied request settled');
  assert.equal(
    after.originCalls - before.originCalls,
    meter.nativeInvocations.originFetch,
    'Stored origin count matches delegated calls',
  );
  assert.equal(
    meter.nativeInvocations.originCompleted + meter.nativeInvocations.originFailed,
    meter.nativeInvocations.originFetch,
    'Every service call settled',
  );
  assert.equal(meter.nativeInvocations.originInFlight, 0, 'No service call left in flight');
  return counted;
}
const report = {
  schemaVersion: 1,
  kind: 'edgelab-local-lab-workload-cost',
  measuredAt: new Date().toISOString(),
  recipe: 'node scripts/lab-storm.mjs',
  sourceProjectVersion: packageVersion,
  observedGatewayVersion: null,
  environment: {
    node: process.version,
    miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
    workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
    esbuild: esbuildVersion,
    compatibilityDate: '2026-09-01',
    transport:
      'Actual production gateway via Miniflare.dispatchFetch and real private origin Worker service binding',
    storage: 'Ephemeral native workerd SQLite Durable Objects',
    accountCalls: 0,
    productionRequests: 0,
    nativeInferenceCalls: 0,
    remoteRequestCfRefresh: false,
    telemetry: false,
  },
  sourceSHA256,
  provenance: {
    inputsCapturedBeforeBuildAt,
    inputGraphs,
    additionalInputs,
    metafileSHA256,
    boundary:
      'Complete project-local esbuild inputs for both tested Worker bundles, plus recipe and package files. Installed library binaries are described by versions and lockfile, not independently hashed; deployed resources and account state are outside this evidence.',
  },
  bundleSHA256: Object.fromEntries(
    await Promise.all(
      Object.entries(bundles).map(async ([name, path]) => [name, hash(await readFile(path))]),
    ),
  ),
  workload: {
    maximumObjects: 8,
    freshObjectFanout: 6,
    sameRunBurstRequests: 24,
    repeatedEmptyStateReads: 24,
    circuitDeniedRequests: 8,
    retentionRequests: 208,
    repeatedRetainedStateReads: 8,
    eventRetentionLimit: 180,
  },
  assertions: [],
  samples: [],
  limitations: [
    'A bounded local workload, not customer traffic, sustained throughput, a denial-of-service test or a prediction of account capacity.',
    'SQL counts come from fully consumed native cursors, including triggers. Native failed attempts have no cursor cost; API invocations are separate from billed SQL rows.',
    'KV, alarm, synchronous transaction, namespace lookup and stub dispatch counts are actual delegated API invocations, not physical operation, CPU or billing measurements.',
    'Fixture inspections use original native methods and separate diagnostic counters outside measured owner workloads. They do not seed state, replace clocks or bypass source SQL.',
    'Origin fetch completion means its native service call resolved, including a controlled non-200 response; stored HTTP outcomes establish success or failure.',
    'Real wall time/refill can alter admitted counts. Requests are bounded and reconciliation uses actual responses and authoritative stored counters.',
    'Eviction uses the supported local testing API. Source parity after constructor recreation does not prove production eviction timing or backup recovery.',
    'No capability, object/run/event/request identifier, payload, raw SQL text, target URL or private snapshot is included in this report.',
  ],
};
const pass = (label) => {
  report.assertions.push(label);
  console.log(JSON.stringify({ passed: label }));
};
const caps = [];
const fresh = () => {
  assert(caps.length < report.workload.maximumObjects, 'Bounded number of isolated objects');
  const value = randomUUID();
  assert(!caps.includes(value), 'Distinct isolated capabilities');
  caps.push(value);
  return value;
};
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    telemetry: { enabled: false },
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: bundles.gateway,
        compatibilityDate: '2026-09-01',
        durableObjects: {
          LABS: { className: 'ReliabilityLab', useSQLite: true },
          MONITORS: { className: 'MonitorStore', useSQLite: true },
        },
        bindings: { AI_BRIEFS_ENABLED: 'false' },
        serviceBindings: { ORIGIN: 'origin' },
      },
      {
        name: 'origin',
        modules: true,
        scriptPath: bundles.origin,
        compatibilityDate: '2026-09-01',
      },
    ],
  }),
);
try {
  const namespace = await mf.getDurableObjectNamespace('LABS', 'gateway');
  const lab = (capability) => namespace.get(namespace.idFromName(capability));
  const fixture = async (capability, path, method = 'GET') => {
    const response = await lab(capability).fetch(`https://lab.internal/__fixture/${path}`, {
      method,
    });
    assert.equal(response.status, 200, 'Local fixture control succeeded');
    return response.json();
  };
  const gateway = async (reset = false) => {
    const response = await mf.dispatchFetch(
      `https://edgelab.example/__fixture/gateway-meter${reset ? '-reset' : ''}`,
      { method: reset ? 'POST' : 'GET' },
    );
    assert.equal(response.status, 200, 'Gateway instrumentation available');
    const data = await response.json();
    if (reset) {
      assert.equal(data.ok, true, 'Gateway meter reset acknowledged');
      return null;
    }
    return numericProjection(data, gatewayKeys);
  };
  const call = async (capability, action, body) => {
    const response = await mf.dispatchFetch(`https://edgelab.example/api/${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Lab-ID': capability, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const state = async (capability) => {
    const inspection = await fixture(capability, 'inspect');
    assert(inspection.state !== null, 'Authoritative run exists');
    return inspection;
  };
  const reset = async (capabilities) => {
    for (const capability of capabilities) await fixture(capability, 'meter-reset', 'POST');
    await gateway(true);
  };
  const settledGateway = (value, requests) => {
    assert.equal(value.gatewayRequests, requests);
    assert.equal(value.namespaceIdFromName, requests);
    assert.equal(value.namespaceGet + value.namespaceGetByName, requests);
    assert.equal(value.stubFetch, requests);
    assert.equal(value.stubCompleted, requests);
    assert.equal(value.stubFailed, 0);
    assert.equal(value.stubInFlight, 0);
  };
  const health = await mf.dispatchFetch('https://edgelab.example/api/health');
  assert.equal(health.status, 200);
  report.observedGatewayVersion = (await health.json()).version;
  assert.equal(
    report.observedGatewayVersion,
    packageVersion,
    'Actual gateway/package version agreement',
  );

  const existing = fresh();
  const constructor = await fixture(existing, 'meter');
  const absent = await fixture(existing, 'inspect');
  assert(absent.state === null, 'Constructor/control reads cannot enroll a run');
  assert.equal(absent.eventCount, 0);
  assert.equal(absent.expiresAt, null);
  assert.equal(absent.alarmAt, null);
  assert(constructor.sql.statements > 0, 'Real constructor/schema work recorded separately');
  report.samples.push({
    scenario: 'cold-constructor',
    objectCount: 1,
    ownerRequests: 0,
    ...meterProjection(constructor),
  });
  await reset([existing]);
  const enrolled = await call(existing, 'state');
  assert.equal(enrolled.status, 200);
  const enrolledMeter = await fixture(existing, 'meter');
  const enrolledGateway = await gateway();
  settledGateway(enrolledGateway, 1);
  assert.equal(enrolled.data.state.total, 0);
  assert.equal(sum(enrolled.data.state.counts), 0);
  assert.equal(enrolled.data.events.length, 0);
  assert(enrolledMeter.operations.kvPut > 0 && enrolledMeter.operations.alarmSet > 0);
  report.samples.push({
    scenario: 'first-owner-state-enrollment',
    objectCount: 1,
    ownerRequests: 1,
    gateway: enrolledGateway,
    ...meterProjection(enrolledMeter),
  });
  pass(
    'Constructor/read-only controls do not enroll; the first real owner GET commits state and idle lease',
  );

  await reset([existing]);
  const beforeReads = stateCounters((await state(existing)).state);
  for (let index = 0; index < 24; index++) {
    const read = await call(existing, 'state');
    assert.equal(read.status, 200);
    assert.equal(read.data.state.total, 0);
  }
  const afterReads = stateCounters((await state(existing)).state);
  const readMeter = await fixture(existing, 'meter');
  const readGateway = await gateway();
  settledGateway(readGateway, 24);
  assert.deepEqual(afterReads, beforeReads, 'Repeated owner reads preserve decision counters');
  assert.equal(readMeter.nativeInvocations.originFetch, 0);
  assert(readMeter.sql.rowsWritten > 0, 'Existing owner GETs really renew source state');
  report.samples.push({
    scenario: 'repeated-existing-empty-state-gets',
    objectCount: 1,
    ownerRequests: 24,
    gateway: readGateway,
    ...meterProjection(readMeter),
    countersUnchanged: true,
  });
  pass(
    'Twenty-four existing owner GETs perform their measured real storage/lease work without origin calls',
  );

  assert.equal(
    (
      await call(existing, 'config', {
        capacity: 12,
        refillPerSecond: 1,
        originLatencyMs: 20,
        originTimeoutMs: 1000,
        originMode: 'healthy',
        staleFallback: false,
      })
    ).status,
    200,
  );
  const beforeBurst = stateCounters((await state(existing)).state);
  await reset([existing]);
  const started = performance.now();
  const burst = await Promise.all(Array.from({ length: 24 }, () => call(existing, 'request', {})));
  const wallMs = performance.now() - started;
  const burstInspection = await state(existing);
  const burstMeter = await fixture(existing, 'meter');
  const burstGateway = await gateway();
  settledGateway(burstGateway, 24);
  const burstOutcomes = reconcile(
    beforeBurst,
    stateCounters(burstInspection.state),
    burst,
    burstMeter,
  );
  assert.equal(burstOutcomes.counts.origin + burstOutcomes.counts.limited, 24);
  assert(burstOutcomes.counts.origin > 0 && burstOutcomes.counts.limited > 0);
  assert(
    burstOutcomes.counts.origin <= 12 + Math.floor(wallMs / 1000),
    'Capacity plus actual maximum elapsed refill bound',
  );
  assert.equal(burstInspection.eventCount, 24);
  report.samples.push({
    scenario: 'same-run-concurrent-burst',
    objectCount: 1,
    ownerRequests: 24,
    initialCapacity: 12,
    refillPerSecond: 1,
    configuredOriginDelayMs: 20,
    elapsedLocalMs: Math.round(wallMs * 100) / 100,
    responses: burstOutcomes,
    gateway: burstGateway,
    ...meterProjection(burstMeter),
    countersReconciled: true,
  });
  pass(
    'Concurrent same-run burst reconciles every stored outcome and delegated origin call within capacity/refill bounds',
  );

  const denied = fresh();
  assert.equal(
    (
      await call(denied, 'config', {
        capacity: 12,
        refillPerSecond: 1,
        failureThreshold: 1,
        cooldownMs: 15000,
        originLatencyMs: 20,
        originTimeoutMs: 1000,
        originMode: 'failing',
        staleFallback: false,
      })
    ).status,
    200,
  );
  const open = await call(denied, 'request', {});
  assert.equal(open.status, 502);
  assert.equal(open.data.outcome, 'error');
  const deniedBefore = stateCounters((await state(denied)).state);
  await reset([denied]);
  const refusals = await Promise.all(Array.from({ length: 8 }, () => call(denied, 'request', {})));
  const deniedAfter = await state(denied);
  const deniedMeter = await fixture(denied, 'meter');
  const deniedGateway = await gateway();
  settledGateway(deniedGateway, 8);
  const deniedOutcomes = reconcile(
    deniedBefore,
    stateCounters(deniedAfter.state),
    refusals,
    deniedMeter,
  );
  assert.equal(deniedOutcomes.counts.blocked + deniedOutcomes.counts.limited, 8);
  assert.equal(
    deniedMeter.nativeInvocations.originFetch,
    0,
    'Denials bypass actual private Worker',
  );
  assert(deniedMeter.sql.rowsWritten > 0 && deniedMeter.operations.alarmSet > 0);
  report.samples.push({
    scenario: 'denied-valid-requests-no-origin',
    objectCount: 1,
    ownerRequests: 8,
    responses: deniedOutcomes,
    gateway: deniedGateway,
    ...meterProjection(deniedMeter),
    countersReconciled: true,
  });
  pass(
    'Valid denied requests avoid origin work while their source decisions and lease renewals still incur measured storage work',
  );

  const retentionBefore = stateCounters(deniedAfter.state);
  await reset([denied]);
  const retentionResponses = [];
  for (let batch = 0; batch < 208; batch += 16)
    retentionResponses.push(
      ...(await Promise.all(Array.from({ length: 16 }, () => call(denied, 'request', {})))),
    );
  const retained = await state(denied);
  const retentionMeter = await fixture(denied, 'meter');
  const retentionGateway = await gateway();
  settledGateway(retentionGateway, 208);
  const retentionOutcomes = reconcile(
    retentionBefore,
    stateCounters(retained.state),
    retentionResponses,
    retentionMeter,
  );
  assert.equal(retained.eventCount, 180);
  assert.equal(retained.events.length, 180);
  assert.equal(new Set(retained.events.map((event) => event.id)).size, 180);
  assert(retained.state.total > 180, 'All-run counters survive bounded event pruning');
  report.samples.push({
    scenario: 'bounded-event-retention',
    objectCount: 1,
    ownerRequests: 208,
    retainedEvents: retained.eventCount,
    allRunTotal: retained.state.total,
    responses: retentionOutcomes,
    gateway: retentionGateway,
    ...meterProjection(retentionMeter),
    countersReconciled: true,
  });
  pass(
    'Two hundred eight bounded decisions retain exactly 180 distinct events while preserving all-run counters',
  );

  await reset([denied]);
  const retainedCounters = stateCounters(retained.state);
  for (let index = 0; index < 8; index++) {
    const read = await call(denied, 'state');
    assert.equal(read.status, 200);
    assert.equal(read.data.events.length, 180);
  }
  const afterRetainedReads = await state(denied);
  const retainedReadMeter = await fixture(denied, 'meter');
  const retainedReadGateway = await gateway();
  settledGateway(retainedReadGateway, 8);
  assert.deepEqual(stateCounters(afterRetainedReads.state), retainedCounters);
  assert.equal(retainedReadMeter.nativeInvocations.originFetch, 0);
  report.samples.push({
    scenario: 'repeated-retained-state-gets',
    objectCount: 1,
    ownerRequests: 8,
    retainedEventsPerResponse: 180,
    gateway: retainedReadGateway,
    ...meterProjection(retainedReadMeter),
    countersUnchanged: true,
  });
  pass(
    'Eight mature owner reads return 180 retained events and preserve decisions with zero origin calls',
  );

  const fanout = Array.from({ length: 6 }, fresh);
  await gateway(true);
  const freshResponses = await Promise.all(fanout.map((capability) => call(capability, 'state')));
  for (const response of freshResponses) {
    assert.equal(response.status, 200);
    assert.equal(response.data.state.total, 0);
    assert.equal(response.data.events.length, 0);
  }
  const fanoutMeters = await Promise.all(
    fanout.map(async (capability) => {
      const inspection = await state(capability);
      assert.equal(inspection.state.total, 0);
      assert.equal(inspection.state.originCalls, 0);
      assert.equal(inspection.eventCount, 0);
      return fixture(capability, 'meter');
    }),
  );
  assert.equal(
    new Set(fanoutMeters.map((meter) => meter.bootId)).size,
    6,
    'Six distinct native coordinator instances',
  );
  const fanoutGateway = await gateway();
  settledGateway(fanoutGateway, 6);
  const freshCost = aggregateMeters(fanoutMeters);
  assert.equal(freshCost.nativeInvocations.originFetch, 0);
  assert(freshCost.sql.rowsWritten > 0);
  report.samples.push({
    scenario: 'bounded-fresh-object-fanout',
    objectCount: 6,
    ownerRequests: 6,
    gateway: fanoutGateway,
    ...freshCost,
    emptyIndependentRuns: true,
    includesConstructorAndEnrollment: true,
  });
  pass(
    'Six actual fresh capabilities create six independent empty runs; every namespace lookup and dispatch delegates to workerd',
  );

  const beforeEviction = await state(existing);
  const beforeBoot = (await fixture(existing, 'meter')).bootId;
  await mf.unsafeEvictDurableObject('gateway', 'ReliabilityLab', { name: existing });
  const coldMeter = await fixture(existing, 'meter');
  const afterEviction = await state(existing);
  assert(coldMeter.bootId !== beforeBoot, 'Actual constructor recreated');
  assert(
    beforeEviction.sourceHash === afterEviction.sourceHash,
    'Complete native source/deadline/alarm hash unchanged across eviction',
  );
  assert.deepEqual(stateCounters(beforeEviction.state), stateCounters(afterEviction.state));
  assert.equal(beforeEviction.eventCount, afterEviction.eventCount);
  report.samples.push({
    scenario: 'eviction-constructor',
    objectCount: 1,
    ownerRequests: 0,
    ...meterProjection(coldMeter),
    fullSourceParity: true,
  });
  await reset([existing]);
  const recovered = await call(existing, 'state');
  assert.equal(recovered.status, 200);
  assert.deepEqual(stateCounters(recovered.data.state), stateCounters(beforeEviction.state));
  const recoveryMeter = await fixture(existing, 'meter');
  const recoveryGateway = await gateway();
  settledGateway(recoveryGateway, 1);
  report.samples.push({
    scenario: 'first-owner-get-after-eviction',
    objectCount: 1,
    ownerRequests: 1,
    gateway: recoveryGateway,
    ...meterProjection(recoveryMeter),
    countersPreserved: true,
  });
  pass(
    'Actual eviction recreates the constructor without changing full persisted source; the next real owner read preserves counters',
  );
  assert.equal(caps.length, 8);
} finally {
  await mf.dispose();
}
const finalSources = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(path))])),
);
assert.deepEqual(finalSources, sourceSHA256, 'Measured source files stayed unchanged');
report.sourceStableDuringRun = true;
const text = JSON.stringify(report, null, 2) + '\n';
for (const capability of caps) assert(!text.includes(capability), 'Report omits all capabilities');
for (const key of ['runId', 'requestId', 'payload', 'cachedPayload', 'bootId', 'sourceHash'])
  assert(
    !text.includes(`"${key}":`),
    'Published report excludes private identifiers/source bodies',
  );
await writeFile(`${directory}/results.json`, text);
console.log(
  JSON.stringify({
    result: 'passed',
    assertions: report.assertions.length,
    samples: report.samples.length,
    report: `${directory}/results.json`,
  }),
);
