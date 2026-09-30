import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
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
const health = await get('/api/health');
assert.equal(health.data.version, '3.4.1');
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
const started = Date.now();
let previous = '';
while (Date.now() - started < 16 * 60_000) {
  const { response, data } = await get('/api/ops/status');
  assert.equal(response.status, 200);
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
