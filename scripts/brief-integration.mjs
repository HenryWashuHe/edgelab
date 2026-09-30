import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const MINUTE = 60000;
const DAY = 86400000;
const token = 'brief-fixture-token-not-a-production-credential';
const target = {
  id: 'catalog',
  name: 'Owned QA service name, never prompt instructions',
  transport: 'origin',
  assertion: 'ok-json',
  url: 'https://origin.internal/health',
};
await build({
  entryPoints: ['tests/fixtures/brief-clock.ts'],
  outfile: 'output/brief-clock-worker/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
let mode = 'valid';
const calls = [];
const held = [];
const fakeProvider = async (request) => {
  const packet = await request.json();
  calls.push(packet);
  assert.equal(packet.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(packet.input.max_tokens, 512);
  assert.equal(packet.input.stream, false);
  assert.equal(packet.rejectIfBusy, true);
  assert.equal(packet.signalPresent, true);
  assert(Buffer.byteLength(JSON.stringify(packet.input)) <= 4096);
  assert(
    Buffer.byteLength(packet.input.messages.map((message) => message.content).join('')) <= 2048,
  );
  const prompt = JSON.stringify(packet.input);
  for (const secret of [
    token,
    target.url,
    target.name,
    'PRIVATE-ACK-FIXTURE',
    'PRIVATE-NOTE-FIXTURE',
  ])
    assert(!prompt.includes(secret));
  const content = JSON.parse(
    packet.input.messages.find((message) => message.role === 'user').content,
  );
  const citation = content.references.find((reference) => reference.id === 'fact:http-error')?.id;
  assert(citation, 'The bounded prompt must carry an applicable retained HTTP-error reference');
  const output = {
    hypotheses: [
      {
        kind: 'upstream-http-error',
        explanation:
          'Recorded HTTP failures merit checking the service logs; the cause remains unverified.',
        evidenceIds: [citation],
        nextChecks: ['inspect-service-logs'],
      },
    ],
  };
  if (mode === 'maximum') output.hypotheses[0].explanation = '界'.repeat(200);
  const valid = () =>
    Response.json({
      response: JSON.stringify(output),
      usage: { input_tokens: 400, output_tokens: 60 },
    });
  if (mode === 'hold' || mode === 'timeout')
    return new Promise((resolve) => held.push(() => resolve(valid())));
  if (mode === 'invalid')
    return Response.json({ response: JSON.stringify({ ...output, facts: ['fabricated'] }) });
  if (mode === 'tools')
    return Response.json({
      response: JSON.stringify(output),
      tool_calls: [{ name: 'execute-command' }],
    });
  if (mode === 'oversize') return Response.json({ response: 'x'.repeat(8193) });
  if (mode === 'capacity') return Response.json({ code: 3040 }, { status: 429 });
  if (mode === 'quota') return Response.json({ code: 3036 }, { status: 429 });
  if (mode === 'auth') return Response.json({ code: 5018 }, { status: 403 });
  return valid();
};
const options = (
  enabled = true,
  fake = true,
  targets = [target],
  scriptPath = 'output/brief-clock-worker/index.js',
) =>
  convertV4MiniflareOptions({
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath,
        compatibilityDate: '2026-09-01',
        durableObjects: {
          LABS: { className: 'ReliabilityLab', useSQLite: true },
          MONITORS: { className: 'MonitorStore', useSQLite: true },
        },
        bindings: {
          MONITOR_TARGETS: JSON.stringify(targets),
          OPERATOR_TOKEN: token,
          AI_BRIEFS_ENABLED: enabled ? 'true' : 'false',
        },
        serviceBindings: {
          ORIGIN: async () => Response.json({ ok: true }),
          ...(fake ? { FAKE_AI: fakeProvider } : {}),
        },
      },
    ],
  });
const mf = new Miniflare(options());
try {
  let namespace = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  let stub = namespace.get(namespace.idFromName('operations'));
  let storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  const configure = async (enabled = true, fake = true, targets = [target]) => {
    await mf.setOptions(options(enabled, fake, targets));
    namespace = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
    stub = namespace.get(namespace.idFromName('operations'));
    storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
      name: 'operations',
    });
  };
  const clock = async (now) => {
    const response = await stub.fetch('https://monitor.internal/test-clock', {
      method: 'POST',
      body: JSON.stringify({ now }),
    });
    assert.equal(response.status, 200);
  };
  const call = async (path, body, headers = {}) => {
    const response = await mf.dispatchFetch(`https://edgelab.example/api/ops/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const create = (incident, requestId = randomUUID()) =>
    call('incident-brief', { incident, requestId });
  const get = (requestId) => call(`incident-briefs/${requestId}`);
  const list = (incident) => call(`incidents/${incident}/briefs`);
  const waitFor = async (condition) => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      assert(Date.now() < deadline, 'Fixture provider did not receive the expected dispatch');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const now = Math.floor(Date.now() / MINUTE) * MINUTE + 1000;
  await clock(now);
  assert.equal((await call('status')).status, 200);
  const incident = randomUUID();
  const otherIncident = randomUUID();
  const emptyIncident = randomUUID();
  const historyAt = now - 29 * DAY;
  const lastSlot = Math.floor(historyAt / MINUTE) - 1;
  await storage.exec(
    'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    incident,
    'catalog',
    historyAt - 10 * MINUTE,
    null,
    historyAt - 9 * MINUTE,
    'PRIVATE-ACK-FIXTURE',
  );
  await storage.exec(
    'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    otherIncident,
    'catalog',
    now - MINUTE,
    now,
    null,
    '',
  );
  await storage.exec(
    'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    emptyIncident,
    'catalog',
    now - 120 * MINUTE,
    now - 110 * MINUTE,
    null,
    '',
  );
  await storage.exec(
    'INSERT INTO incident_notes VALUES(?,?,?,?)',
    randomUUID(),
    incident,
    now,
    'PRIVATE-NOTE-FIXTURE',
  );
  const currentPolicy = (await storage.exec('SELECT policy FROM services WHERE id=?', 'catalog'))[0]
    .policy;
  const historicalPolicy = JSON.stringify({
    ...JSON.parse(currentPolicy),
    availabilityTarget: 99.95,
    latencyObjectiveMs: 1200,
  });
  await storage.exec(
    'UPDATE services SET revision=?,created=? WHERE id=?',
    8,
    historyAt - 20 * MINUTE,
    'catalog',
  );
  for (const [revision, recordedAt, policy] of [
    [7, historyAt - 20 * MINUTE, historicalPolicy],
    [8, now, currentPolicy],
  ])
    await storage.exec(
      'INSERT OR REPLACE INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
      'catalog',
      revision,
      recordedAt,
      target.name,
      target.transport,
      target.assertion,
      policy,
      'recorded',
    );
  for (let offset = 0; offset < 8; offset++) {
    const slot = lastSlot - offset;
    await storage.exec(
      'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
      'catalog',
      slot,
      slot * MINUTE + 1020,
      'http-error',
      503,
      20,
      7,
      slot * MINUTE + 1000,
    );
  }
  const initialQuota = (await list(incident)).data.quota;
  assert.equal(initialQuota.attempts, 0);
  assert.equal(initialQuota.remaining, 4);
  for (const path of [
    'incident-brief',
    `incident-briefs/${randomUUID()}`,
    `incidents/${incident}/briefs`,
  ]) {
    const response = await mf.dispatchFetch(`https://edgelab.example/api/ops/${path}`, {
      method: path === 'incident-brief' ? 'POST' : 'GET',
      ...(path === 'incident-brief'
        ? { body: JSON.stringify({ incident, requestId: randomUUID() }) }
        : {}),
    });
    assert.equal(response.status, 401);
  }
  assert.equal(
    (
      await call(
        'incident-brief',
        { incident, requestId: randomUUID() },
        { Origin: 'https://foreign.example' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await call('incident-brief', { incident, requestId: randomUUID(), prompt: 'not permitted' }))
      .status,
    400,
  );
  assert.equal((await create(randomUUID())).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await list(incident)).data.quota.attempts, 0);
  console.log(
    'PASS operator authorization, same-origin, strict body validation, and missing incident checks precede provider/quota work',
  );

  await configure(false);
  const disabledId = randomUUID();
  assert.equal((await create(incident, disabledId)).status, 503);
  assert.equal((await list(incident)).data.capability, 'disabled');
  assert.equal((await get(disabledId)).status, 404);
  await configure(true, false);
  assert.equal((await create(incident)).status, 503);
  assert.equal((await list(incident)).data.quota.attempts, 0);
  assert.equal(calls.length, 0);
  await configure();
  console.log(
    'PASS disabled safety flag and missing native binding consume no attempt and create no request record',
  );

  const insufficient = await create(emptyIncident);
  assert.equal(insufficient.status, 201);
  assert.equal(insufficient.data.brief.state, 'insufficient-evidence');
  assert.equal(insufficient.data.brief.generated, null);
  assert.equal((await list(incident)).data.quota.attempts, 0);
  assert.equal(calls.length, 0);
  const requestId = randomUUID();
  const first = await create(incident, requestId);
  assert.equal(first.status, 201);
  assert.equal(first.data.brief.state, 'complete');
  assert.equal(first.data.brief.evidence.facts.badChecks, 8);
  assert.equal(first.data.brief.evidence.limits.privateNotesIncluded, false);
  assert.match(first.data.brief.evidenceHash, /^[0-9a-f]{64}$/);
  assert(!JSON.stringify(first.data).includes('PRIVATE-'));
  assert(!JSON.stringify(first.data).includes(target.url));
  assert.equal(calls.length, 1);
  const duplicate = await create(incident, requestId.toUpperCase());
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.data.brief, first.data.brief);
  assert.equal((await create(otherIncident, requestId)).status, 409);
  assert.equal((await create(incident)).status, 429);
  assert.equal((await list(incident)).data.quota.attempts, 1);
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  assert.deepEqual((await get(requestId)).data.brief, first.data.brief);
  await configure(false);
  assert.deepEqual((await get(requestId)).data.brief, first.data.brief);
  assert.equal((await list(incident)).data.capability, 'disabled');
  assert.equal((await create(incident, requestId)).status, 200);
  await configure();
  console.log(
    'PASS deterministic insufficient evidence, immutable successful result, idempotent/conflicting UUIDs, minute gate, eviction and disabled historical access',
  );

  await clock(now + MINUTE);
  mode = 'hold';
  const pendingId = randomUUID();
  const starting = Array.from({ length: 12 }, () => create(incident, pendingId));
  await waitFor(() => held.length === 1);
  const retries = await Promise.all(Array.from({ length: 12 }, () => create(incident, pendingId)));
  assert(retries.every((result) => result.status === 202));
  assert.equal(calls.length, 2);
  assert.equal((await create(incident)).status, 429);
  const pendingList = (await list(incident)).data;
  assert.equal(pendingList.quota.pendingUntil, now + MINUTE + 20000);
  assert.equal(pendingList.quota.attempts, 2);
  const tickResponse = await stub.fetch('https://monitor.internal/tick', {
    method: 'POST',
    body: JSON.stringify({ slot: Math.floor((now + MINUTE) / MINUTE) }),
  });
  assert.equal(tickResponse.status, 200);
  assert.equal((await call('status')).data.monitoring.status, 'healthy');
  assert.deepEqual((await get(requestId)).data.brief, first.data.brief);
  held.shift()();
  const startingResults = await Promise.all(starting);
  assert.equal(startingResults.filter((result) => result.status === 201).length, 1);
  assert(startingResults.every((result) => [200, 201, 202].includes(result.status)));
  assert.equal((await get(pendingId)).data.brief.state, 'complete');
  console.log(
    'PASS one durable dispatch under twelve concurrent retries, global pending gate, and independent real cron progress while inference awaits I/O',
  );

  await clock(now + 2 * MINUTE);
  mode = 'invalid';
  const invalid = await create(incident);
  assert.equal(invalid.status, 502);
  assert.equal(invalid.data.brief.failure.code, 'invalid-output');
  assert.equal(invalid.data.brief.generated, null);
  assert(!JSON.stringify(invalid.data).includes('fabricated'));
  const invalidCalls = calls.length;
  assert.equal((await create(incident, invalid.data.brief.requestId)).status, 200);
  assert.equal(calls.length, invalidCalls);
  await clock(now + 3 * MINUTE);
  mode = 'tools';
  assert.equal((await create(incident)).data.brief.failure.code, 'invalid-output');
  await clock(now + 4 * MINUTE);
  assert.equal((await create(incident)).status, 429);
  assert.equal((await list(incident)).data.quota.attempts, 4);
  const nextDay = Math.floor(now / DAY) * DAY + DAY + 1000;
  await clock(nextDay);
  assert.equal((await list(incident)).data.quota.attempts, 0);
  assert.equal((await list(incident)).data.quota.remaining, 4);
  for (const [index, failureMode, code] of [
    [0, 'capacity', 'provider-capacity'],
    [1, 'quota', 'provider-quota'],
    [2, 'auth', 'provider-auth'],
    [3, 'oversize', 'invalid-output'],
  ]) {
    await clock(nextDay + index * MINUTE);
    mode = failureMode;
    const result = await create(incident);
    assert.equal(result.status, code === 'invalid-output' ? 502 : 503);
    assert.equal(result.data.brief.failure.code, code);
    assert(!JSON.stringify(result.data).includes('Fixture private provider error'));
  }
  assert.equal((await list(incident)).data.quota.attempts, 4);
  assert.equal((await list(incident)).data.records.length, 5);
  console.log(
    'PASS invalid/tool/oversized output rejection, sanitized provider classifications, attempted-call daily cap, UTC reset and latest-five list',
  );

  const thirdDay = nextDay + DAY;
  await clock(thirdDay);
  mode = 'hold';
  const lateId = randomUUID();
  const late = create(incident, lateId);
  await waitFor(() => held.length === 1);
  const beforeExpirationAdmission = (await list(incident)).data.admission;
  await clock(thirdDay + 20000);
  const expired = await get(lateId);
  assert.equal(expired.status, 200);
  assert.equal(expired.data.brief.state, 'interrupted');
  assert.equal(expired.data.brief.failure.code, 'interrupted');
  assert.deepEqual((await list(incident)).data.admission, beforeExpirationAdmission);
  const beforeLate = calls.length;
  assert.equal((await create(incident, lateId)).status, 200);
  assert.equal(calls.length, beforeLate);
  held.shift()();
  assert.equal((await late).data.brief.state, 'interrupted');
  assert.equal((await get(lateId)).data.brief.generated, null);
  const crashId = randomUUID();
  const crashRecord = {
    ...first.data.brief,
    requestId: crashId,
    createdAt: thirdDay + 20000,
    completedAt: null,
    state: 'pending',
    generated: null,
    failure: null,
  };
  await storage.exec(
    'INSERT INTO incident_briefs VALUES(?,?,?,?,?,?,?,?)',
    crashId,
    incident,
    'catalog',
    crashRecord.createdAt,
    'pending',
    JSON.stringify(crashRecord),
    randomUUID(),
    thirdDay + 40000,
  );
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  assert.equal((await get(crashId)).status, 202);
  await clock(thirdDay + 40000);
  assert.equal((await get(crashId)).data.brief.state, 'interrupted');
  assert.equal((await create(incident, crashId)).status, 200);
  assert.equal(calls.length, beforeLate);
  assert.equal((await list(incident)).data.admission.recordsCreated, 1);
  console.log(
    'PASS persisted deadline boundary, late-completion token fencing and crash/eviction recovery never redispatch existing UUIDs',
  );

  await clock(thirdDay + MINUTE);
  mode = 'timeout';
  const timeoutId = randomUUID();
  // Move the injected coordinator clock beyond its persisted deadline while
  // the real native abort/timer still owns the pending request.
  const timeoutClockAdvance = setTimeout(() => clock(thirdDay + MINUTE + 20001), 18000);
  const timedOut = await create(incident, timeoutId);
  clearTimeout(timeoutClockAdvance);
  assert.equal(timedOut.status, 503);
  assert.equal(timedOut.data.brief.state, 'failed');
  assert.equal(timedOut.data.brief.failure.code, 'timeout');
  const timeoutCalls = calls.length;
  assert.equal((await create(incident, timeoutId)).status, 200);
  assert.equal(calls.length, timeoutCalls);
  held.splice(0).forEach((resolve) => resolve());
  console.log(
    'PASS actual twenty-second inference timeout is terminal, sanitized and not retried automatically',
  );

  mode = 'valid';
  const policyResponse = await call('policy', {
    service: 'catalog',
    revision: 8,
    policy: { availabilityTarget: 99.8 },
  });
  assert.equal(policyResponse.status, 200);
  const retentionTime = now + 3 * DAY;
  await clock(retentionTime);
  assert.equal(
    (
      await stub.fetch('https://monitor.internal/tick', {
        method: 'POST',
        body: JSON.stringify({ slot: Math.floor(retentionTime / MINUTE) }),
      })
    ).status,
    200,
  );
  assert.equal(
    (await storage.exec('SELECT slot FROM checks WHERE service=? AND revision=?', 'catalog', 7))
      .length,
    0,
  );
  assert.equal(
    (
      await storage.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        7,
      )
    ).length,
    0,
  );
  assert.deepEqual((await get(requestId)).data.brief, first.data.brief);
  for (const publicPath of ['status', 'export', `incidents/${incident}`]) {
    const value = await mf.dispatchFetch(`https://edgelab.example/api/ops/${publicPath}`);
    const text = await value.text();
    assert(!text.includes(requestId));
    assert(!text.includes(first.data.brief.evidenceHash));
    assert(!text.includes('hypotheses'));
  }
  const orphan = await create(otherIncident);
  assert.equal(orphan.status, 201);
  assert.equal(orphan.data.brief.state, 'insufficient-evidence');
  await storage.exec('DELETE FROM incidents WHERE id=?', otherIncident);
  assert.equal((await get(orphan.data.brief.requestId)).status, 404);
  const removedTarget = { ...target, id: 'catalog-removed', name: 'Removed fixture service' };
  await configure(true, true, [target, removedTarget]);
  await call('status');
  const removedIncident = randomUUID();
  await storage.exec(
    'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    removedIncident,
    removedTarget.id,
    retentionTime - 10 * MINUTE,
    retentionTime - MINUTE,
    null,
    '',
  );
  const removedBrief = await create(removedIncident);
  assert.equal(removedBrief.status, 201);
  assert.equal(removedBrief.data.brief.state, 'insufficient-evidence');
  await configure();
  assert.equal((await get(removedBrief.data.brief.requestId)).status, 404);
  assert.equal(
    (
      await stub.fetch('https://monitor.internal/tick', {
        method: 'POST',
        body: JSON.stringify({ slot: Math.floor(retentionTime / MINUTE) }),
      })
    ).status,
    200,
  );
  for (const id of [orphan.data.brief.requestId, removedBrief.data.brief.requestId])
    assert.equal(
      (await storage.exec('SELECT request_id FROM incident_briefs WHERE request_id=?', id)).length,
      0,
    );
  assert.deepEqual((await get(requestId)).data.brief, first.data.brief);
  console.log(
    'PASS completed cron removes fresh orphan/removed-target briefs while preserving eligible frozen records',
  );
  await configure(true, true, []);
  assert.equal((await get(requestId)).status, 404);
  await configure();
  assert.equal((await get(requestId)).status, 200);
  await clock(now + 30 * DAY + 1);
  assert.equal((await get(requestId)).status, 404);
  assert.equal(
    (await list(incident)).data.records.some((record) => record.requestId === requestId),
    false,
  );
  await clock(now + 35 * DAY);
  assert.equal(
    (
      await stub.fetch('https://monitor.internal/tick', {
        method: 'POST',
        body: JSON.stringify({ slot: Math.floor((now + 35 * DAY) / MINUTE) }),
      })
    ).status,
    200,
  );
  assert.equal((await storage.exec('SELECT request_id FROM incident_briefs')).length, 0);
  assert.equal((await storage.exec('SELECT day FROM brief_quota')).length, 0);
  console.log(
    'PASS frozen evidence survives source pruning, generated/private records stay outside public APIs, removed-target access and thirty-day retention are enforced',
  );
} finally {
  held.splice(0).forEach((resolve) => resolve());
  await mf.dispose();
}

