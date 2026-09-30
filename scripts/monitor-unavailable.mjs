import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const token = 'monitor-storage-fixture-token-not-a-production-credential';
await build({
  entryPoints: ['tests/fixtures/monitor-unavailable.ts'],
  outfile: 'output/monitor-unavailable-fixture.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['cloudflare:workers'],
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: 'output/monitor-unavailable-fixture.mjs',
        compatibilityDate: '2026-09-01',
        bindings: { OPERATOR_TOKEN: token },
      },
    ],
  }),
);
const base = 'https://edgelab.example';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  assert.equal((await mf.dispatchFetch(base + '/api/health')).status, 200);
  for (const path of ['/api/ops/status', '/api/ready', '/api/ops/export']) {
    const response = await mf.dispatchFetch(base + path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('Content-Disposition'), null);
    const body = await response.json();
    assert.equal(body.code, 'monitor-storage-unavailable');
    assert.equal(body.reason, 'daily-read-limit');
    assert.equal(
      body.retryAtUTC,
      new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000).toISOString(),
    );
    assert(!JSON.stringify(body).includes(token));
    assert(!('services' in body));
    assert(!('monitoring' in body));
  }
  // Authentication, method and body validation must precede the shared cooldown.
  assert.equal((await mf.dispatchFetch(base + '/api/ops/audit')).status, 401);
  assert.equal((await mf.dispatchFetch(base + '/api/ops/status', { method: 'POST' })).status, 405);
  assert.equal(
    (
      await mf.dispatchFetch(base + '/api/ops/status', {
        headers: { Origin: 'https://untrusted.invalid' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await mf.dispatchFetch(base + '/api/ops/incident-brief', {
        method: 'POST',
        headers,
        body: '{',
      })
    ).status,
    400,
  );
  const mutation = await mf.dispatchFetch(base + '/api/ops/incident-brief', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      incident: '00000000-0000-4000-8000-000000000000',
      requestId: '00000000-0000-4000-8000-000000000001',
    }),
  });
  assert.equal(mutation.status, 503);
  assert.equal((await mutation.json()).code, 'monitor-storage-unavailable');
  const state = await (await mf.dispatchFetch(base + '/__fixture/state')).json();
  assert.equal(state.calls, 1);
  assert.equal((await mf.dispatchFetch(base + '/api/state')).status, 400);
  const lab = await mf.dispatchFetch(base + '/api/state', {
    headers: { 'X-Lab-ID': '00000000-0000-4000-8000-000000000002' },
  });
  assert.equal(lab.status, 503);
  assert.equal((await lab.json()).code, 'lab-storage-unavailable');
  assert.equal(lab.headers.get('Cache-Control'), 'no-store');
  const repeatedLab = await mf.dispatchFetch(base + '/api/state', {
    headers: { 'X-Lab-ID': '00000000-0000-4000-8000-000000000002' },
  });
  assert.equal(repeatedLab.status, 503);
  assert.equal((await (await mf.dispatchFetch(base + '/__fixture/state')).json()).calls, 2);
  console.log(
    'PASS actual Worker quota failure boundary, liveness/readiness split, export and experiment failures, validation precedence and separate cooldowns',
  );
} finally {
  await mf.dispose();
}

for (const failure of ['read', 'write']) {
  let originCalls = 0;
  const local = new Miniflare(
    convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: 'output/monitor-unavailable-fixture.mjs',
          compatibilityDate: '2026-09-01',
          durableObjects: { LABS: { className: 'ReliabilityLab', useSQLite: true } },
          bindings: { FIXTURE_REAL_LAB: 'true', FIXTURE_CONFIG_FAILURE: failure },
          serviceBindings: {
            ORIGIN: async () => {
              originCalls++;
              throw new Error('Config fixture must not dispatch an origin request');
            },
          },
        },
      ],
    }),
  );
  const labId = '00000000-0000-4000-8000-000000000003';
  const labHeaders = { 'X-Lab-ID': labId, 'Content-Type': 'application/json' };
  try {
    const config = (body, fail = false) =>
      local.dispatchFetch(base + '/api/config', {
        method: 'POST',
        headers: { ...labHeaders, ...(fail ? { 'X-Fixture-Fail': 'true' } : {}) },
        body: JSON.stringify(body),
      });
    const seeded = await config({ capacity: 7, originMode: 'flaky' });
    assert.equal(seeded.status, 200);
    const snapshot = await local.dispatchFetch(base + '/api/state', { headers: labHeaders });
    assert.equal(snapshot.status, 200);
    const originalConfig = (await snapshot.json()).state.config;
    assert.equal(originalConfig.capacity, 7);
    assert.equal(originalConfig.originMode, 'flaky');
    const storage = await local.unsafeGetDurableObjectStorage('gateway', 'ReliabilityLab', {
      name: labId,
    });
    const persisted = async () =>
      JSON.parse((await storage.exec('SELECT value FROM state WHERE id=1'))[0].value);

    const invalid = await config({ capacity: 0 });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /capacity/);
    assert.deepEqual((await persisted()).config, originalConfig);

    const failed = await config({ capacity: 19, originMode: 'failing' }, true);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('Cache-Control'), 'no-store');
    assert.equal(failed.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(failed.headers.get('Retry-After'), '60');
    assert(failed.headers.get('X-Edge-Colo'));
    const failedText = await failed.text();
    assert(!failedText.includes('fixture-private-storage-detail'));
    assert(!failedText.includes('Exceeded allowed rows'));
    const result = JSON.parse(failedText);
    assert.equal(result.code, 'lab-storage-unavailable');
    assert.equal(result.reason, failure === 'read' ? 'daily-read-limit' : 'daily-write-limit');
    assert(!('state' in result));
    assert(!('decision' in result));
    assert(!('outcome' in result));
    assert.deepEqual((await persisted()).config, originalConfig);
    assert.equal((await storage.exec('SELECT * FROM events')).length, 0);
    assert.equal(originCalls, 0);

    const namespace = await local.getDurableObjectNamespace('LABS', 'gateway');
    const stub = namespace.get(namespace.idFromName(labId));
    const diagnostics = await (await stub.fetch('https://lab.internal/__fixture/sql')).json();
    assert.equal(diagnostics.fired, 1);
    assert.equal(diagnostics.reads, 2);
    assert.equal(diagnostics.writes, failure === 'write' ? 2 : 1);
    const beforeCooldown = await storage.exec('SELECT value FROM state WHERE id=1');
    const blocked = await config({ capacity: 23 });
    assert.equal(blocked.status, 503);
    assert.deepEqual(await storage.exec('SELECT value FROM state WHERE id=1'), beforeCooldown);
    assert.equal((await (await stub.fetch('https://lab.internal/__fixture/sql')).json()).fired, 1);
    await local.unsafeEvictDurableObject('gateway', 'ReliabilityLab', { name: labId });
    assert.deepEqual((await persisted()).config, originalConfig);
    const reopened = await stub.fetch('https://lab.internal/api/state');
    assert.equal(reopened.status, 200);
    assert.deepEqual((await reopened.json()).state.config, originalConfig);
    assert.equal(originCalls, 0);
    console.log(
      `PASS actual SQLite mid-config ${failure} failure returns sanitized503, preserves validation400, rolls back configuration, survives eviction and cooldown dispatches no origin`,
    );
  } finally {
    await local.dispose();
  }
}
