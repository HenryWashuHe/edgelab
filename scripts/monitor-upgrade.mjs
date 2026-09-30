import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const MINUTE = 60000;
const token = 'monitor-upgrade-test-token-not-a-production-credential';
const defaultPolicy = {
  paused: false,
  timeoutMs: 3000,
  latencyObjectiveMs: 1500,
  availabilityTarget: 99.9,
  failureThreshold: 3,
  recoveryThreshold: 2,
};
const currentPolicy = { ...defaultPolicy, timeoutMs: 1200, latencyObjectiveMs: 700 };
const targets = ['failure', 'recovery'].map((id) => ({
  id,
  name: `${id} service`,
  url: `https://origin.internal/${id}`,
  transport: 'origin',
  assertion: 'ok-json',
}));
const calls = { failure: 0, recovery: 0 };
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
          ORIGIN: async (request) => {
            const service = new URL(request.url).pathname.slice(1);
            assert(service === 'failure' || service === 'recovery');
            calls[service]++;
            return Response.json(
              { ok: service === 'recovery' },
              { status: service === 'failure' ? 503 : 200 },
            );
          },
        },
      },
    ],
  }),
);
const read = async (path = 'status', operator = false) => {
  const response = await mf.dispatchFetch(`https://edgelab.example/api/ops/${path}`, {
    headers: operator ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.equal(response.status, 200);
  return response.json();
};

try {
  await read();
  const storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  const now = Date.now();
  const slot = Math.floor(now / MINUTE);
  const incidentId = randomUUID();
  const acknowledgement = 'Private acknowledgement from the previous release';
  // Recreate the original v3 shape in the persisted database, then restart the
  // actual production class. No fixture override participates in this migration.
  // New retention triggers refer to service_versions even from services/checks;
  // a faithful legacy database cannot retain those triggers after dropping it.
  const retentionTriggers = await storage.exec(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'monitor_version_gc_%' OR name LIKE 'incident_note_gc_%')",
  );
  for (const { name } of retentionTriggers) {
    assert(/^(monitor_version_gc_|incident_note_gc_)[a-z_]+$/.test(name));
    await storage.exec(`DROP TRIGGER ${name}`);
  }
  for (const table of [
    'monitor_version_gc',
    'monitor_version_gc_meta',
    'incident_note_gc',
    'incident_note_gc_meta',
  ])
    await storage.exec(`DROP TABLE IF EXISTS ${table}`);
  assert.deepEqual(
    await storage.exec(
      "SELECT name FROM sqlite_master WHERE name LIKE 'monitor_version_gc%' OR name LIKE 'incident_note_gc%'",
    ),
    [],
  );
  await storage.exec('ALTER TABLE checks DROP COLUMN observed_at');
  await storage.exec('DROP TABLE service_versions');
  await storage.exec(
    'UPDATE services SET created=?,revision=?,policy=?,state=? WHERE id=?',
    now - 10 * MINUTE,
    7,
    JSON.stringify(currentPolicy),
    JSON.stringify({ failures: 2, successes: 0, lastSlot: slot - 1, incidentId: null }),
    'failure',
  );
  await storage.exec(
    'UPDATE services SET created=?,state=? WHERE id=?',
    now - 10 * MINUTE,
    JSON.stringify({ failures: 0, successes: 1, lastSlot: slot - 1, incidentId }),
    'recovery',
  );
  await storage.exec(
    'INSERT INTO incidents(id,service,opened,resolved,acknowledged,note) VALUES(?,?,?,?,?,?)',
    incidentId,
    'recovery',
    now - 3 * MINUTE,
    null,
    now - 2 * MINUTE,
    acknowledgement,
  );
  for (let offset = 1; offset <= 2; offset++)
    await storage.exec(
      'INSERT INTO checks(service,slot,at,outcome,status,latency,revision) VALUES(?,?,?,?,?,?,?)',
      'failure',
      slot - offset,
      (slot - offset) * MINUTE + 1000,
      'http-error',
      503,
      25,
      7,
    );
  await storage.exec(
    'INSERT INTO checks(service,slot,at,outcome,status,latency,revision) VALUES(?,?,?,?,?,?,?)',
    'failure',
    slot - 3,
    (slot - 3) * MINUTE + 1000,
    'good',
    200,
    25,
    6,
  );
  await storage.exec(
    'INSERT INTO checks(service,slot,at,outcome,status,latency,revision) VALUES(?,?,?,?,?,?,?)',
    'recovery',
    slot - 1,
    (slot - 1) * MINUTE + 1000,
    'good',
    200,
    25,
    1,
  );
  const legacySource = await storage.exec(
    'SELECT service,slot,at,outcome,status,latency,revision FROM checks ORDER BY service,slot',
  );
  const legacyIncident = await storage.exec('SELECT * FROM incidents WHERE id=?', incidentId);
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  const upgraded = await read();
  const failure = upgraded.services.find((service) => service.id === 'failure');
  const recovery = upgraded.services.find((service) => service.id === 'recovery');
  assert.deepEqual(failure.state, { failures: 0, successes: 0, lastSlot: null, incidentId: null });
  assert.deepEqual(recovery.state, { failures: 0, successes: 0, lastSlot: null, incidentId });
  assert.equal(failure.revision, 7);
  assert.deepEqual(failure.policy, currentPolicy);
  assert.deepEqual(recovery.policy, defaultPolicy);
  assert.equal(upgraded.incidents.find((incident) => incident.id === incidentId).resolved, null);
  const schema = await storage.exec('PRAGMA table_info(checks)');
  assert(schema.some((column) => column.name === 'observed_at'));
  const legacy = await storage.exec('SELECT observed_at FROM checks');
  assert.equal(legacy.length, 4);
  assert(legacy.every((check) => check.observed_at === null));
  assert.deepEqual(
    await storage.exec(
      'SELECT service,slot,at,outcome,status,latency,revision FROM checks ORDER BY service,slot',
    ),
    legacySource,
  );
  assert.deepEqual(
    await storage.exec('SELECT * FROM incidents WHERE id=?', incidentId),
    legacyIncident,
  );
  for (const marker of ['monitor_version_gc_meta', 'incident_note_gc_meta'])
    assert.deepEqual(await storage.exec(`SELECT * FROM ${marker}`), [{ id: 1, version: 1 }]);
  for (const queue of ['monitor_version_gc', 'incident_note_gc'])
    assert.deepEqual(await storage.exec(`SELECT * FROM ${queue}`), []);
  for (const service of [failure, recovery]) {
    assert.equal(service.status, 'unknown');
    assert.equal(service.metrics.observed, 0);
    assert.equal(service.metrics.goodRatio, null);
    assert.equal(service.metrics.p95Ms, null);
    assert(service.metrics.unverified > 0);
    assert(service.history.every((check) => check.observedAt === null));
  }
  console.log(
    'PASS real v3 schema upgrade preserves exact legacy checks/policies/open incident, resets both streaks and initializes retention migration once without invented candidates',
  );

  const versions = await storage.exec('SELECT * FROM service_versions ORDER BY service,revision');
  assert.equal(versions.length, 2);
  assert(versions.every((version) => version.provenance === 'recovered-current'));
  const failureVersion = versions.find((version) => version.service === 'failure');
  assert.equal(failureVersion.revision, 7);
  assert.deepEqual(JSON.parse(failureVersion.policy), currentPolicy);
  const recoveryVersion = versions.find((version) => version.service === 'recovery');
  assert.equal(recoveryVersion.revision, 1);
  assert.deepEqual(JSON.parse(recoveryVersion.policy), defaultPolicy);
  assert(!versions.some((version) => version.service === 'failure' && version.revision === 6));
  const oldDetail = await read(`incidents/${incidentId}`, true);
  assert.equal(oldDetail.acknowledgementNote, acknowledgement);
  assert(oldDetail.checks.every((check) => check.observedAt === null));
  assert.equal(oldDetail.versions[0].provenance, 'recovered-current');
  const captured = versions.map(({ service, revision, recorded_at, policy, provenance }) => ({
    service,
    revision,
    recorded_at,
    policy,
    provenance,
  }));
  await read();
  for (const queue of ['monitor_version_gc', 'incident_note_gc'])
    assert.deepEqual(await storage.exec(`SELECT * FROM ${queue}`), []);
  assert.deepEqual(
    (await storage.exec('SELECT * FROM service_versions ORDER BY service,revision')).map(
      ({ service, revision, recorded_at, policy, provenance }) => ({
        service,
        revision,
        recorded_at,
        policy,
        provenance,
      }),
    ),
    captured,
  );
  console.log(
    'PASS recovered current/default policy versions are explicit and immutable; old revisions are not guessed',
  );

  const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  const stub = ns.get(ns.idFromName('operations'));
  const newSlot = Math.floor(Date.now() / MINUTE);
  const tick = await stub.fetch('https://monitor.internal/tick', {
    method: 'POST',
    body: JSON.stringify({ slot: newSlot }),
  });
  assert.equal(tick.status, 200);
  const tickResult = await tick.json();
  assert.equal(
    tickResult.results.find((result) => result.service === 'failure').result,
    'http-error',
  );
  assert.equal(tickResult.results.find((result) => result.service === 'recovery').result, 'good');
  assert.deepEqual(calls, { failure: 1, recovery: 1 });
  const checked = await read();
  assert.equal(checked.services.find((service) => service.id === 'failure').state.failures, 1);
  assert.equal(checked.services.find((service) => service.id === 'failure').state.incidentId, null);
  assert.equal(checked.services.find((service) => service.id === 'recovery').state.successes, 1);
  assert.equal(
    checked.services.find((service) => service.id === 'recovery').state.incidentId,
    incidentId,
  );
  assert.equal(checked.incidents.find((incident) => incident.id === incidentId).resolved, null);
  assert.equal(checked.incidents.length, 1);
  const newChecks = await storage.exec('SELECT observed_at FROM checks WHERE slot=?', newSlot);
  assert.equal(newChecks.length, 2);
  assert(newChecks.every((check) => check.observed_at !== null));
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  const restarted = await read();
  assert.equal(restarted.services.find((service) => service.id === 'failure').state.failures, 1);
  assert.equal(restarted.services.find((service) => service.id === 'recovery').state.successes, 1);
  assert.equal(
    restarted.services.find((service) => service.id === 'recovery').state.incidentId,
    incidentId,
  );
  console.log(
    'PASS first timed failure cannot inherit a v3 incident streak; first timed success cannot recover a v3 incident',
  );
} finally {
  await mf.dispose();
}
