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

for (const failure of ['policy-read', 'policy-write', 'incident-read']) {
  let originCalls = 0;
  const target = {
    id: 'catalog',
    name: 'Storage boundary fixture',
    url: 'https://origin.internal/health',
    transport: 'origin',
    assertion: 'ok-json',
  };
  const local = new Miniflare(
    convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: 'output/monitor-unavailable-fixture.mjs',
          compatibilityDate: '2026-09-01',
          durableObjects: { MONITORS: { className: 'MonitorStore', useSQLite: true } },
          bindings: {
            FIXTURE_REAL_MONITOR: 'true',
            MONITOR_TARGETS: JSON.stringify([target]),
            OPERATOR_TOKEN: token,
            AI_BRIEFS_ENABLED: 'false',
          },
          serviceBindings: {
            ORIGIN: async () => {
              originCalls++;
              throw new Error('Monitor storage boundary fixture must not probe');
            },
          },
        },
      ],
    }),
  );
  try {
    const status = await local.dispatchFetch(base + '/api/ops/status');
    assert.equal(status.status, 200);
    const namespace = await local.getDurableObjectNamespace('MONITORS', 'gateway');
    const stub = namespace.get(namespace.idFromName('operations'));
    const storage = await local.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
      name: 'operations',
    });
    const incident = '00000000-0000-4000-8000-000000000004';
    const now = Date.now();
    await storage.exec(
      'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
      incident,
      target.id,
      now - 60000,
      null,
      now - 30000,
      'PRIVATE-INCIDENT-ACK',
    );
    await storage.exec(
      'UPDATE services SET state=? WHERE id=?',
      JSON.stringify({
        failures: 2,
        successes: 0,
        lastSlot: Math.floor(now / 60000) - 1,
        incidentId: incident,
      }),
      target.id,
    );
    const service = (await storage.exec('SELECT * FROM services WHERE id=?', target.id))[0];
    const originalVersions = await storage.exec('SELECT * FROM service_versions ORDER BY revision');
    const originalAudit = await storage.exec('SELECT * FROM audit ORDER BY id');
    const policy = (body, authorized = true) =>
      local.dispatchFetch(base + '/api/ops/policy', {
        method: 'POST',
        headers: authorized ? headers : { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const validBody = {
      service: target.id,
      revision: service.revision,
      policy: { availabilityTarget: 99.8 },
    };
    const arm = async () => {
      const response = await stub.fetch('https://monitor.internal/__fixture/arm', {
        method: 'POST',
        body: JSON.stringify({ mode: failure }),
      });
      assert.equal(response.status, 200);
    };
    const diagnostics = async () =>
      (await stub.fetch('https://monitor.internal/__fixture/sql')).json();
    const publicPath = `/api/ops/incidents/${incident}`;
    const publicDetail = await local.dispatchFetch(base + publicPath);
    assert.equal(publicDetail.status, 200);
    assert(!(await publicDetail.text()).includes('PRIVATE-INCIDENT-ACK'));
    const conflict = await policy({ ...validBody, revision: service.revision + 1 });
    assert.equal(conflict.status, 409);
    const invalidPolicy = await policy({ ...validBody, policy: { timeoutMs: -1 } });
    assert.equal(invalidPolicy.status, 400);
    assert.match((await invalidPolicy.json()).error, /timeoutMs/);

    await arm();
    assert.equal((await policy(validBody, false)).status, 401);
    assert.equal((await diagnostics()).fired, 0);
    assert.equal((await diagnostics()).next, failure);
    assert.equal(
      (
        await local.dispatchFetch(base + publicPath, {
          headers: { Authorization: 'Bearer invalid-fixture-token' },
        })
      ).status,
      401,
    );
    assert.equal((await diagnostics()).fired, 0);
    assert.equal(
      (await local.dispatchFetch(base + '/api/ops/policy', { method: 'POST', headers, body: '{' }))
        .status,
      400,
    );
    assert.equal((await diagnostics()).next, failure);
    for (const before of ['invalid', '-1', '9007199254740992']) {
      const invalidCursor = await local.dispatchFetch(base + publicPath + '?before=' + before);
      assert.equal(invalidCursor.status, 400);
      assert.match((await invalidCursor.json()).error, /before/);
      assert.equal((await diagnostics()).fired, 0);
      assert.equal((await diagnostics()).incidentReads, 0);
    }
    await arm();
    const failed =
      failure === 'incident-read'
        ? await local.dispatchFetch(base + publicPath)
        : await policy(validBody);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('Cache-Control'), 'no-store');
    assert.equal(failed.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(failed.headers.get('Retry-After'), '60');
    const failedText = await failed.text();
    assert(!failedText.includes('fixture-private-monitor-detail'));
    assert(!failedText.includes('Exceeded allowed rows'));
    assert(!failedText.includes('PRIVATE-INCIDENT-ACK'));
    const failedBody = JSON.parse(failedText);
    assert.equal(failedBody.code, 'monitor-storage-unavailable');
    assert.equal(
      failedBody.reason,
      failure === 'policy-write' ? 'daily-write-limit' : 'daily-read-limit',
    );
    assert(!('incident' in failedBody));
    assert(!('versions' in failedBody));
    const injected = await diagnostics();
    assert.equal(injected.fired, 1);
    if (failure === 'policy-write') assert.equal(injected.policyWrites, 1);
    if (failure === 'policy-read') assert.equal(injected.serviceReads, 2);
    if (failure === 'incident-read') assert.equal(injected.incidentReads, 1);
    assert.deepEqual(
      (await storage.exec('SELECT * FROM services WHERE id=?', target.id))[0],
      service,
    );
    assert.deepEqual(
      await storage.exec('SELECT * FROM service_versions ORDER BY revision'),
      originalVersions,
    );
    assert.deepEqual(await storage.exec('SELECT * FROM audit ORDER BY id'), originalAudit);
    assert.equal((await storage.exec('SELECT * FROM checks')).length, 0);
    assert.equal((await storage.exec('SELECT * FROM jobs')).length, 0);
    assert.equal((await storage.exec('SELECT * FROM incident_briefs')).length, 0);
    assert.equal((await storage.exec('SELECT * FROM brief_quota')).length, 0);
    assert.equal(originCalls, 0);
    const cooldown = await policy(validBody);
    assert.equal(cooldown.status, 503);
    assert.equal((await diagnostics()).fired, 1);
    assert.deepEqual(
      (await storage.exec('SELECT * FROM services WHERE id=?', target.id))[0],
      service,
    );
    await local.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
    const reopened = await stub.fetch('https://monitor.internal/status');
    assert.equal(reopened.status, 200);
    assert.deepEqual(
      (await storage.exec('SELECT * FROM services WHERE id=?', target.id))[0],
      service,
    );
    assert.equal(originCalls, 0);
    console.log(
      `PASS actual SQLite ${failure} propagates sanitized503, preserves auth/cursor400/revision409, rolls back policy/state/version/audit and starts no probes or inference`,
    );
  } finally {
    await local.dispose();
  }
}
