import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const token = 'incident-test-operator-token-not-a-real-credential';
const target = {
  id: 'catalog',
  name: 'Catalog',
  url: 'https://origin.internal/health',
  transport: 'origin',
  assertion: 'ok-json',
};
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
        bindings: { MONITOR_TARGETS: JSON.stringify([target]), OPERATOR_TOKEN: token },
        serviceBindings: { ORIGIN: async () => Response.json({ ok: true }) },
      },
    ],
  }),
);
const call = async (path, { operator = false, body, method, headers = {} } = {}) => {
  const response = await mf.dispatchFetch(`https://edgelab.example/api/ops/${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(operator ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
};
const policy = {
  paused: false,
  timeoutMs: 3000,
  latencyObjectiveMs: 1500,
  availabilityTarget: 99.9,
  failureThreshold: 3,
  recoveryThreshold: 2,
};

try {
  await call('status');
  const storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  const now = Date.now();
  const currentSlot = Math.floor(now / MINUTE);
  const oldOpenId = randomUUID();
  const resolvedId = randomUUID();
  const removedId = randomUUID();
  const acknowledgementNote = 'Private original investigation note';
  await storage.exec(
    'INSERT INTO incidents(id,service,opened,resolved,acknowledged,note) VALUES(?,?,?,?,?,?)',
    oldOpenId,
    'catalog',
    now - 31 * DAY,
    null,
    now - 30 * DAY,
    acknowledgementNote,
  );
  await storage.exec(
    'UPDATE services SET state=? WHERE id=?',
    JSON.stringify({ failures: 3, successes: 0, lastSlot: currentSlot - 1, incidentId: oldOpenId }),
    'catalog',
  );
  for (let i = 0; i < 120; i++)
    await storage.exec(
      'INSERT INTO incidents(id,service,opened,resolved,acknowledged,note) VALUES(?,?,?,?,?,?)',
      i === 119 ? resolvedId : randomUUID(),
      'catalog',
      now - (i === 119 ? 30 : 240 - i) * MINUTE,
      now - (i === 119 ? 20 : 239 - i) * MINUTE,
      null,
      '',
    );
  for (let i = 0; i < 120; i++)
    await storage.exec(
      'INSERT INTO incidents(id,service,opened,resolved,acknowledged,note) VALUES(?,?,?,?,?,?)',
      i === 119 ? removedId : randomUUID(),
      'removed',
      now - (120 - i) * MINUTE,
      now - (119 - i) * MINUTE,
      null,
      'Removed service private note',
    );
  const snapshot = (await call('status')).data;
  assert.equal(snapshot.incidents.length, 101);
  assert(snapshot.incidents.some((incident) => incident.id === oldOpenId));
  assert.equal(snapshot.incidents.filter((incident) => incident.resolved === null).length, 1);
  assert.equal(snapshot.incidents.filter((incident) => incident.resolved !== null).length, 100);
  assert(snapshot.incidents.every((incident) => incident.service === 'catalog'));
  assert(!JSON.stringify(snapshot.incidents).includes('note'));
  assert.equal((await call(`incidents/${removedId}`)).status, 404);
  console.log(
    'PASS all active open incidents survive >100 newer resolved and removed-target records',
  );

  const oldPolicy = { ...policy, latencyObjectiveMs: 200 };
  await storage.exec(
    'INSERT OR REPLACE INTO service_versions(service,revision,recorded_at,name,transport,assertion,policy,provenance) VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    2,
    now - 90 * MINUTE,
    'Historical catalog',
    'origin',
    'ok-json',
    JSON.stringify(oldPolicy),
    'recorded',
  );
  for (let i = 1; i <= 90; i++) {
    const slot = currentSlot - i;
    await storage.exec(
      'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
      'catalog',
      slot,
      slot * MINUTE + 1000,
      i % 3 === 0 ? 'slow' : 'good',
      200,
      i % 3 === 0 ? 250 : 30,
      i % 10 === 0 ? 99 : 2,
      i === 90 ? null : slot * MINUTE + 900,
    );
  }
  await storage.exec(
    'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    currentSlot - 31 * 24 * 60,
    now - 31 * DAY,
    'http-error',
    503,
    10,
    99,
    null,
  );
  const first = await call(`incidents/${oldOpenId}`);
  assert.equal(first.status, 200);
  assert.equal(first.data.checks.length, 50);
  assert.equal(first.data.nextCursor, currentSlot - 50);
  assert.equal(first.data.range.limitedByRetention, true);
  assert(first.data.range.retentionStart > now - 31 * DAY);
  assert(first.data.versions.some((version) => version.revision === 2));
  assert.equal(
    first.data.versions.find((version) => version.revision === 2).policy.latencyObjectiveMs,
    200,
  );
  assert(!first.data.versions.some((version) => version.revision === 99));
  assert(first.data.checks.some((check) => check.revision === 99));
  assert(first.data.checks.every((check) => check.observedAt !== undefined));
  assert.deepEqual(
    first.data.lifecycle.map((event) => event.action),
    ['incident.opened', 'incident.acknowledged'],
  );
  assert(!('notes' in first.data));
  assert(!('acknowledgementNote' in first.data));
  assert(!JSON.stringify(first.data).includes(acknowledgementNote));
  assert(!JSON.stringify(first.data).includes('origin.internal'));
  await storage.exec(
    'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    currentSlot,
    now,
    'good',
    200,
    20,
    2,
    now,
  );
  const second = await call(`incidents/${oldOpenId}?before=${first.data.nextCursor}`);
  assert.equal(second.status, 200);
  assert.equal(second.data.checks.length, 40);
  assert.equal(second.data.nextCursor, null);
  assert.equal(second.data.checks.at(-1).observedAt, null);
  const allSlots = [...first.data.checks, ...second.data.checks].map((check) => check.slot);
  assert.equal(new Set(allSlots).size, 90);
  assert.deepEqual(
    allSlots,
    Array.from({ length: 90 }, (_, i) => currentSlot - i - 1),
  );
  assert.equal((await call(`incidents/${oldOpenId}?before=bad`)).status, 400);
  assert.equal((await call(`incidents/${oldOpenId}?before=1.5`)).status, 400);
  assert.equal((await call(`incidents/${oldOpenId}?before=-1`)).status, 400);
  assert.equal((await call(`incidents/${randomUUID()}`)).status, 404);
  assert.equal((await call(`incidents/${oldOpenId}`, { method: 'POST' })).status, 405);
  const recoveredEvidence = (await call(`incidents/${resolvedId}`)).data;
  assert.equal(recoveredEvidence.range.fromSlot, currentSlot - 40);
  assert.equal(recoveredEvidence.range.toSlot, currentSlot - 19);
  assert.equal(recoveredEvidence.checks.length, 22);
  assert(recoveredEvidence.checks.every((check) => check.slot >= currentSlot - 40));
  assert(recoveredEvidence.checks.every((check) => check.slot <= currentSlot - 19));
  assert.equal(recoveredEvidence.lifecycle.at(-1).action, 'incident.recovered');
  console.log(
    'PASS retention-aware evidence, immutable policy mapping, and stable seek pagination',
  );

  const requestId = randomUUID();
  const body = {
    incident: oldOpenId,
    requestId,
    note: 'Private progress note: checking origin logs',
  };
  assert.equal((await call('incident-note', { body })).status, 401);
  assert.equal(
    (
      await call('incident-note', {
        operator: true,
        body,
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const concurrentNotes = await Promise.all(
    Array.from({ length: 12 }, () => call('incident-note', { operator: true, body })),
  );
  assert.equal(concurrentNotes.filter((result) => result.status === 201).length, 1);
  assert.equal(concurrentNotes.filter((result) => result.status === 200).length, 11);
  const retry = await call('incident-note', { operator: true, body });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.alreadyRecorded, true);
  const noteAudit = await storage.exec(
    "SELECT detail FROM audit WHERE action='incident.note-added' AND json_extract(detail,'$.requestId')=?",
    requestId,
  );
  assert.equal(noteAudit.length, 1);
  assert(!noteAudit[0].detail.includes(body.note));
  assert.equal(
    (await call('incident-note', { operator: true, body: { ...body, note: 'Changed payload' } }))
      .status,
    409,
  );
  assert.equal(
    (await call('incident-note', { operator: true, body: { ...body, incident: resolvedId } }))
      .status,
    409,
  );
  for (const patch of [
    { requestId: 'bad' },
    { note: '' },
    { note: ' '.repeat(3) },
    { note: 'x'.repeat(501) },
  ])
    assert.equal(
      (await call('incident-note', { operator: true, body: { ...body, ...patch } })).status,
      400,
    );
  assert.equal(
    (await call('incident-note', { operator: true, body: { ...body, incident: removedId } }))
      .status,
    404,
  );
  const postmortem = {
    incident: resolvedId,
    requestId: randomUUID(),
    note: 'Private recovery analysis',
  };
  assert.equal((await call('incident-note', { operator: true, body: postmortem })).status, 201);
  const operatorDetail = (await call(`incidents/${oldOpenId}`, { operator: true })).data;
  assert.equal(operatorDetail.acknowledgementNote, acknowledgementNote);
  assert.equal(operatorDetail.notes.length, 1);
  assert.equal(operatorDetail.notes[0].note, body.note);
  const publicDetail = (await call(`incidents/${oldOpenId}`)).data;
  assert(!('notes' in publicDetail));
  assert(!('acknowledgementNote' in publicDetail));
  assert(!JSON.stringify(publicDetail).includes(body.note));
  assert(!JSON.stringify((await call('export')).data).includes(body.note));
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  const afterEviction = (await call(`incidents/${oldOpenId}`, { operator: true })).data;
  assert.deepEqual(afterEviction.notes, operatorDetail.notes);
  assert.deepEqual(afterEviction.versions, operatorDetail.versions);
  console.log(
    'PASS authenticated, private, retry-safe progress and postmortem notes across eviction',
  );

  for (let i = 1; i < 100; i++)
    await storage.exec(
      'INSERT INTO incident_notes(id,incident,at,note) VALUES(?,?,?,?)',
      randomUUID(),
      oldOpenId,
      now,
      `Fixture note ${i}`,
    );
  assert.equal(
    (await call('incident-note', { operator: true, body: { ...body, requestId: randomUUID() } }))
      .status,
    409,
  );
  assert.equal((await call('incident-note', { operator: true, body })).status, 200);
  const oldResolved = randomUUID();
  const orphanNote = randomUUID();
  await storage.exec(
    'INSERT INTO incidents(id,service,opened,resolved,acknowledged,note) VALUES(?,?,?,?,?,?)',
    oldResolved,
    'catalog',
    now - 32 * DAY,
    now - 31 * DAY,
    null,
    '',
  );
  await storage.exec(
    'INSERT INTO incident_notes(id,incident,at,note) VALUES(?,?,?,?)',
    orphanNote,
    oldResolved,
    now,
    'Recent note for an expired resolved incident',
  );
  const expiredNote = randomUUID();
  await storage.exec(
    'INSERT INTO incident_notes(id,incident,at,note) VALUES(?,?,?,?)',
    expiredNote,
    oldOpenId,
    now - 31 * DAY,
    'Expired private progress note',
  );
  const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  const stub = ns.get(ns.idFromName('operations'));
  const tick = await stub.fetch('https://monitor.internal/tick', {
    method: 'POST',
    body: JSON.stringify({ slot: Math.floor(Date.now() / MINUTE) }),
  });
  assert.equal(tick.status, 200);
  assert.equal(
    (await storage.exec('SELECT id FROM incident_notes WHERE id=?', expiredNote)).length,
    0,
  );
  assert.equal(
    (await storage.exec('SELECT id FROM incident_notes WHERE id=?', orphanNote)).length,
    0,
  );
  assert.equal((await storage.exec('SELECT id FROM incidents WHERE id=?', oldOpenId)).length, 1);
  assert.equal(
    (await storage.exec('SELECT id FROM incident_notes WHERE id=?', requestId)).length,
    1,
  );
  console.log(
    'PASS bounded notes, idempotent retry at capacity, private-note retention, and orphan cleanup',
  );
} finally {
  await mf.dispose();
}
