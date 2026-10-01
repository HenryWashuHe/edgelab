import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build, version as esbuildVersion } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// This recipe accepts no deployed URL, credentials, workload knobs or native AI.
if (process.argv.length !== 2)
  throw new Error('Isolated admission recipe accepts no URL or workload arguments');
const directory = 'output/lab-admission';
await mkdir(directory, { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const bundles = { gateway: `${directory}/gateway.js`, origin: `${directory}/origin.js` };
const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  metafile: true,
};
const buildOptions = [
  {
    ...common,
    entryPoints: ['tests/fixtures/lab-admission.ts'],
    outfile: bundles.gateway,
    external: ['cloudflare:workers'],
  },
  { ...common, entryPoints: ['worker/origin.ts'], outfile: bundles.origin },
];
// Discover both complete graphs without publishing bundles, then capture every
// source BEFORE the actual tested builds. No virtual/generated production code.
const discovered = await Promise.all(
  buildOptions.map((options) => build({ ...options, write: false })),
);
const inputGraphs = Object.fromEntries(
  discovered.map((result, index) => [
    index === 0 ? 'gateway' : 'origin',
    Object.keys(result.metafile.inputs).sort(),
  ]),
);
const additionalInputs = [
  'scripts/lab-admission.mjs',
  'package.json',
  'package-lock.json',
  'wrangler.jsonc',
];
const sourcePaths = [
  ...new Set([...Object.values(inputGraphs).flat(), ...additionalInputs]),
].sort();
assert(
  sourcePaths.every(
    (path) => !path.startsWith('/') && !path.startsWith('../') && !path.startsWith('node_modules/'),
  ),
  'Source graph remains project-local',
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
    'Actual tested build graph equals the pre-hashed discovered graph',
  );
const metafileSHA256 = Object.fromEntries(
  built.map((result, index) => [
    index === 0 ? 'gateway' : 'origin',
    hash(JSON.stringify(result.metafile)),
  ]),
);
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const report = {
  schemaVersion: 1,
  kind: 'edgelab-lab-admission-runtime-evidence',
  integration: 'Actual production gateway and Lab import; local fixture instrumentation only',
  measuredAt: new Date().toISOString(),
  sourceProjectVersion: packageVersion,
  observedGatewayVersion: null,
  observedMonitorVersion: null,
  environment: {
    node: process.version,
    esbuild: esbuildVersion,
    miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
    workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
    compatibilityDate: '2026-09-01',
    remoteCalls: 0,
    productionCalls: 0,
    nativeInferenceCalls: 0,
  },
  sourceSHA256,
  provenance: {
    inputsCapturedBeforeBuildAt,
    inputGraphs,
    additionalInputs,
    metafileSHA256,
    boundary:
      'Complete project-local input hashes for both actual Worker builds, plus recipe/package/lock and intended deployment configuration. wrangler.jsonc is hashed but not applied to the smaller local limiter cohorts. Installed library binaries are described by versions and lockfile, not independently hashed. Native limiter internals and deployed/account state are outside Lab measurement.',
  },
  bundleSHA256: Object.fromEntries(
    await Promise.all(
      Object.entries(bundles).map(async ([name, path]) => [name, hash(await readFile(path))]),
    ),
  ),
  workload: {
    maximumCapabilities: 16,
    maximumEnrolledLabs: 4,
    nativeProfiles: [
      { ownerLimit: 3, observerLimit: 1, periodSeconds: 60 },
      { ownerLimit: 8, observerLimit: 1, periodSeconds: 60 },
    ],
    distinctLaneNamespaces: true,
    validationRequests: 10,
    refusedFreshOwnerCapabilities: 4,
    refusedExistingOwnerRequests: 4,
    refusedObserverHandshakes: 2,
  },
  assertions: [],
  samples: [],
  limitations: [
    "Native local RateLimit binding is Miniflare's installed SQLite-backed runtime implementation; production uses permissive eventually consistent per-location counters. Exact local thresholds do not prove exact production limits.",
    'Zero-work rejection means zero delegated LABS namespace/stub/constructor/source-SQL/KV/alarm/origin work. Limiter internal SQLite overhead, gateway execution and rejected Worker requests are excluded, not free.',
    'Constructor and aggregate source meters are isolated local worker-instance observations. Zero namespace/stub delegation independently establishes that denied fresh capabilities were not opened by this gateway.',
    'No denied fresh capability is inspected: doing so would construct its Lab. Known-object source hashes/deadlines are compared only through separately metered diagnostic controls.',
    'Both lanes have distinct fixture namespace IDs and the same static key within each binding; changing a capability never chooses a new bucket.',
    'Monitoring routes and scheduled-handler probes use actual MonitorStore/origin code. Their SQL/storage work is outside Lab meters; separately reported monitor probe calls and stored observations prove work occurred.',
    'The scheduled case invokes the unchanged handler through a narrow local event control with Date.now(), not a deployed Cron Trigger or a reconstructed outcome.',
    'No account, billing, global budget, CPU, customer traffic, production entitlement, browser behavior or distributed overshoot claim is made.',
  ],
};
const capabilities = [];
const fresh = () => {
  assert(capabilities.length < 16, 'Bounded local capability count');
  const id = randomUUID();
  capabilities.push(id);
  return id;
};
const peers = [];
const numeric = (value) => {
  assert(Number.isSafeInteger(value) && value >= 0, 'Native meter count is a nonnegative integer');
  return value;
};
const sqlKeys = [
  'attemptedStatements',
  'statements',
  'failedStatements',
  'rowsRead',
  'rowsWritten',
];
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
const nativeKeys = ['originFetch', 'originCompleted', 'originFailed', 'originInFlight'];
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
const pickNumbers = (value, keys) =>
  Object.fromEntries(keys.map((key) => [key, numeric(value[key])]));
function projection(value) {
  return {
    gateway: pickNumbers(value.gateway, gatewayKeys),
    labConstructors: numeric(value.labConstructors),
    lab: {
      sql: { ...pickNumbers(value.lab.sql, sqlKeys), failedCursorCost: null },
      operations: pickNumbers(value.lab.operations, operationKeys),
      nativeInvocations: pickNumbers(value.lab.nativeInvocations, nativeKeys),
      labFetchesInFlight: numeric(value.lab.labFetchesInFlight),
    },
    nativeAdmission: {
      owner: numeric(value.nativeAdmission.owner),
      observer: numeric(value.nativeAdmission.observer),
    },
    controlledFaultCalls: numeric(value.controlledFaultCalls),
    monitorProbeInvocations: pickNumbers(value.monitorProbeInvocations, nativeKeys),
  };
}
function zeroLabWork(meter) {
  assert.equal(meter.labConstructors, 0, 'No local Lab constructor');
  for (const [key, value] of Object.entries(meter.gateway))
    if (key !== 'gatewayRequests') assert.equal(value, 0, 'No LABS namespace/stub delegation');
  for (const group of [
    pickNumbers(meter.lab.sql, sqlKeys),
    meter.lab.operations,
    meter.lab.nativeInvocations,
  ])
    assert(
      Object.values(group).every((value) => value === 0),
      'No source SQL/KV/alarm/origin work',
    );
  assert.equal(meter.lab.labFetchesInFlight, 0);
}
const pass = (message) => {
  report.assertions.push(message);
  console.log(JSON.stringify({ passed: message }));
};
async function stableMinute() {
  const remaining = 60000 - (Date.now() % 60000);
  if (remaining < 10000) await new Promise((resolve) => setTimeout(resolve, remaining + 20));
  return Math.floor(Date.now() / 60000);
}
async function runtime(ownerLimit) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
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
          bindings: {
            AI_BRIEFS_ENABLED: 'false',
            LAB_ADMISSION_ENABLED: 'true',
            OPERATOR_TOKEN: 'admission-local-test-token-not-a-production-credential',
            MONITOR_TARGETS: JSON.stringify([
              {
                id: 'local-catalog',
                name: 'Local controlled catalog',
                url: 'https://origin.internal/catalog',
                transport: 'origin',
                assertion: 'catalog-json',
              },
            ]),
          },
          serviceBindings: { ORIGIN: 'origin' },
          ratelimits: {
            LAB_OWNER_LIMITER: { namespace_id: '21001', simple: { limit: ownerLimit, period: 60 } },
            LAB_OBSERVER_LIMITER: { namespace_id: '21002', simple: { limit: 1, period: 60 } },
          },
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
    await mf.ready;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  const namespace = await mf.getDurableObjectNamespace('LABS', 'gateway');
  const control = async (path, body) => {
    const response = await mf.dispatchFetch(
      `http://localhost/__fixture/${path}`,
      body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) },
    );
    assert.equal(response.status, 200, 'Local control succeeded');
    return response.json();
  };
  const meter = async () => projection(await control('admission-meter'));
  const reset = () => control('admission-reset', {});
  const inspect = async (id) => {
    const response = await namespace
      .get(namespace.idFromName(id))
      .fetch('https://local.fixture/__fixture/inspect');
    assert.equal(response.status, 200, 'Known-object diagnostic succeeded');
    return response.json();
  };
  const owner = async (path, id, body) => {
    const response = await mf.dispatchFetch(`http://localhost/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Lab-ID': id, Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const observe = (id) =>
    mf.dispatchFetch('http://localhost/api/observe', {
      headers: {
        Origin: 'http://localhost',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `edgelab-observer-v1, edgelab-cap.${id}`,
      },
    });
  return { mf, control, meter, reset, inspect, owner, observe };
}
function rejected(result, status) {
  assert.equal(result.status, status, 'Admission error status');
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(result.headers.get('Retry-After'), '60');
  assert(
    Object.keys(result.data).sort().join(',') === 'code,error,retryAfterSeconds',
    'Only sanitized admission fields',
  );
  assert.equal(
    result.data.code,
    status === 429 ? 'lab-admission-limited' : 'lab-admission-unavailable',
  );
  assert.equal(result.data.retryAfterSeconds, 60);
  assert(
    !JSON.stringify(result.data).includes('local-admission-private-error-canary'),
    'No raw binding failure',
  );
}
const active = [];
try {
  const a = await runtime(3);
  active.push(a.mf);
  const minute = await stableMinute();
  const known = fresh();
  const invalids = [
    { path: '/api/unknown', expected: 404 },
    {
      path: '/api/state',
      headers: { Origin: 'https://other.invalid', 'X-Lab-ID': known },
      expected: 403,
    },
    { path: '/api/state', headers: { 'X-Lab-ID': 'not-a-uuid' }, expected: 400 },
    {
      path: '/api/state',
      method: 'POST',
      headers: { 'X-Lab-ID': known },
      body: '{}',
      expected: 405,
    },
    {
      path: '/api/request',
      method: 'POST',
      headers: { 'X-Lab-ID': known },
      body: 'x'.repeat(4097),
      expected: 413,
    },
    { path: '/api/observe', method: 'POST', expected: 405 },
    { path: '/api/observe', headers: { Upgrade: 'websocket' }, expected: 403 },
    { path: '/api/observe', headers: { Origin: 'http://localhost' }, expected: 426 },
    {
      path: '/api/observe',
      headers: {
        Origin: 'http://localhost',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'edgelab-observer-v1',
      },
      expected: 400,
    },
    {
      path: '/api/observe?capability=ignored',
      headers: {
        Origin: 'http://localhost',
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `edgelab-observer-v1, edgelab-cap.${known}`,
      },
      expected: 400,
    },
  ];
  await a.reset();
  for (const item of invalids) {
    const response = await a.mf.dispatchFetch(`http://localhost${item.path}`, {
      method: item.method ?? 'GET',
      headers: item.headers,
      body: item.body,
    });
    assert.equal(response.status, item.expected, 'Existing validation precedence');
    await response.arrayBuffer();
  }
  const validation = await a.meter();
  zeroLabWork(validation);
  assert.deepEqual(validation.nativeAdmission, { owner: 0, observer: 0 });
  report.samples.push({
    scenario: 'pre-admission-validation',
    requests: invalids.length,
    meter: validation,
  });
  pass(
    'Existing route/origin/UUID/method/body/protocol validation consumes neither limiter calls nor LABS work',
  );
  await a.reset();
  assert.equal((await a.owner('state', known)).status, 200);
  assert.equal(
    (
      await a.owner('config', known, {
        capacity: 1,
        refillPerSecond: 1,
        originMode: 'healthy',
        originLatencyMs: 20,
        originTimeoutMs: 1000,
      })
    ).status,
    200,
  );
  const accepted = await a.owner('request', known, {});
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.outcome, 'origin');
  const successes = await a.meter();
  assert.equal(successes.nativeAdmission.owner, 3);
  assert.equal(successes.nativeAdmission.observer, 0);
  assert.equal(successes.labConstructors, 1);
  assert.equal(successes.gateway.stubFetch, 3);
  assert.equal(successes.lab.nativeInvocations.originFetch, 1);
  assert(successes.lab.sql.statements > 0 && successes.lab.sql.rowsWritten > 0);
  report.samples.push({ scenario: 'native-owner-success', requests: 3, meter: successes });
  pass(
    'Native successful owner admission dispatches the real Lab and controlled origin, with source/response counter reconciliation',
  );
  const before = await a.inspect(known);
  assert.equal(before.state.total, 1);
  assert.equal(before.state.originCalls, 1);
  assert.equal(before.state.counts.origin, 1);
  assert.equal(before.eventCount, 1);
  assert(before.events[0].outcome === 'origin' && before.events[0].status === 200);
  await a.reset();
  const refusedFresh = Array.from({ length: 4 }, fresh);
  for (const id of refusedFresh) rejected(await a.owner('state', id), 429);
  for (const [path, body] of [
    ['state', undefined],
    ['request', {}],
    ['config', { capacity: 2 }],
    ['reset', {}],
  ])
    rejected(await a.owner(path, known, body), 429);
  const refusals = await a.meter();
  zeroLabWork(refusals);
  assert.equal(refusals.nativeAdmission.owner, 8);
  assert.equal(refusals.nativeAdmission.observer, 0);
  const after = await a.inspect(known);
  assert(
    before.sourceHash === after.sourceHash &&
      before.expiresAt === after.expiresAt &&
      before.alarmAt === after.alarmAt,
    'Known source and lease unchanged',
  );
  report.samples.push({
    scenario: 'native-owner-refusal',
    freshCapabilities: 4,
    existingRunRequests: 4,
    requests: 8,
    meter: refusals,
    knownSourceAndLeaseUnchanged: true,
  });
  pass(
    'Native refusals on fresh capabilities and an existing run do zero LABS work and do not renew the known lease',
  );
  await a.reset();
  const upgrade = await a.observe(known);
  assert.equal(upgrade.status, 101);
  assert(upgrade.webSocket, 'Actual observer upgrade socket');
  peers.push(upgrade.webSocket);
  upgrade.webSocket.accept();
  const observation = await a.meter();
  assert.deepEqual(observation.nativeAdmission, { owner: 0, observer: 1 });
  assert.equal(observation.gateway.stubFetch, 1);
  assert.equal(observation.labConstructors, 0);
  assert(observation.lab.sql.rowsRead > 0);
  assert.equal(observation.lab.sql.rowsWritten, 0);
  assert.equal(observation.lab.operations.kvGet, 1);
  assert(
    Object.entries(observation.lab.operations).every(
      ([key, value]) => key === 'kvGet' || value === 0,
    ),
  );
  assert(Object.values(observation.lab.nativeInvocations).every((value) => value === 0));
  report.samples.push({ scenario: 'native-observer-success', requests: 1, meter: observation });
  await a.reset();
  for (const id of [fresh(), known]) {
    const response = await a.observe(id);
    rejected(
      { status: response.status, headers: response.headers, data: await response.json() },
      429,
    );
  }
  const observers = await a.meter();
  zeroLabWork(observers);
  assert.deepEqual(observers.nativeAdmission, { owner: 0, observer: 2 });
  report.samples.push({ scenario: 'native-observer-refusal', requests: 2, meter: observers });
  pass(
    'Separate native observer lane upgrades once without lease renewal and refuses subsequent handshakes before LABS lookup',
  );
  for (const lane of ['owner', 'observer'])
    for (const mode of ['missing', 'throw', 'malformed']) {
      await a.control('admission-fault', { lane, mode });
      await a.reset();
      if (lane === 'owner') rejected(await a.owner('state', known), 503);
      else {
        const response = await a.observe(known);
        rejected(
          { status: response.status, headers: response.headers, data: await response.json() },
          503,
        );
      }
      const faults = await a.meter();
      zeroLabWork(faults);
      assert.deepEqual(faults.nativeAdmission, { owner: 0, observer: 0 });
      assert.equal(faults.controlledFaultCalls, mode === 'missing' ? 0 : 1);
      report.samples.push({ scenario: `controlled-${lane}-${mode}`, requests: 1, meter: faults });
      await a.control('admission-fault', { lane, mode: 'native' });
    }
  pass(
    'Both lanes fail closed and sanitize controlled missing, throwing and malformed bindings without LABS work',
  );
  await a.control('admission-setting', { mode: 'malformed' });
  await a.reset();
  rejected(await a.owner('state', known), 503);
  const malformedSetting = await a.meter();
  zeroLabWork(malformedSetting);
  assert.deepEqual(malformedSetting.nativeAdmission, { owner: 0, observer: 0 });
  report.samples.push({
    scenario: 'malformed-enabled-setting',
    requests: 1,
    meter: malformedSetting,
  });
  await a.control('admission-setting', { mode: 'native' });
  pass(
    'Malformed enabled configuration fails closed before invoking either binding or opening a Lab',
  );
  await a.control('admission-setting', { mode: 'malformed' });
  await a.reset();
  for (const [path, expected] of [
    ['/api/health', 200],
    ['/api/ops/status', 200],
    ['/api/ops/export', 200],
    ['/api/ready', 503],
  ]) {
    const response = await a.mf.dispatchFetch(`http://localhost${path}`);
    assert.equal(response.status, expected, 'Non-Lab route uses its own actual contract');
    const body = await response.json();
    assert(
      !String(body.code ?? '').startsWith('lab-admission-'),
      'No admission diagnosis on a non-Lab route',
    );
    if (path === '/api/ops/status' || path === '/api/ops/export') {
      assert.equal(
        body.version,
        packageVersion,
        'Actual monitor version agrees with source package',
      );
      assert(
        body.services.length === 1 && body.services[0].history.length === 0,
        'Real local monitor target initialized without a probe',
      );
    }
    if (path === '/api/ready') assert.equal(body.monitoring.status, 'starting');
  }
  const monitoringRoutes = await a.meter();
  zeroLabWork(monitoringRoutes);
  assert.deepEqual(monitoringRoutes.nativeAdmission, { owner: 0, observer: 0 });
  assert.equal(monitoringRoutes.monitorProbeInvocations.originFetch, 0);
  report.samples.push({
    scenario: 'non-lab-monitoring-routes',
    requests: 4,
    meter: monitoringRoutes,
    measurementBoundary: 'Lab only; actual MonitorStore SQL/storage is excluded',
    actualMonitorTargets: 1,
  });
  pass(
    'Health/status/export/ready bypass both Lab lanes and retain actual monitor semantics even with malformed Lab configuration',
  );
  await a.reset();
  for (const action of ['policy', 'acknowledge', 'incident-note', 'incident-brief']) {
    const response = await a.mf.dispatchFetch(`http://localhost/api/ops/${action}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401, 'Unauthenticated operator write stays unauthorized');
    const body = await response.json();
    assert(
      !String(body.code ?? '').startsWith('lab-admission-'),
      'Operator authorization precedes any irrelevant Lab admission',
    );
  }
  const operatorRefusals = await a.meter();
  zeroLabWork(operatorRefusals);
  assert.deepEqual(operatorRefusals.nativeAdmission, { owner: 0, observer: 0 });
  report.samples.push({
    scenario: 'unauthenticated-operator-write-exclusion',
    requests: 4,
    meter: operatorRefusals,
  });
  pass(
    'All unauthenticated operator write routes return authorization failure without invoking a Lab limiter or Lab object',
  );
  await a.control('admission-setting', { mode: 'native' });
  await a.reset();
  const scheduleStartedAt = Date.now();
  await a.control('scheduled-current', {});
  const checkedResponse = await a.mf.dispatchFetch('http://localhost/api/ops/status');
  assert.equal(checkedResponse.status, 200);
  const checked = await checkedResponse.json();
  assert.equal(checked.version, packageVersion);
  report.observedMonitorVersion = checked.version;
  const storedCheck = checked.services[0]?.latest;
  assert(
    storedCheck && storedCheck.outcome === 'good' && storedCheck.status === 200,
    'Actual scheduled probe is persisted as good',
  );
  assert(
    storedCheck.slot === minute &&
      storedCheck.observedAt >= scheduleStartedAt &&
      storedCheck.observedAt <= Date.now(),
    'Current actual UTC observation start is persisted',
  );
  assert(
    checked.services[0].history.length === 1,
    'One new stored observation, not seeded history',
  );
  assert(
    checked.scheduler.some((event) => event.status === 'completed' && event.slot === minute),
    'Actual scheduler completion persisted',
  );
  const readyResponse = await a.mf.dispatchFetch('http://localhost/api/ready');
  assert.equal(readyResponse.status, 200);
  assert.equal((await readyResponse.json()).monitoring.status, 'healthy');
  const auditResponse = await a.mf.dispatchFetch('http://localhost/api/ops/audit', {
    headers: { Authorization: 'Bearer admission-local-test-token-not-a-production-credential' },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  assert(
    audit.lastCleanup &&
      audit.lastCleanup.slot === minute &&
      audit.lastCleanup.cleanup?.schemaVersion === 1,
    'Actual private audit sees the completed transaction',
  );
  const scheduled = await a.meter();
  zeroLabWork(scheduled);
  assert.deepEqual(scheduled.nativeAdmission, { owner: 0, observer: 0 });
  assert.deepEqual(scheduled.monitorProbeInvocations, {
    originFetch: 1,
    originCompleted: 1,
    originFailed: 0,
    originInFlight: 0,
  });
  report.samples.push({
    scenario: 'actual-scheduled-handler-exclusion',
    requests: 3,
    localScheduledEvents: 1,
    meter: scheduled,
    actualStoredObservations: 1,
    probeOutcome: 'good',
    monitoringReadiness: 'healthy',
    measurementBoundary:
      'Lab only; actual MonitorStore SQL/storage and monitor binding probe are separate',
  });
  pass(
    'Actual scheduled handler probes the real origin and persists a fresh completed check while bypassing exhausted owner/observer Lab lanes',
  );
  const unchanged = await a.inspect(known);
  assert(
    unchanged.sourceHash === before.sourceHash && unchanged.expiresAt === before.expiresAt,
    'Observer/refusal/fault phases preserve source and lease',
  );
  assert.equal(
    Math.floor(Date.now() / 60000),
    minute,
    'Native local threshold proof stays inside one actual UTC minute',
  );
  await a.mf.dispose();
  active.splice(active.indexOf(a.mf), 1);
  const b = await runtime(8);
  active.push(b.mf);
  const engineMinute = await stableMinute();
  const engineId = fresh();
  await b.reset();
  assert.equal((await b.owner('state', engineId)).status, 200);
  assert.equal(
    (
      await b.owner('config', engineId, {
        capacity: 1,
        refillPerSecond: 1,
        originMode: 'healthy',
        originLatencyMs: 20,
        originTimeoutMs: 1000,
      })
    ).status,
    200,
  );
  const decisions = await Promise.all([
    b.owner('request', engineId, {}),
    b.owner('request', engineId, {}),
  ]);
  assert.equal(
    decisions.filter((value) => value.status === 429 && value.data.outcome === 'limited').length,
    1,
    'Engine 429 is actual persisted experiment evidence',
  );
  assert.equal(
    decisions.filter((value) => value.status === 200 && value.data.outcome === 'origin').length,
    1,
  );
  const engine = await b.meter();
  assert.equal(engine.nativeAdmission.owner, 4);
  assert.equal(engine.gateway.stubFetch, 4);
  assert.equal(engine.lab.nativeInvocations.originFetch, 1);
  const source = await b.inspect(engineId);
  assert.equal(source.state.total, 2);
  assert.equal(source.state.originCalls, 1);
  assert.equal(source.state.counts.origin, 1);
  assert.equal(source.state.counts.limited, 1);
  assert.equal(source.eventCount, 2);
  assert(source.events.some((event) => event.outcome === 'limited' && event.status === 429));
  report.samples.push({
    scenario: 'engine-429-remains-persisted',
    requests: 4,
    meter: engine,
    settledDecisions: 2,
    originDecisions: 1,
    limitedDecisions: 1,
    retainedEvents: 2,
  });
  pass(
    'An actual engine 429 passes successful native admission and remains a stored decision with reconciled origin/event counters',
  );
  for (const mode of ['undefined', 'false']) {
    await b.control('admission-setting', { mode });
    await b.reset();
    assert.equal((await b.owner('state', fresh())).status, 200);
    const bypass = await b.meter();
    assert.deepEqual(bypass.nativeAdmission, { owner: 0, observer: 0 });
    assert.equal(bypass.gateway.stubFetch, 1);
    assert.equal(bypass.labConstructors, 1);
    report.samples.push({ scenario: `explicit-legacy-${mode}`, requests: 1, meter: bypass });
  }
  pass(
    'Undefined and exact false preserve legacy dispatch; an enabled missing binding never silently bypasses',
  );
  await b.control('admission-setting', { mode: 'native' });
  await b.reset();
  const health = await b.mf.dispatchFetch('http://localhost/api/health');
  assert.equal(health.status, 200);
  const healthData = await health.json();
  assert.equal(healthData.version, packageVersion);
  report.observedGatewayVersion = healthData.version;
  const healthMeter = await b.meter();
  zeroLabWork(healthMeter);
  assert.deepEqual(healthMeter.nativeAdmission, { owner: 0, observer: 0 });
  report.samples.push({ scenario: 'health-outside-lab-lanes', requests: 1, meter: healthMeter });
  pass('Health bypasses both Lab lanes and reports the unmodified source release version');
  assert.equal(Math.floor(Date.now() / 60000), engineMinute);
} finally {
  for (const peer of peers)
    try {
      peer.close(1000, 'Local recipe complete');
    } catch {}
  await Promise.allSettled(active.map((mf) => mf.dispose()));
}
for (const [path, value] of Object.entries(sourceSHA256))
  assert.equal(hash(await readFile(path)), value, 'Source graph stable during local runtime');
report.sourceStableDuringRun = true;
report.ephemeralRuntimesDisposed = true;
const text = JSON.stringify(report, null, 2) + '\n';
for (const capability of capabilities)
  assert(!text.includes(capability), 'No capability in report');
for (const key of ['runId', 'requestId', 'payload', 'bootId', 'sourceHash', 'expiresAt', 'alarmAt'])
  assert(!text.includes(`"${key}"`), 'No private scratch source metadata in report');
await writeFile(`${directory}/results.json`, text);
console.log(
  JSON.stringify({
    passedGroups: report.assertions.length,
    samples: report.samples.length,
    sourceStableDuringRun: true,
    artifact: `${directory}/results.json`,
  }),
);