// Each admission scenario starts with a fresh, actual SQLite coordinator. These
// requests use only fixture credentials and the controlled native-AI adapter.
const RECORD_BYTES = 128 * 1024;
const HEADROOM_BYTES = 9 * 1024;
const encodedSize = (value) => Buffer.byteLength(JSON.stringify(value));
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const waitForHeld = async () => {
  const deadline = Date.now() + 10000;
  while (held.length === 0) {
    assert(Date.now() < deadline, 'Expected fixture dispatch did not reserve a pending request');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
async function withAdmissionFixture(run, scriptPath) {
  const local = new Miniflare(options(true, true, [target], scriptPath));
  try {
    const namespace = await local.getDurableObjectNamespace('MONITORS', 'gateway');
    const stub = namespace.get(namespace.idFromName('operations'));
    const storage = await local.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
      name: 'operations',
    });
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 1000;
    const clock = async (at) => {
      const response = await stub.fetch('https://monitor.internal/test-clock', {
        method: 'POST',
        body: JSON.stringify({ now: at }),
      });
      assert.equal(response.status, 200);
    };
    const call = async (path, body) => {
      const response = await local.dispatchFetch(`https://edgelab.example/api/ops/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    await clock(now);
    assert.equal((await call('status')).status, 200);
    const incident = randomUUID();
    const otherIncident = randomUUID();
    for (const id of [incident, otherIncident])
      await storage.exec(
        'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
        id,
        'catalog',
        now - 120 * MINUTE,
        now - 110 * MINUTE,
        null,
        '',
      );
    const create = (id = incident, requestId = randomUUID()) =>
      call('incident-brief', { incident: id, requestId });
    const list = (id = incident) => call(`incidents/${id}/briefs`);
    const get = (requestId) => call(`incident-briefs/${requestId}`);
    const evict = () =>
      local.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
    const tick = async (at) => {
      await clock(at);
      const response = await stub.fetch('https://monitor.internal/tick', {
        method: 'POST',
        body: JSON.stringify({ slot: Math.floor(at / MINUTE) }),
      });
      assert.equal(response.status, 200);
    };
    const badIncident = async (count = 1) => {
      const id = randomUUID();
      await storage.exec(
        'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
        id,
        'catalog',
        now - 60 * MINUTE,
        null,
        null,
        '',
      );
      const policy = (await storage.exec('SELECT policy FROM services WHERE id=?', 'catalog'))[0]
        .policy;
      for (let offset = 0; offset < count; offset++) {
        const slot = Math.floor(now / MINUTE) - 1 - offset;
        const revision = 100 + offset;
        await storage.exec(
          'INSERT OR REPLACE INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
          'catalog',
          slot,
          slot * MINUTE + 1020,
          'http-error',
          503,
          20,
          revision,
          slot * MINUTE + 1000,
        );
        await storage.exec(
          'INSERT OR REPLACE INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
          'catalog',
          revision,
          now - 61 * MINUTE,
          'Fixture historical service',
          'origin',
          'ok-json',
          policy,
          'recorded',
        );
      }
      return id;
    };
    const initial = (await list()).data.admission;
    assert.deepEqual(initial, {
      day: dayOf(now),
      recordsCreated: 0,
      remaining: 16,
      maxRecordsPerDay: 16,
      retainedRecords: 0,
      maxRetainedRecords: 256,
      maxRecordBytes: RECORD_BYTES,
      upgradeDayClosed: false,
    });
    await run({
      local,
      stub,
      storage,
      now,
      clock,
      call,
      create,
      list,
      get,
      evict,
      tick,
      badIncident,
      incident,
      otherIncident,
    });
  } finally {
    held.splice(0).forEach((release) => release());
    await local.dispose();
  }
}

await withAdmissionFixture(
  async ({ storage, now, clock, create, list, get, evict, tick, incident, otherIncident }) => {
    const providerCalls = calls.length;
    const results = await Promise.all(Array.from({ length: 32 }, () => create()));
    const created = results.filter((result) => result.status === 201);
    const rejected = results.filter((result) => result.status === 429);
    assert.equal(created.length, 16);
    assert.equal(rejected.length, 16);
    assert(created.every((result) => result.data.brief.state === 'insufficient-evidence'));
    for (const result of rejected) {
      assert.equal(result.data.code, 'brief-record-limit');
      assert.equal(result.data.brief, undefined);
      assert.equal(result.data.admission.recordsCreated, 16);
      assert.equal(result.data.admission.remaining, 0);
    }
    assert.equal(calls.length, providerCalls);
    assert.equal((await list()).data.quota.attempts, 0);
    assert.equal((await list()).data.admission.retainedRecords, 16);
    const first = created[0].data.brief;
    const beforeReplay = (await list()).data.admission;
    assert.deepEqual((await create(incident, first.requestId)).data.brief, first);
    assert.equal((await create(otherIncident, first.requestId)).status, 409);
    assert.deepEqual((await list()).data.admission, beforeReplay);
    await evict();
    assert.equal((await create()).data.code, 'brief-record-limit');
    assert.deepEqual((await get(first.requestId)).data.brief, first);
    assert.deepEqual((await list()).data.admission, beforeReplay);

    const nextDay = Math.floor(now / DAY) * DAY + DAY + 1000;
    await clock(nextDay);
    assert.equal((await list()).data.admission.remaining, 16);
    assert.equal((await list()).data.admission.retainedRecords, 16);
    const orphan = await create(otherIncident);
    assert.equal(orphan.status, 201);
    await storage.exec('DELETE FROM incidents WHERE id=?', otherIncident);
    await tick(nextDay);
    assert.equal((await get(orphan.data.brief.requestId)).status, 404);
    const afterPrune = (await list()).data.admission;
    assert.equal(afterPrune.recordsCreated, 1);
    assert.equal(afterPrune.remaining, 15);
    assert.equal(afterPrune.retainedRecords, 16);
    await evict();
    assert.deepEqual((await list()).data.admission, afterPrune);
    console.log(
      'PASS 32 concurrent deterministic requests admit sixteen, replay/conflict bypass capacity, eviction/UTC/pruning never refund reservations',
    );
  },
);

for (const knownRecords of [0, 2])
  await withAdmissionFixture(
    async ({ storage, now, clock, create, list, get, evict, incident, otherIncident }) => {
      const legacy = [];
      for (let index = 0; index < knownRecords; index++) legacy.push((await create()).data.brief);
      const legacySerialized = legacy.length
        ? ' '.repeat(RECORD_BYTES) + JSON.stringify(legacy[0])
        : null;
      if (legacySerialized !== null) {
        // Valid legacy JSON may exceed the new byte cap. Padding leaves its
        // frozen semantic evidence/hash intact while exercising that boundary.
        await storage.exec(
          'UPDATE incident_briefs SET record=? WHERE request_id=?',
          legacySerialized,
          legacy[0].requestId,
        );
        assert(Buffer.byteLength(legacySerialized) > RECORD_BYTES);
      }
      await storage.exec('DROP TABLE brief_admission');
      await storage.exec('DROP TABLE brief_admission_meta');
      await evict();
      const migrated = (await list()).data.admission;
      assert.equal(migrated.recordsCreated, knownRecords);
      assert.equal(migrated.retainedRecords, knownRecords);
      assert.equal(migrated.remaining, 0);
      assert.equal(migrated.upgradeDayClosed, true);
      const denied = await create();
      assert.equal(denied.status, 429);
      assert.equal(denied.data.code, 'brief-record-limit');
      assert.equal(denied.data.brief, undefined);
      if (legacy.length) {
        assert.deepEqual((await get(legacy[0].requestId)).data.brief, legacy[0]);
        assert.equal((await create(incident, legacy[0].requestId)).status, 200);
        assert.equal((await create(otherIncident, legacy[0].requestId)).status, 409);
        assert.equal(
          (
            await storage.exec(
              'SELECT record FROM incident_briefs WHERE request_id=?',
              legacy[0].requestId,
            )
          )[0].record,
          legacySerialized,
        );
      }
      await evict();
      assert.deepEqual((await list()).data.admission, migrated);
      const marker = await storage.exec('SELECT * FROM brief_admission_meta');
      assert.deepEqual(marker, [{ id: 1, closed_day: dayOf(now) }]);
      await clock(Math.floor(now / DAY) * DAY + DAY + 1000);
      const nextDay = (await list()).data.admission;
      assert.equal(nextDay.recordsCreated, 0);
      assert.equal(nextDay.remaining, 16);
      assert.equal(nextDay.upgradeDayClosed, false);
      assert.equal((await create()).status, 201);
      await evict();
      assert.equal((await list()).data.admission.recordsCreated, 1);
      assert.equal((await list()).data.admission.remaining, 15);
      assert.deepEqual(await storage.exec('SELECT * FROM brief_admission_meta'), marker);
    },
  );
console.log(
  'PASS legacy migration closes only its first UTC day, reports retained creation counts truthfully, preserves replay and cannot rebootstrap after eviction',
);

await withAdmissionFixture(
  async ({ storage, now, clock, create, list, get, evict, tick, incident, otherIncident }) => {
    const providerCalls = calls.length;
    let first;
    for (let day = 0; day < 16; day++) {
      await clock(now + day * DAY);
      const results = await Promise.all(Array.from({ length: 16 }, () => create()));
      assert(results.every((result) => result.status === 201));
      first ??= results[0].data.brief;
      assert.equal((await list()).data.admission.recordsCreated, 16);
      assert.equal((await create()).data.code, 'brief-record-limit');
    }
    await clock(now + 16 * DAY);
    const full = (await list()).data.admission;
    assert.equal(full.recordsCreated, 0);
    assert.equal(full.remaining, 16);
    assert.equal(full.retainedRecords, 256);
    const denied = await create();
    assert.equal(denied.status, 429);
    assert.equal(denied.data.code, 'brief-record-limit');
    assert.equal(denied.data.brief, undefined);
    assert.equal((await get(first.requestId)).status, 200);
    assert.equal((await create(incident, first.requestId)).status, 200);
    assert.equal((await create(otherIncident, first.requestId)).status, 409);
    assert.deepEqual((await list()).data.admission, full);
    await evict();
    assert.deepEqual((await list()).data.admission, full);
    await storage.exec('DELETE FROM incident_briefs WHERE request_id=?', first.requestId);
    const race = await Promise.all([create(), create()]);
    assert.equal(race.filter((result) => result.status === 201).length, 1);
    assert.equal(race.filter((result) => result.status === 429).length, 1);
    const last = race.find((result) => result.status === 201).data.brief;
    assert.equal((await list()).data.admission.recordsCreated, 1);
    assert.equal((await list()).data.admission.retainedRecords, 256);
    await storage.exec('DELETE FROM incident_briefs WHERE request_id=?', last.requestId);
    assert.equal((await list()).data.admission.recordsCreated, 1);
    assert.equal((await list()).data.admission.remaining, 15);
    assert.equal(calls.length, providerCalls);
    assert.equal((await list()).data.quota.attempts, 0);

    // The incident may eventually be pruned by cron, so keep one eligible open
    // fixture solely to inspect the deployment's independent admission counters.
    const retainedIncident = randomUUID();
    await storage.exec(
      'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
      retainedIncident,
      'catalog',
      now,
      null,
      null,
      '',
    );
    const marker = await storage.exec('SELECT * FROM brief_admission_meta');
    await tick(now + 47 * DAY);
    assert.equal((await storage.exec('SELECT * FROM incident_briefs')).length, 0);
    assert.equal((await storage.exec('SELECT * FROM brief_admission')).length, 0);
    assert.deepEqual(await storage.exec('SELECT * FROM brief_admission_meta'), marker);
    const afterRetention = (await list(retainedIncident)).data.admission;
    assert.equal(afterRetention.upgradeDayClosed, false);
    assert.equal(afterRetention.recordsCreated, 0);
    assert.equal(afterRetention.remaining, 16);
    assert.equal(afterRetention.retainedRecords, 0);
    assert.equal((await create(retainedIncident)).status, 201);
    console.log(
      'PASS 256 retained records block later-day creation, a concurrent last-slot race admits one, deletion never refunds counters, retention preserves one-time migration metadata',
    );
  },
);

await build({
  entryPoints: ['worker/incident-brief-domain.ts'],
  outfile: 'output/brief-domain-fixture.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'esnext',
});
const domain = await import('../output/brief-domain-fixture.mjs');
await withAdmissionFixture(
  async ({ storage, now, clock, call, create, list, get, badIncident }) => {
    const incident = await badIncident(50);
    mode = 'hold';
    const startCalls = calls.length;
    const baselinePromise = create(incident);
    await waitForHeld();
    const baseline = (await list(incident)).data.records[0];
    assert.equal(baseline.state, 'pending');
    assert.equal(baseline.evidence.versions.length, 50);
    held.shift()();
    assert.equal((await baselinePromise).status, 201);
    await clock(now + MINUTE);
    const fill = async (length) => {
      // The byte cap applies to the full JSON record, including escaped retained
      // policy text and frozen references, rather than JavaScript string length.
      await storage.exec(
        'UPDATE service_versions SET name=?,provenance=? WHERE service=? AND revision>=100',
        '\u0000'.repeat(length),
        '\u0000'.repeat(length),
        'catalog',
      );
      const detail = (await call(`incidents/${incident}`)).data;
      const snapshot = await domain.captureBriefEvidence(detail, now + MINUTE);
      const prepared = domain.buildBriefInput(snapshot.evidence);
      return encodedSize({
        ...baseline,
        createdAt: now + MINUTE,
        evidence: snapshot.evidence,
        evidenceHash: snapshot.evidenceHash,
        promptEvidenceIds: prepared.citationIds,
        omittedEvidenceCount: prepared.omittedEvidenceCount,
        messageBytes: prepared.messageBytes,
        inputBytes: prepared.inputBytes,
      });
    };
    let low = 1;
    let high = 80;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((await fill(middle)) <= RECORD_BYTES - HEADROOM_BYTES) low = middle;
      else high = middle;
    }
    const rejectedBytes = await fill(high);
    assert(rejectedBytes > RECORD_BYTES - HEADROOM_BYTES);
    assert(
      rejectedBytes < RECORD_BYTES,
      'Fixture must prove that completion headroom, not just 128 KiB, is enforced',
    );
    const beforeSize = (await list(incident)).data;
    const sizeId = randomUUID();
    const sizeFailure = await create(incident, sizeId);
    assert.equal(sizeFailure.status, 422);
    assert.equal(sizeFailure.data.code, 'brief-record-size');
    assert.equal(sizeFailure.data.brief, undefined);
    assert.equal((await get(sizeId)).status, 404);
    assert.deepEqual((await list(incident)).data.admission, beforeSize.admission);
    assert.deepEqual((await list(incident)).data.quota, beforeSize.quota);
    assert.equal(calls.length, startCalls + 1);

    const acceptedBytes = await fill(low);
    assert(acceptedBytes <= RECORD_BYTES - HEADROOM_BYTES);
    assert(acceptedBytes > RECORD_BYTES - HEADROOM_BYTES - 2000);
    mode = 'hold';
    const nearId = randomUUID();
    const pending = create(incident, nearId);
    await waitForHeld();
    const row = (
      await storage.exec('SELECT record FROM incident_briefs WHERE request_id=?', nearId)
    )[0];
    const original = JSON.parse(row.record);
    assert.equal(Buffer.byteLength(row.record), acceptedBytes);
    assert(Buffer.byteLength(row.record) <= RECORD_BYTES - HEADROOM_BYTES);
    assert.equal(original.evidence.checks.length, 50);
    assert.equal(original.evidence.versions.length, 50);
    assert(original.evidence.versions.every((version) => version.name === '\u0000'.repeat(low)));
    held.shift()();
    const complete = await pending;
    assert.equal(complete.status, 201);
    assert.equal(complete.data.brief.state, 'complete');
    assert.deepEqual(complete.data.brief.evidence, original.evidence);
    assert(encodedSize(complete.data.brief) <= RECORD_BYTES);
    assert.equal((await list(incident)).data.admission.recordsCreated, 2);
    assert.equal((await list(incident)).data.quota.attempts, 2);

    // Size rejection retained no UUID row, so explicit same-ID retry is safe once
    // the evidence fits and the independent AI minute gate permits a new attempt.
    await clock(now + 2 * MINUTE);
    mode = 'maximum';
    const resized = await create(incident, sizeId);
    assert.equal(resized.status, 201);
    assert.equal(resized.data.brief.generated.hypotheses[0].explanation.length, 200);
    assert(encodedSize(resized.data.brief) <= RECORD_BYTES);
    assert.equal((await list(incident)).data.admission.recordsCreated, 3);
    assert.equal((await list(incident)).data.quota.attempts, 3);
    console.log(
      `PASS UTF-8 full-record cap rejects ${rejectedBytes} bytes before reservation, admits ${acceptedBytes} bytes with 9 KiB completion headroom, preserves all evidence and bounds final output`,
    );
  },
);

await withAdmissionFixture(async ({ storage, create, list, get, badIncident }) => {
  const incident = await badIncident();
  const requestId = randomUUID();
  mode = 'valid';
  const before = (await list(incident)).data;
  const beforeCalls = calls.length;
  await storage.exec(
    "CREATE TRIGGER fixture_admission_rollback BEFORE INSERT ON brief_quota BEGIN SELECT RAISE(ABORT,'fixture quota reservation failure'); END",
  );
  const failed = await create(incident, requestId);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.code, 'monitor-storage-unavailable');
  assert.equal((await get(requestId)).status, 404);
  assert.deepEqual((await list(incident)).data.admission, before.admission);
  assert.deepEqual((await list(incident)).data.quota, before.quota);
  assert.equal(calls.length, beforeCalls);
  assert.equal((await storage.exec('SELECT * FROM incident_briefs')).length, 0);
  await storage.exec('DROP TRIGGER fixture_admission_rollback');
  assert.equal((await create(incident, requestId)).status, 201);
  assert.equal((await list(incident)).data.admission.recordsCreated, 1);
  assert.equal((await list(incident)).data.quota.attempts, 1);
  assert.equal(calls.length, beforeCalls + 1);
  console.log(
    'PASS an actual SQLite quota-write failure rolls back row, creation counter and AI reservation atomically before provider dispatch',
  );
});

// Force only the preparation branch in a separate test bundle. This exercises
// persisted deterministic failures without modifying production domain code.
await build({
  entryPoints: ['tests/fixtures/brief-clock.ts'],
  outfile: 'output/brief-preparation-fixture/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
  plugins: [
    {
      name: 'fixture-preparation-failure',
      setup(build) {
        build.onLoad({ filter: /incident-brief-domain\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const signature =
            'export function buildBriefInput(evidence: BriefEvidence): PreparedBriefInput {';
          assert(source.includes(signature));
          return {
            loader: 'ts',
            contents: source.replace(
              signature,
              `${signature}\nthrow new Error('Fixture preparation failure');`,
            ),
          };
        });
      },
    },
  ],
});
await withAdmissionFixture(async ({ create, list, get, badIncident }) => {
  const incident = await badIncident();
  const beforeCalls = calls.length;
  const results = await Promise.all(Array.from({ length: 32 }, () => create(incident)));
  const stored = results.filter((result) => result.status === 422);
  assert.equal(stored.length, 16);
  assert.equal(results.filter((result) => result.status === 429).length, 16);
  for (const result of stored) {
    assert.equal(result.data.brief.state, 'failed');
    assert.equal(result.data.brief.failure.code, 'evidence-limit');
    assert.equal((await get(result.data.brief.requestId)).status, 200);
    assert.equal((await create(incident, result.data.brief.requestId)).status, 200);
  }
  assert.equal((await list(incident)).data.admission.recordsCreated, 16);
  assert.equal((await list(incident)).data.admission.retainedRecords, 16);
  assert.equal((await list(incident)).data.quota.attempts, 0);
  assert.equal(calls.length, beforeCalls);
  console.log(
    'PASS sixteen preparation-failure records consume the independent storage allowance, retain UUID replay and consume no AI attempts',
  );
}, 'output/brief-preparation-fixture/index.js');
