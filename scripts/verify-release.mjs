import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { verifyBuiltAssets } from './asset-verification.mjs';
const base = process.env.BASE_URL;
if (!base?.startsWith('https://')) throw new Error('Set BASE_URL to your deployed HTTPS gateway');
const token = (await readFile('.env.operator', 'utf8')).match(/^OPERATOR_TOKEN=(.+)$/m)?.[1];
const request = async (path, { method = 'GET', headers = {}, body } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15000),
  });
  return { response: r, data: await r.json() };
};
const get = (path, headers = {}) => request(path, { headers });
const assertStatusRead = (data) => {
  assert.equal(data.version, '3.12.3');
  const read = data.read;
  assert(read && ['storage', 'memory'].includes(read.source));
  assert.deepEqual(Object.keys(read).sort(), [
    'ageMs',
    'materializedAt',
    'maxAgeMs',
    'servedAt',
    'source',
  ]);
  for (const at of [read.materializedAt, read.servedAt])
    assert(Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000);
  assert.equal(read.servedAt, data.now);
  assert.equal(read.ageMs, read.servedAt - read.materializedAt);
  assert(read.ageMs >= 0 && read.ageMs < 10000);
  assert.equal(read.maxAgeMs, 10000);
  if (read.source === 'storage') assert.equal(read.ageMs, 0);
  assert(!JSON.stringify(data).includes('budgetSources'));
};
const health = await get('/api/health');
assert.equal(health.data.version, '3.12.3');
const projectVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(health.data.version, projectVersion, 'Deployed/package version agreement');
const deployedAssets = await verifyBuiltAssets(base);
console.log(
  'PASS deployed/package version and all production asset bytes, MIME and revalidation; rendering not verified',
);
assert.equal((await get('/api/ops/audit')).response.status, 401);
assert.equal(
  (await get('/api/ops/audit', { Authorization: `Bearer ${token}` })).response.status,
  200,
);
assert.equal(
  (await get('/api/ops/status', { Origin: 'https://untrusted.invalid' })).response.status,
  403,
);
console.log('PASS live version, public read boundary, and authenticated operator access');
// These HTTP observations verify provenance, not production SQL cost or browser rendering.
const statusReuseChecks = [];
for (const window of ['24h', '7d']) {
  let witnessedMemory = false;
  for (let attempt = 0; attempt < 3 && !witnessedMemory; attempt++) {
    const first = await get(`/api/ops/status?window=${window}`);
    const second = await get(`/api/ops/status?window=${window}`);
    for (const result of [first, second]) {
      assert.equal(result.response.status, 200);
      assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
      assert.equal(result.response.headers.get('X-Content-Type-Options'), 'nosniff');
      assertStatusRead(result.data);
    }
    if (
      second.data.read.source === 'memory' &&
      first.data.read.materializedAt === second.data.read.materializedAt
    ) {
      assert.deepEqual(
        second.data.services.map((s) => s.latest),
        first.data.services.map((s) => s.latest),
      );
      witnessedMemory = true;
      statusReuseChecks.push({ window, first: first.data.read, second: second.data.read });
    }
  }
  assert(witnessedMemory, `No same-materialization memory response witnessed for ${window}`);
  const exported = await get(`/api/ops/export?window=${window}`);
  assert.equal(exported.response.status, 200);
  assertStatusRead(exported.data);
  assert.equal(exported.data.read.source, 'storage');
  statusReuseChecks.push({ window, authoritativeExport: exported.data.read });
}
console.log(
  'PASS live memory provenance, unchanged observations, and authoritative exports for both windows',
);
// Every brief check stops at gateway or UUID validation. Valid private lookups
// may expire leases, so never perform one or submit a valid generation body here.
const probeId = '00000000-0000-4000-8000-000000000000';
const invalidId = 'a'.repeat(36);
const invalidToken = 'brief-release-invalid-token-0000000000000000';
assert.notEqual(invalidToken, token);
const authorization = { Authorization: `Bearer ${token}` };
const briefRoutes = [
  { path: '/api/ops/incident-brief', method: 'POST' },
  { path: `/api/ops/incident-briefs/${probeId}`, method: 'GET' },
  { path: `/api/ops/incidents/${probeId}/briefs`, method: 'GET' },
];
const briefChecks = [];
const assertBriefResponse = async (name, path, options, status, error, allow) => {
  const { response, data } = await request(path, options);
  assert.equal(response.status, status, name);
  assert.equal(data.error, error, name);
  assert.equal(response.headers.get('Cache-Control'), 'no-store', name);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', name);
  if (allow) assert.equal(response.headers.get('Allow'), allow, name);
  if (status === 401) assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer', name);
  briefChecks.push({ check: name, method: options.method, status });
};
for (const route of briefRoutes) {
  for (const [kind, headers] of [
    ['absent bearer', {}],
    ['invalid bearer', { Authorization: `Bearer ${invalidToken}` }],
  ]) {
    await assertBriefResponse(
      `${route.method} ${route.path}: ${kind}`,
      route.path,
      { method: route.method, headers },
      401,
      'Operator token required',
    );
  }
  await assertBriefResponse(
    `${route.path}: wrong method`,
    route.path,
    { method: route.method === 'GET' ? 'POST' : 'GET', headers: authorization },
    405,
    'Method not allowed',
    route.method,
  );
  await assertBriefResponse(
    `${route.path}: cross-origin`,
    route.path,
    {
      method: route.method,
      headers: { ...authorization, Origin: 'https://untrusted.invalid' },
    },
    403,
    'Cross-origin requests are not allowed',
  );
}
await assertBriefResponse(
  'Generation: authorized malformed JSON',
  '/api/ops/incident-brief',
  {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: '{',
  },
  400,
  'Invalid JSON',
);
await assertBriefResponse(
  'Brief retrieval: authorized invalid UUID',
  `/api/ops/incident-briefs/${invalidId}`,
  { method: 'GET', headers: authorization },
  400,
  'UUID v4 requestId required',
);
await assertBriefResponse(
  'Brief history: authorized invalid UUID',
  `/api/ops/incidents/${invalidId}/briefs`,
  { method: 'GET', headers: authorization },
  400,
  'Incident UUID required',
);
const privateBriefRoutes = {
  verifiedAt: new Date().toISOString(),
  strategy:
    'Gateway rejection and pre-transaction UUID validation only; no valid brief lookup or generation body submitted.',
  inferenceRequestsSubmitted: 0,
  checks: briefChecks,
};
console.log('PASS private brief auth, methods, origin, validation, and no-store boundaries');
// One disposable empty run verifies both admission routes, conditional on the
// reviewed deployed configuration enabling both native limiter bindings. HTTP
// acceptance alone cannot distinguish that configuration from disabled bypass.
// The capability stays in process memory and is never printed or archived.
// No experiment/config/reset POST, application socket message or origin request is submitted.
const capability = randomUUID();
const ownerState = await get('/api/state', {
  'X-Lab-ID': capability,
  Origin: new URL(base).origin,
});
assert.equal(ownerState.response.status, 200, 'Live owner admission route');
assert.equal(ownerState.data.state.total, 0);
assert.equal(ownerState.data.state.originCalls, 0);
assert.equal(ownerState.data.events.length, 0);
assert(Object.values(ownerState.data.state.counts).every((count) => count === 0));
const observerSnapshot = await new Promise((resolve, reject) => {
  const socket = new WebSocket(
    base.replace(/^https:/, 'wss:') + '/api/observe',
    ['edgelab-observer-v1', `edgelab-cap.${capability}`],
    {
      headers: { Origin: new URL(base).origin },
      handshakeTimeout: 8000,
      maxPayload: 16384,
      perMessageDeflate: false,
    },
  );
  let settled = false;
  let cleanupTimer;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) {
      socket.terminate();
      reject(error);
    } else {
      socket.close(1000, 'Release verification complete');
      cleanupTimer = setTimeout(() => socket.terminate(), 1000);
      cleanupTimer.unref();
      resolve(value);
    }
  };
  const timer = setTimeout(() => finish(new Error('Live observer admission timed out')), 10000);
  socket.once('message', (bytes, isBinary) => {
    try {
      assert(isBinary === false, 'Observer snapshot is a text frame');
      const frame = JSON.parse(bytes.toString('utf8'));
      const exactKeys = (value, keys) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === keys.length &&
        Object.keys(value).every((key) => keys.includes(key));
      // Match the public LabObserverDataFrame/LabObserverState/Config shapes.
      // Boolean assertions avoid printing untrusted keys or source identifiers.
      assert(
        exactKeys(frame, [
          'schemaVersion',
          'kind',
          'runId',
          'revision',
          'committedAt',
          'now',
          'expiresAt',
          'state',
          'events',
        ]),
        'Exact public observer snapshot shape',
      );
      assert(
        exactKeys(frame.state, [
          'config',
          'tokens',
          'circuit',
          'failures',
          'total',
          'originCalls',
          'counts',
        ]),
        'Exact public observer state shape',
      );
      const configKeys = [
        'capacity',
        'refillPerSecond',
        'failureThreshold',
        'cooldownMs',
        'originLatencyMs',
        'originTimeoutMs',
        'staleFallback',
        'originMode',
      ];
      assert(exactKeys(frame.state.config, configKeys), 'Exact public observer config shape');
      assert(
        configKeys.every((key) => frame.state.config[key] === ownerState.data.state.config[key]),
        'Observer retains owner configuration',
      );
      assert(
        exactKeys(frame.state.counts, ['origin', 'stale', 'limited', 'blocked', 'error']),
        'Exact public observer counts shape',
      );
      assert.equal(socket.protocol, 'edgelab-observer-v1');
      assert.equal(frame.schemaVersion, 1);
      assert.equal(frame.kind, 'snapshot');
      assert(frame.runId === ownerState.data.state.runId, 'Owner and observer share the run');
      assert(
        frame.revision === ownerState.data.state.revision &&
          frame.committedAt === ownerState.data.state.committedAt,
        'Observer retains owner commit metadata',
      );
      assert.equal(frame.expiresAt, ownerState.data.expiresAt, 'Observer did not renew the lease');
      assert.equal(frame.state.total, 0);
      assert.equal(frame.state.originCalls, 0);
      assert(Array.isArray(frame.events), 'Observer events are an array');
      assert.equal(frame.events.length, 0);
      assert(Object.values(frame.state.counts).every((count) => count === 0));
      const serialized = JSON.stringify(frame);
      assert(!serialized.includes(capability), 'Capability excluded from observer frame');
      for (const key of ['cachedPayload', 'requestId', 'payload', 'authorization'])
        assert(!serialized.includes(`"${key}"`), 'Private fields excluded from observer');
      finish(null, {
        schemaVersion: 1,
        kind: 'snapshot',
        textFrame: true,
        publicShapeValidated: true,
        emptyRun: true,
        unchangedLease: true,
      });
    } catch {
      finish(new Error('Live observer admission or empty-run verification failed'));
    }
  });
  // Keep a safe listener through close/terminate, including errors after settlement.
  socket.on('error', () => finish(new Error('Live observer admission failed')));
  socket.once('close', () => {
    if (cleanupTimer) clearTimeout(cleanupTimer);
    finish(new Error('Live observer closed before its snapshot'));
  });
});
const labAdmissionChecks = {
  verifiedAt: new Date().toISOString(),
  strategy:
    'One fresh owner state GET and one same-origin WebSocket handshake; no experiment, config or reset POST and no application socket messages. Capability and run identifiers omitted.',
  configurationAssumption:
    'The reviewed deployed configuration enables native admission and both limiter bindings. Accepted route requests alone do not independently distinguish enabled admission from disabled bypass.',
  owner: { status: 200, emptyRun: true },
  observer: { status: 101, protocol: 'edgelab-observer-v1', ...observerSnapshot },
  experimentRequestsSubmitted: 0,
  limits:
    'One accepted request per lane, conditional on the reviewed enabled native-binding configuration; exact rate enforcement, production Lab/limiter storage cost, billing and global capacity are not measured.',
};
console.log('PASS live owner and observer admission on one empty run; no experiment submitted');
const started = Date.now();
let previous = '';
while (Date.now() - started < 16 * 60_000) {
  const { response, data } = await get('/api/ops/status');
  assert.equal(response.status, 200);
  assertStatusRead(data);
  assert.equal(data.services.length, 2);
  assert(!JSON.stringify(data).includes(token));
  assert(!JSON.stringify(data).includes('origin.internal'));
  assert(!JSON.stringify(data).includes('"note"'));
  assert(!JSON.stringify(data).includes('promptEvidenceIds'));
  assert(!JSON.stringify(data).includes('evidenceHash'));
  const observed = data.services.map((s) => ({
    id: s.id,
    latestSlot: s.latest?.slot ?? null,
    outcome: s.latest?.outcome ?? null,
    uniqueRecentSlots: [
      ...new Set(
        s.history
          .filter(
            (c) =>
              c.observedAt >= started &&
              c.outcome === 'good' &&
              Math.floor(c.observedAt / 60000) === c.slot,
          )
          .map((c) => c.slot),
      ),
    ],
  }));
  const progress = JSON.stringify(observed);
  if (progress !== previous) {
    console.log(progress);
    previous = progress;
  }
  if (observed.every((s) => s.uniqueRecentSlots.length >= 2)) {
    for (const service of data.services) {
      assert.equal(service.budget.evaluationStatus, 'current');
      const evaluation = service.budget.evaluation;
      assert.equal(evaluation.ruleVersion, 1);
      assert.equal(evaluation.revision, service.revision);
      assert(evaluation.computedAt >= started);
      assert.deepEqual(
        evaluation.rules.map((rule) => rule.id),
        ['rapid', 'sustained', 'gradual'],
      );
      for (const rule of evaluation.rules) {
        for (const window of [rule.long, rule.short]) {
          assert.equal(window.endSlot, Math.floor(evaluation.computedAt / 60000) - 1);
          assert.equal(window.expected, window.observed + window.maintenance + window.unknown);
        }
      }
    }
    const ready = await get('/api/ready');
    assert.equal(ready.response.status, 200);
    assert.equal(ready.data.monitoring.status, 'healthy');
    const exported = await get('/api/ops/export');
    assertStatusRead(exported.data);
    assert.equal(exported.data.read.source, 'storage');
    assert.equal(exported.data.schemaVersion, 4);
    assert(!JSON.stringify(exported.data).includes('promptEvidenceIds'));
    assert(!JSON.stringify(exported.data).includes('evidenceHash'));
    await mkdir('docs/evidence', { recursive: true });
    await writeFile(
      'docs/evidence/live-monitoring.json',
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          startedAt: new Date(started).toISOString(),
          baseUrl: base,
          verification:
            'Two distinct new good scheduled minutes for each service after verification began, each actual observation start matching its UTC minute. New persisted version1 budget evaluations use finished-minute windows and reconcile observations, maintenance, and unknown counts. No manual tick endpoint was invoked. Readiness healthy, schema4 export, operator audit authentication, and public privacy boundaries checked. All three private brief routes verified for absent/invalid bearer, methods, origin rejection, validation, and no-store headers using only requests rejected before brief transactions or inference; native AI capability and output are not verified by these checks.',
          privateBriefRoutes,
          labAdmissionChecks,
          statusReuseChecks,
          deployedAssets,
          health: health.data,
          snapshot: data,
        },
        null,
        2,
      ) + '\n',
    );
    await mkdir('docs/evidence/releases', { recursive: true });
    await copyFile(
      'docs/evidence/live-monitoring.json',
      `docs/evidence/releases/${health.data.version}-live-monitoring.json`,
    );
    console.log(
      'PASS autonomous scheduled monitoring: both services produced two new good minutes. Evidence saved.',
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
throw new Error(
  'Cron failed to produce two new good minutes within propagation window; release not verified',
);
