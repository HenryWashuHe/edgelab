import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const token = 'test-operator-token-not-a-production-credential';
let unhealthy = true,
  delay = 0,
  calls = 0;
let signalStarted;
const targets = [
  {
    id: 'catalog',
    name: 'Catalog',
    url: 'https://origin.internal/health',
    transport: 'origin',
    assertion: 'ok-json',
  },
];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: 'output/worker/index.js',
        compatibilityDate: '2026-09-01',
        durableObjects: {
          LABS: { className: 'ReliabilityLab', useSQLite: true },
          MONITORS: { className: 'MonitorStore', useSQLite: true },
        },
        bindings: { MONITOR_TARGETS: JSON.stringify(targets), OPERATOR_TOKEN: token },
        serviceBindings: {
          ORIGIN: async () => {
            calls++;
            signalStarted?.();
            if (delay) await new Promise((r) => setTimeout(r, delay));
            return new Response(JSON.stringify({ ok: !unhealthy }), {
              status: unhealthy ? 503 : 200,
            });
          },
        },
      },
    ],
  }),
);
const publicCall = async (path, body, auth = true, headers = {}) => {
  const r = await mf.dispatchFetch(`https://edgelab.example/api/ops/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
};
try {
  const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  const stub = ns.get(ns.idFromName('operations'));
  const tick = async (slot) => {
    const r = await stub.fetch('https://monitor.internal/tick', {
      method: 'POST',
      body: JSON.stringify({ slot }),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  await publicCall('status');
  const exported = await mf.dispatchFetch('https://edgelab.example/api/ops/export?window=7d');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('Content-Disposition'), /attachment/);
  const report = await exported.json();
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.window, '7d');
  assert(!JSON.stringify(report).includes('origin.internal'));
  const base = Math.floor(Date.now() / 60000) - 5;
  await storage.exec('UPDATE services SET created=?', (base - 10) * 60000);
  assert.equal(
    (
      await publicCall(
        'policy',
        { service: 'catalog', revision: 1, policy: { paused: true } },
        false,
      )
    ).status,
    401,
  );
  assert.equal((await publicCall('audit', undefined, false)).status, 401);
  assert.equal((await publicCall('tick', {}, true)).status, 404);
  assert.equal(
    (await publicCall('policy', {}, true, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await publicCall('policy', null)).status, 400);
  assert.equal(
    (await publicCall('policy', { service: 'catalog', revision: 1, policy: { timeoutMs: 100000 } }))
      .status,
    400,
  );
  const raw = (body, headers = {}) =>
    mf.dispatchFetch('https://edgelab.example/api/ops/policy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
    });
  assert.equal((await raw('{broken')).status, 400);
  assert.equal((await raw('x'.repeat(4097))).status, 413);
  assert.equal(
    (await raw('{}', { Authorization: 'Bearer wrong-token-that-is-long-enough-for-check' })).status,
    401,
  );
  const wrongMethod = await mf.dispatchFetch('https://edgelab.example/api/ops/status', {
    method: 'POST',
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'GET');
  assert(!JSON.stringify((await publicCall('status')).data).includes('origin.internal'));
  console.log('PASS auth, origin boundary, body validation, and private scheduler route');
  await tick(base);
  await tick(base + 1);
  const results = await Promise.all(Array.from({ length: 12 }, () => tick(base + 2)));
  assert.equal(calls, 3);
  let snapshot = (await publicCall('status')).data;
  assert.equal(snapshot.incidents.length, 1);
  assert.equal(snapshot.services[0].state.failures, 3);
  assert.equal(snapshot.services[0].metrics.observed, 3);
  assert.equal(snapshot.services[0].metrics.goodRatio, 0);
  assert(snapshot.services[0].metrics.missing > 0);
  assert(snapshot.services[0].metrics.coverage < 100);
  assert.equal(results.filter((r) => r.results[0].result === 'http-error').length, 1);
  const incident = snapshot.incidents[0];
  assert.equal(
    (
      await publicCall('acknowledge', {
        incident: incident.id,
        note: 'Private operator investigation',
      })
    ).status,
    200,
  );
  assert.equal(
    (await publicCall('acknowledge', { incident: incident.id, note: 'Duplicate retry' })).data
      .alreadyAcknowledged,
    true,
  );
  assert(!JSON.stringify((await publicCall('status')).data).includes('Private operator'));
  assert(JSON.stringify((await publicCall('audit')).data).includes('Private operator'));
  console.log(
    'PASS concurrent retries record one check, create one incident, and acknowledge idempotently',
  );
  unhealthy = false;
  await tick(base + 3);
  await tick(base + 4);
  snapshot = (await publicCall('status')).data;
  assert(snapshot.incidents[0].resolved);
  assert.equal(snapshot.services[0].state.incidentId, null);
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  const restored = (await publicCall('status')).data;
  assert.deepEqual(restored.incidents, snapshot.incidents);
  assert.deepEqual(restored.services[0].history, snapshot.services[0].history);
  console.log(
    'PASS two-check recovery and durable incident/check history across actual object eviction',
  );
  delay = 200;
  const started = new Promise((r) => {
    signalStarted = r;
  });
  const inFlight = tick(base + 5);
  await started;
  assert.equal(
    (await publicCall('policy', { service: 'catalog', revision: 1, policy: { paused: true } }))
      .status,
    200,
  );
  assert.equal(
    (await publicCall('policy', { service: 'catalog', revision: 1, policy: { paused: false } }))
      .status,
    409,
  );
  assert.equal((await inFlight).results[0].result, 'policy-changed');
  assert.equal((await tick(base + 5)).results[0].result, 'maintenance');
  snapshot = (await publicCall('status')).data;
  assert.equal(snapshot.services[0].status, 'maintenance');
  console.log(
    'PASS optimistic policy writes and in-flight generation fencing; maintenance bypasses origin',
  );
  // Emulate a process crash after reserving a lease but before any result was persisted.
  await publicCall('policy', { service: 'catalog', revision: 2, policy: { paused: false } });
  await storage.exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', base + 5);
  await storage.exec(
    'UPDATE jobs SET done=0,token=?,lease=? WHERE service=? AND slot=?',
    'abandoned',
    Date.now() + 10000,
    'catalog',
    base + 5,
  );
  assert.equal((await tick(base + 5)).results[0].result, 'duplicate-or-busy');
  await storage.exec(
    'UPDATE jobs SET lease=? WHERE service=? AND slot=?',
    Date.now() - 1,
    'catalog',
    base + 5,
  );
  delay = 0;
  signalStarted = undefined;
  assert.equal((await tick(base + 5)).results[0].result, 'good');
  console.log('PASS persisted job lease prevents overlap and permits crash recovery after expiry');
  // A replaced lease fences the old completion even if its request returns successfully.
  await storage.exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', base + 5);
  await storage.exec(
    'UPDATE jobs SET done=0,lease=0 WHERE service=? AND slot=?',
    'catalog',
    base + 5,
  );
  delay = 200;
  const resumed = new Promise((r) => {
    signalStarted = r;
  });
  const superseded = tick(base + 5);
  await resumed;
  await storage.exec(
    'UPDATE jobs SET token=?,lease=0 WHERE service=? AND slot=?',
    'replacement',
    'catalog',
    base + 5,
  );
  assert.equal((await superseded).results[0].result, 'superseded');
  assert.equal(
    (await storage.exec('SELECT * FROM checks WHERE service=? AND slot=?', 'catalog', base + 5))
      .length,
    0,
  );
  delay = 0;
  signalStarted = undefined;
  await tick(base + 5);
  console.log('PASS replaced lease token fences a real in-flight completion');
  const old = Date.now() - 31 * 86400000;
  await storage.exec(
    'INSERT INTO checks VALUES(?,?,?,?,?,?,?)',
    'catalog',
    Math.floor(old / 60000),
    old,
    'good',
    200,
    10,
    1,
  );
  await storage.exec(
    'INSERT INTO audit(at,action,service,detail) VALUES(?,?,?,?)',
    old,
    'old',
    'catalog',
    '{}',
  );
  await tick(base + 5);
  assert.equal(
    (await storage.exec('SELECT * FROM checks WHERE at<?', Date.now() - 30 * 86400000)).length,
    0,
  );
  assert.equal(
    (await storage.exec('SELECT * FROM audit WHERE at<?', Date.now() - 30 * 86400000)).length,
    0,
  );
  const worker = await mf.getWorker('gateway');
  await worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *' });
  console.log('PASS retention cleanup and actual scheduled handler invocation');
} finally {
  await mf.dispose();
}
