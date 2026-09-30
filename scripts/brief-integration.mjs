import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const options = (enabled = true, fake = true, targets = [target]) =>
  convertV4MiniflareOptions({
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: 'output/brief-clock-worker/index.js',
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
  await clock(thirdDay + 20000);
  const expired = await get(lateId);
  assert.equal(expired.status, 200);
  assert.equal(expired.data.brief.state, 'interrupted');
  assert.equal(expired.data.brief.failure.code, 'interrupted');
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
