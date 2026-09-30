import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Ephemeral actual workerd/SQLite only: no production requests, credentials, AI,
// or deletion of real history. Narrow helper costs are not whole-cron capacity.
await build({
  entryPoints: ['tests/fixtures/monitor-retention.ts'],
  outfile: 'output/monitor-retention-worker/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
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
        scriptPath: 'output/monitor-retention-worker/index.js',
        compatibilityDate: '2026-09-01',
        durableObjects: {
          RETENTION: { className: 'RetentionFixture', useSQLite: true },
          MONITORS: { className: 'MonitorStore', useSQLite: true },
          LABS: { className: 'ReliabilityLab', useSQLite: true },
        },
        bindings: { MONITOR_TARGETS: JSON.stringify([target]), AI_BRIEFS_ENABLED: 'false' },
        serviceBindings: { ORIGIN: async () => Response.json({ ok: true }) },
      },
    ],
  }),
);
const policy = JSON.stringify({
  availabilityTarget: 99.9,
  latencyObjectiveMs: 500,
  timeoutMs: 5000,
  failureThreshold: 3,
  recoveryThreshold: 2,
  paused: false,
});
const at = Math.floor(Date.now() / 60000) * 60000 + 1000;
const versionStatement = (service, revision) => ({
  query: 'INSERT INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
  args: [
    service,
    revision,
    at,
    'Immutable fixture policy',
    'origin',
    'ok-json',
    policy,
    'recorded',
  ],
});
const checkStatement = (service, slot, revision, observedAt = at, outcome = 'good') => ({
  query: 'INSERT INTO checks VALUES(?,?,?,?,?,?,?,?)',
  args: [service, slot, at, outcome, outcome === 'good' ? 200 : null, 25, revision, observedAt],
});
const serviceStatement = (service, revision) => ({
  query: 'INSERT INTO services VALUES(?,?,?,?,?,?,?)',
  args: [service, service, JSON.stringify({ ...target, id: service }), policy, '{}', revision, at],
});
const queueSQL = 'SELECT id,service,revision FROM monitor_version_gc ORDER BY id';
const versionsSQL = 'SELECT * FROM service_versions ORDER BY service,revision';
const sourceSQL = [
  'SELECT * FROM services ORDER BY id',
  'SELECT * FROM checks ORDER BY service,slot',
];
try {
  const ns = await mf.getDurableObjectNamespace('RETENTION', 'gateway');
  const fixture = (name) => {
    const stub = ns.get(ns.idFromName(name));
    const call = async (path, body = {}, expected = 200) => {
      const response = await stub.fetch(`https://retention-fixture.internal/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, expected, JSON.stringify({ path, data }));
      return data;
    };
    const exec = async (query, ...args) => (await call('exec', { query, args })).rows;
    const statements = (items) => call('transaction', { statements: items });
    const state = async () => Promise.all(sourceSQL.map((query) => exec(query)));
    const drain = async (max = 20) => {
      for (let i = 0; i < max; i++) {
        if (!(await exec(queueSQL)).length) return;
        await call('prune');
      }
      assert.fail(`Queue failed to drain within ${max} bounded passes`);
    };
    const evict = () => mf.unsafeEvictDurableObject('gateway', 'RetentionFixture', { name });
    return { call, exec, statements, state, drain, evict };
  };

  // A bootstrap must discover source versions once, including direct legacy
  // imports. Later FIFO arrivals cannot starve those first queued candidates.
  const fair = fixture('fifo-fair');
  await fair.statements([
    ...Array.from({ length: 70 }, (_, i) => versionStatement('catalog', i + 1)),
    versionStatement('catalog', 1000),
    versionStatement('catalog', 1001),
    serviceStatement('catalog', 1000),
    checkStatement('catalog', 1, 1001, null, 'maintenance'),
  ]);
  const originalSources = await fair.state();
  await fair.call('schema');
  assert.equal((await fair.exec(queueSQL)).length, 70);
  const batch = await fair.call('prune');
  assert.equal(batch.bound, 32);
  assert.equal((await fair.exec(versionsSQL)).length, 40);
  assert.equal((await fair.exec(queueSQL)).length, 38);
  for (let pass = 0; pass < 2; pass++) {
    await fair.statements(
      Array.from({ length: 64 }, (_, i) => versionStatement(`aaa-arrival-${pass}`, i + 1)),
    );
    await fair.call('prune');
  }
  assert.deepEqual(
    await fair.exec(
      'SELECT revision FROM service_versions WHERE service=? ORDER BY revision',
      'catalog',
    ),
    [{ revision: 1000 }, { revision: 1001 }],
  );
  assert.deepEqual(await fair.state(), originalSources);
  await fair.drain();
  assert.equal((await fair.exec(versionsSQL)).length, 2);
  assert.equal((await fair.call('prune')).rowsWritten, 0);
  console.log(
    'PASS FIFO32 drains older candidates despite faster new arrivals, preserves all current/legacy/maintenance source references, and becomes write-free when idle',
  );

  // Once a referenced key is dequeued, losing its last source reference must
  // re-enqueue it. A single remaining reference always protects the version.
  const refs = fixture('references');
  await refs.call('schema');
  await refs.statements([
    serviceStatement('catalog', 10),
    versionStatement('catalog', 10),
    versionStatement('catalog', 11),
    versionStatement('catalog', 12),
    versionStatement('gateway', 20),
    checkStatement('catalog', 1, 11),
    checkStatement('catalog', 2, 11, null),
    checkStatement('catalog', 3, 12),
    checkStatement('gateway', 1, 20),
  ]);
  await refs.drain();
  assert.equal((await refs.exec(versionsSQL)).length, 4);
  await refs.exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', 1);
  assert.deepEqual(await refs.exec(queueSQL), []);
  await refs.exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', 2);
  assert.equal((await refs.exec(queueSQL)).length, 1);
  await refs.drain();
  assert.equal(
    (
      await refs.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        11,
      )
    ).length,
    0,
  );
  await refs.exec('UPDATE checks SET revision=? WHERE service=? AND slot=?', 10, 'catalog', 3);
  await refs.drain();
  assert.equal(
    (
      await refs.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        12,
      )
    ).length,
    0,
  );
  await refs.exec(
    'UPDATE checks SET service=?,revision=? WHERE service=? AND slot=?',
    'catalog',
    10,
    'gateway',
    1,
  );
  await refs.drain();
  assert.equal(
    (await refs.exec('SELECT revision FROM service_versions WHERE service=?', 'gateway')).length,
    0,
  );
  await refs.exec('UPDATE services SET revision=? WHERE id=?', 13, 'catalog');
  await refs.statements([versionStatement('catalog', 13)]);
  await refs.drain();
  assert.equal(
    (
      await refs.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        10,
      )
    ).length,
    1,
  );
  await refs.exec('DELETE FROM checks WHERE service=?', 'catalog');
  await refs.drain();
  assert.equal(
    (
      await refs.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        10,
      )
    ).length,
    0,
  );
  await refs.exec('DELETE FROM services WHERE id=?', 'catalog');
  await refs.drain();
  assert.deepEqual(await refs.exec(versionsSQL), []);
  console.log(
    'PASS last-reference DELETE/revision UPDATE/service move and current-service revision/deletion requeue guarded cleanup',
  );

  // Native SQLite REPLACE can omit implicit DELETE triggers. BEFORE INSERT
  // guards must capture the previous key without enabling recursive_triggers.
  const replace = fixture('replacement');
  await replace.call('schema');
  await replace.statements([
    serviceStatement('catalog', 1),
    versionStatement('catalog', 1),
    versionStatement('catalog', 2),
    versionStatement('catalog', 3),
    checkStatement('catalog', 1, 2),
  ]);
  await replace.drain();
  assert.equal(
    (await replace.exec('SELECT revision FROM service_versions ORDER BY revision')).length,
    2,
  );
  await replace.exec(
    'INSERT OR REPLACE INTO checks VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    1,
    at,
    'good',
    200,
    30,
    1,
    at,
  );
  assert.equal((await replace.exec(queueSQL)).length, 1);
  await replace.drain();
  assert.equal(
    (await replace.exec('SELECT revision FROM service_versions WHERE revision=2')).length,
    0,
  );
  await replace.exec(
    'INSERT OR REPLACE INTO services VALUES(?,?,?,?,?,?,?)',
    'catalog',
    'Replacement',
    JSON.stringify(target),
    policy,
    '{}',
    3,
    at,
  );
  await replace.statements([versionStatement('catalog', 3)]);
  await replace.drain();
  assert.equal(
    (await replace.exec('SELECT revision FROM service_versions WHERE revision=1')).length,
    1,
  );
  await replace.exec('DELETE FROM checks');
  await replace.drain();
  assert.equal(
    (await replace.exec('SELECT revision FROM service_versions WHERE revision=1')).length,
    0,
  );
  await replace.exec(
    'INSERT OR REPLACE INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    3,
    at,
    'Reimported current policy',
    'origin',
    'ok-json',
    policy,
    'recorded',
  );
  await replace.drain();
  assert.equal(
    (await replace.exec('SELECT name FROM service_versions WHERE revision=3'))[0].name,
    'Reimported current policy',
  );
  console.log(
    'PASS direct version imports and check/service REPLACE preserve live references and collect superseded keys without recursive-trigger assumptions',
  );

  const reintroduced = fixture('reintroduced');
  await reintroduced.call('schema');
  await reintroduced.statements([versionStatement('catalog', 40), versionStatement('catalog', 41)]);
  const queued = await reintroduced.exec(queueSQL);
  await reintroduced.statements([
    checkStatement('catalog', 1, 40),
    serviceStatement('catalog', 41),
  ]);
  await reintroduced.call('mode', { automatic: true });
  await reintroduced.evict();
  assert.deepEqual(await reintroduced.exec(queueSQL), queued);
  const beforeRead = await reintroduced.exec(versionsSQL);
  await reintroduced.call('read', { activeIds: ['catalog'] });
  assert.deepEqual(await reintroduced.exec(queueSQL), queued);
  assert.deepEqual(await reintroduced.exec(versionsSQL), beforeRead);
  await reintroduced.drain();
  assert.equal((await reintroduced.exec(versionsSQL)).length, 2);
  await reintroduced.exec('DELETE FROM checks');
  await reintroduced.exec('DELETE FROM services');
  await reintroduced.drain();
  assert.deepEqual(await reintroduced.exec(versionsSQL), []);
  console.log(
    'PASS reference reintroduction, eviction and public incident reads preserve source-authoritative FIFO state',
  );

  // All source-trigger queue writes belong to the same transaction as the
  // mutation. The GC's version deletion and dequeue must also roll back together.
  const rollback = fixture('rollback');
  await rollback.call('schema');
  await rollback.statements([versionStatement('catalog', 50)]);
  const pending = await rollback.exec(queueSQL);
  const before = await rollback.exec(versionsSQL);
  await rollback.call('mode', { fault: 'DELETE FROM monitor_version_gc' });
  await rollback.call('prune', {}, 500);
  await rollback.call('mode');
  assert.deepEqual(await rollback.exec(queueSQL), pending);
  assert.deepEqual(await rollback.exec(versionsSQL), before);
  await rollback.drain();
  await rollback.statements([serviceStatement('catalog', 51), versionStatement('catalog', 51)]);
  await rollback.drain();
  const servicesBefore = await rollback.exec(sourceSQL[0]);
  await rollback.call('mode', { fault: 'UPDATE services SET revision' });
  await rollback.call(
    'transaction',
    { statements: [{ query: 'UPDATE services SET revision=? WHERE id=?', args: [52, 'catalog'] }] },
    500,
  );
  await rollback.call('mode');
  assert.deepEqual(await rollback.exec(sourceSQL[0]), servicesBefore);
  assert.deepEqual(await rollback.exec(queueSQL), []);
  console.log(
    'PASS failed source updates and GC dequeue roll back source rows, deleted versions and queued work atomically',
  );

  // Migration must retry after a failure, preserve imported evidence, and never
  // repeat its full backfill on eviction or ordinary schema/read calls.
  const migration = fixture('migration-rollback');
  await migration.statements([
    versionStatement('catalog', 60),
    versionStatement('catalog', 61),
    checkStatement('catalog', 1, 61, null),
  ]);
  const sourceBeforeMigration = await migration.state();
  const versionsBeforeMigration = await migration.exec(versionsSQL);
  await migration.call('mode', { automatic: true, fault: 'INSERT INTO monitor_version_gc_meta' });
  await migration.evict();
  assert.match(
    (await migration.call('state')).initializationFailure,
    /Injected local retention failure/,
  );
  assert.deepEqual(await migration.exec(versionsSQL), versionsBeforeMigration);
  assert.deepEqual(await migration.state(), sourceBeforeMigration);
  assert.deepEqual(
    await migration.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('monitor_version_gc','monitor_version_gc_meta')",
    ),
    [],
  );
  await migration.call('mode', { automatic: true });
  await migration.call('schema');
  assert.equal((await migration.exec(queueSQL)).length, 1);
  await migration.drain();
  assert.deepEqual(await migration.exec('SELECT revision FROM service_versions'), [
    { revision: 61 },
  ]);
  await migration.evict();
  assert.deepEqual(await migration.exec(queueSQL), []);
  assert.equal((await migration.call('schema')).rowsWritten, 0);
  assert.deepEqual(await migration.state(), sourceBeforeMigration);
  console.log(
    'PASS constructor migration failure rolls back bootstrap and marker, explicit retry succeeds once, and eviction never requeues retained metadata',
  );

  // Key imports are not production policy edits, but a raw renamed version
  // must still join the same guarded queue rather than becoming uncollectable.
  const moved = fixture('version-key-update');
  await moved.call('schema');
  await moved.statements([versionStatement('catalog', 70), checkStatement('catalog', 1, 70)]);
  await moved.drain();
  await moved.exec(
    'UPDATE service_versions SET service=?,revision=? WHERE service=? AND revision=?',
    'imported',
    71,
    'catalog',
    70,
  );
  assert.equal((await moved.exec(queueSQL)).length, 1);
  await moved.drain();
  assert.deepEqual(await moved.exec(versionsSQL), []);
  assert.equal((await moved.exec('SELECT revision FROM checks'))[0].revision, 70);

  const noteStatement = (id, incident, time = at) => ({
    query: 'INSERT INTO incident_notes VALUES(?,?,?,?)',
    args: [id, incident, time, `Private controlled note ${id}`],
  });
  const incidentStatement = (id, service = id, resolved = null) => ({
    query: 'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    args: [id, service, at - 60000, resolved, null, 'Private acknowledgement'],
  });
  const noteSQL = 'SELECT * FROM incident_notes ORDER BY id';
  const noteQueueSQL = 'SELECT id,note FROM incident_note_gc ORDER BY id';

  // New imports can temporarily lack a parent. Rechecking the FIFO after a
  // parent import preserves valid note bodies exactly; public reads never GC.
  const notes = fixture('note-imports');
  await notes.call('schema');
  await notes.statements([
    noteStatement('staged', 'staged-parent'),
    incidentStatement('staged-parent'),
  ]);
  const stagedQueue = await notes.exec(noteQueueSQL);
  const stagedBody = await notes.exec(noteSQL);
  await notes.call('read', { activeIds: ['staged-parent'] });
  assert.deepEqual(await notes.exec(noteQueueSQL), stagedQueue);
  assert.deepEqual(await notes.exec(noteSQL), stagedBody);
  await notes.call('notes-prune', { cutoff: at - 1 });
  assert.deepEqual(await notes.exec(noteSQL), stagedBody);
  assert.deepEqual(await notes.exec(noteQueueSQL), []);
  await notes.exec('UPDATE incidents SET id=? WHERE id=?', 'renamed-parent', 'staged-parent');
  assert.equal((await notes.exec(noteQueueSQL)).length, 1);
  await notes.exec('UPDATE incident_notes SET incident=? WHERE id=?', 'renamed-parent', 'staged');
  const reattached = await notes.exec(noteSQL);
  await notes.call('notes-prune', { cutoff: at - 1 });
  assert.deepEqual(await notes.exec(noteSQL), reattached);
  await notes.exec(
    'UPDATE incident_notes SET id=?,incident=? WHERE id=?',
    'renamed-note',
    'missing-parent',
    'staged',
  );
  assert.deepEqual(
    (await notes.exec(noteQueueSQL)).map((row) => row.note),
    ['renamed-note'],
  );
  await notes.exec('DELETE FROM incident_notes WHERE id=?', 'renamed-note');
  assert.deepEqual(await notes.exec(noteQueueSQL), []);
  await notes.statements([
    incidentStatement('delete-parent'),
    noteStatement('delete-note', 'delete-parent'),
  ]);
  await notes.exec('DELETE FROM incidents WHERE id=?', 'delete-parent');
  assert.equal((await notes.exec(noteQueueSQL)).length, 1);
  await notes.call('notes-prune', { cutoff: at - 1 });
  assert.deepEqual(await notes.exec(noteSQL), []);
  console.log(
    'PASS staged note imports, parent-ID edits, note reattachment/renaming/deletion and public reads preserve exact valid bodies and eventually remove only true orphans',
  );

  for (const recursive of [0, 1]) {
    const replacement = fixture(`note-replacement-${recursive}`);
    await replacement.call('schema');
    await replacement.exec(`PRAGMA recursive_triggers=${recursive}`);
    await replacement.statements([
      incidentStatement('old-parent', 'same-service'),
      noteStatement('same-id-note', 'old-parent'),
    ]);
    const valid = await replacement.exec(noteSQL);
    await replacement.exec(
      'INSERT OR REPLACE INTO incidents VALUES(?,?,?,?,?,?)',
      'old-parent',
      'same-service',
      at,
      null,
      at,
      'Replacement acknowledgement',
    );
    await replacement.call('notes-prune', { cutoff: at - 1 });
    assert.deepEqual(await replacement.exec(noteSQL), valid);
    // Unique open-service conflict implicitly removes old-parent. The new ID
    // does not own its old notes, so a BEFORE trigger must capture those IDs.
    await replacement.exec(
      'INSERT OR REPLACE INTO incidents VALUES(?,?,?,?,?,?)',
      'new-parent',
      'same-service',
      at,
      null,
      null,
      '',
    );
    assert.equal(
      (await replacement.exec('SELECT id FROM incidents WHERE id=?', 'old-parent')).length,
      0,
    );
    assert.equal((await replacement.exec(noteQueueSQL)).length, 1);
    await replacement.call('notes-prune', { cutoff: at - 1 });
    assert.deepEqual(await replacement.exec(noteSQL), []);
    await replacement.statements([
      incidentStatement('other-open', 'other-service'),
      noteStatement('other-note', 'other-open'),
      noteStatement('new-note', 'new-parent'),
    ]);
    await replacement.exec(
      'UPDATE OR REPLACE incidents SET service=? WHERE id=?',
      'other-service',
      'new-parent',
    );
    assert.equal(
      (await replacement.exec('SELECT id FROM incidents WHERE id=?', 'other-open')).length,
      0,
    );
    await replacement.call('notes-prune', { cutoff: at - 1 });
    assert.deepEqual(
      (await replacement.exec(noteSQL)).map((row) => row.id),
      ['new-note'],
    );
    // The parent can return before deferred cleanup, including same-ID notes
    // replaced while already queued. Its currently valid body must survive.
    await replacement.exec('DELETE FROM incidents WHERE id=?', 'new-parent');
    await replacement.exec(
      'INSERT OR REPLACE INTO incident_notes VALUES(?,?,?,?)',
      'new-note',
      'new-parent',
      at,
      'Reimported valid note body',
    );
    await replacement.statements([incidentStatement('new-parent', 'other-service')]);
    const restored = await replacement.exec(noteSQL);
    await replacement.call('notes-prune', { cutoff: at - 1 });
    assert.deepEqual(await replacement.exec(noteSQL), restored);
  }
  console.log(
    'PASS parent/note REPLACE and UPDATE OR REPLACE through primary/unique indexes behave correctly with recursive triggers both off and on',
  );

  const noteFair = fixture('note-fairness');
  await noteFair.call('schema');
  await noteFair.statements(
    Array.from({ length: 70 }, (_, i) => noteStatement(`old-${i}`, 'missing-old')),
  );
  const firstNotes = await noteFair.exec(noteSQL);
  assert.equal((await noteFair.exec(noteQueueSQL)).length, 70);
  const firstNoteBatch = await noteFair.call('notes-prune', { cutoff: at - 1 });
  assert.equal(firstNoteBatch.bound, 32);
  assert.equal((await noteFair.exec(noteSQL)).length, 38);
  for (let pass = 0; pass < 2; pass++) {
    await noteFair.statements(
      Array.from({ length: 64 }, (_, i) => noteStatement(`aaa-new-${pass}-${i}`, 'missing-new')),
    );
    await noteFair.call('notes-prune', { cutoff: at - 1 });
  }
  const remainingNoteIds = new Set((await noteFair.exec(noteSQL)).map((note) => note.id));
  assert(firstNotes.every((note) => !remainingNoteIds.has(note.id)));
  await noteFair.call('mode', { automatic: true });
  const fairPending = await noteFair.exec(noteQueueSQL);
  await noteFair.evict();
  assert.deepEqual(await noteFair.exec(noteQueueSQL), fairPending);
  for (let pass = 0; pass < 10 && (await noteFair.exec(noteQueueSQL)).length; pass++)
    await noteFair.call('notes-prune', { cutoff: at - 1 });
  assert.deepEqual(await noteFair.exec(noteQueueSQL), []);
  assert.deepEqual(await noteFair.exec(noteSQL), []);
  console.log(
    'PASS orphan-note FIFO32 remains fair under faster arrivals and survives actual eviction',
  );

  const ttl = fixture('note-ttl');
  await ttl.call('schema');
  await ttl.statements([
    incidentStatement('retained-open'),
    noteStatement('expired', 'retained-open', at - 1),
    noteStatement('cutoff-equal', 'retained-open', at),
    ...Array.from({ length: 100 }, (_, i) => noteStatement(`valid-${i}`, 'retained-open', at + 1)),
  ]);
  const beforeTTL = await ttl.exec(noteSQL);
  await ttl.call('notes-prune', { cutoff: at });
  assert.deepEqual(
    await ttl.exec(noteSQL),
    beforeTTL.filter((note) => note.id !== 'expired'),
  );
  assert.equal((await ttl.exec('SELECT id FROM incidents')).length, 1);
  const idleNoteCost = await ttl.call('notes-prune', { cutoff: at });
  assert.equal(idleNoteCost.rowsWritten, 0);
  assert(
    idleNoteCost.rowsRead <= 4,
    `Valid notes scanned despite indexed expiry: ${JSON.stringify(idleNoteCost)}`,
  );
  const expiryPlan = await ttl.exec('EXPLAIN QUERY PLAN DELETE FROM incident_notes WHERE at<?', at);
  assert(expiryPlan.some((row) => row.detail.includes('incident_notes_retention')));
  console.log(
    `PASS eager indexed note expiry keeps the exact cutoff and old open parent; 101 retained valid notes cost ${idleNoteCost.rowsRead} reads/0 writes in idle helper cleanup`,
  );

  const noteRollback = fixture('note-prune-rollback');
  await noteRollback.call('schema');
  await noteRollback.statements([
    noteStatement('orphan', 'missing'),
    noteStatement('expired-orphan', 'missing', at - 10),
  ]);
  const rollbackBodies = await noteRollback.exec(noteSQL);
  const rollbackQueue = await noteRollback.exec(noteQueueSQL);
  await noteRollback.call('mode', { fault: 'DELETE FROM incident_note_gc WHERE id=' });
  await noteRollback.call('notes-prune', { cutoff: at - 1 }, 500);
  await noteRollback.call('mode');
  assert.deepEqual(await noteRollback.exec(noteSQL), rollbackBodies);
  assert.deepEqual(await noteRollback.exec(noteQueueSQL), rollbackQueue);
  await noteRollback.call('notes-prune', { cutoff: at - 1 });
  assert.deepEqual(await noteRollback.exec(noteSQL), []);
  assert.deepEqual(await noteRollback.exec(noteQueueSQL), []);

  const noteMigration = fixture('note-migration-rollback');
  await noteMigration.exec(
    'CREATE TABLE incident_notes (id TEXT PRIMARY KEY,incident TEXT NOT NULL,at INTEGER NOT NULL,note TEXT NOT NULL)',
  );
  await noteMigration.statements([
    incidentStatement('legacy-valid-parent'),
    noteStatement('legacy-valid', 'legacy-valid-parent'),
    noteStatement('legacy-orphan', 'missing-legacy'),
  ]);
  const legacyBodies = await noteMigration.exec(noteSQL);
  await noteMigration.call('mode', { automatic: true, fault: 'INSERT INTO incident_note_gc_meta' });
  await noteMigration.evict();
  assert.match(
    (await noteMigration.call('state')).initializationFailure,
    /Injected local retention failure/,
  );
  assert.deepEqual(await noteMigration.exec(noteSQL), legacyBodies);
  assert.deepEqual(
    await noteMigration.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('incident_note_gc','incident_note_gc_meta')",
    ),
    [],
  );
  assert.deepEqual(
    await noteMigration.exec(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'incident_note_gc_%'",
    ),
    [],
  );
  await noteMigration.call('mode', { automatic: true });
  await noteMigration.call('schema');
  assert.deepEqual(await noteMigration.exec(noteSQL), legacyBodies);
  assert.deepEqual(
    (await noteMigration.exec(noteQueueSQL)).map((row) => row.note),
    ['legacy-orphan'],
  );
  await noteMigration.call('notes-prune', { cutoff: at - 1 });
  assert.deepEqual(
    await noteMigration.exec(noteSQL),
    legacyBodies.filter((note) => note.id === 'legacy-valid'),
  );
  await noteMigration.evict();
  assert.deepEqual(await noteMigration.exec(noteQueueSQL), []);
  assert.equal((await noteMigration.call('schema')).rowsWritten, 0);
  console.log(
    'PASS note expiry/body/queue rollback and one-time constructor orphan migration preserve valid private notes, retry cleanly and survive eviction',
  );

  for (const [name, marker, message] of [
    ['version-marker-rejection', 'monitor_version_gc_meta', 'version-retention'],
    ['note-marker-rejection', 'incident_note_gc_meta', 'note-retention'],
  ]) {
    const incompatible = fixture(name);
    await incompatible.call('schema');
    await incompatible.exec(`UPDATE ${marker} SET version=99 WHERE id=1`);
    const markerBefore = await incompatible.exec(`SELECT * FROM ${marker}`);
    const failure = await incompatible.call('schema', {}, 500);
    assert.match(failure.error, new RegExp(`Unsupported ${message} schema`));
    assert.deepEqual(await incompatible.exec(`SELECT * FROM ${marker}`), markerBefore);
  }

  // Exercise the real production MonitorStore constructor, current-version
  // reconciliation, and cron cleanup against an upgraded ephemeral store.
  const monitors = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  const monitor = monitors.get(monitors.idFromName('operations'));
  const monitorCall = async (path, body, operator = false, expected = 200) => {
    const response = await monitor.fetch(`https://monitor.internal/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: operator ? { 'X-Operator-Authorized': 'true' } : {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify({ path, result }));
    return result;
  };
  const clockResponse = await monitor.fetch('https://monitor.internal/test-clock', {
    method: 'POST',
    body: JSON.stringify({ now: at }),
  });
  assert.equal(clockResponse.status, 200);
  await clockResponse.text();
  await monitorCall('status');
  const persisted = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  const current = (await persisted.exec('SELECT * FROM services WHERE id=?', 'catalog'))[0];
  const oldIncident = randomUUID();
  const finishedSlot = Math.floor(at / 60000) - 1;
  await persisted.exec(
    'INSERT INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    2,
    at - 600000,
    'Frozen old version',
    'origin',
    'ok-json',
    current.policy,
    'recorded',
  );
  await persisted.exec(
    'INSERT INTO service_versions VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    3,
    at - 600000,
    'Unused imported version',
    'origin',
    'ok-json',
    current.policy,
    'recorded',
  );
  await persisted.exec(
    'INSERT INTO checks VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    finishedSlot,
    at - 1000,
    'http-error',
    503,
    25,
    2,
    null,
  );
  await persisted.exec(
    'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    oldIncident,
    'catalog',
    at - 31 * 86400000,
    null,
    at - 100000,
    'Private old acknowledgement',
  );
  await persisted.exec(
    'INSERT INTO incident_notes VALUES(?,?,?,?)',
    'retained-private-note',
    oldIncident,
    at,
    'Retained private body',
  );
  await persisted.exec(
    'INSERT INTO incident_notes VALUES(?,?,?,?)',
    'legacy-private-orphan',
    'missing-parent',
    at,
    'Legacy orphan body',
  );
  const sourceAtUpgrade = {
    services: await persisted.exec('SELECT * FROM services ORDER BY id'),
    checks: await persisted.exec('SELECT * FROM checks ORDER BY service,slot'),
    notes: await persisted.exec(noteSQL),
  };
  // Simulate an existing pre-retention store without modifying its source.
  const derivedTriggers = await persisted.exec(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'monitor_version_gc_%' OR name LIKE 'incident_note_gc_%')",
  );
  for (const row of derivedTriggers) await persisted.exec(`DROP TRIGGER ${row.name}`);
  for (const table of [
    'monitor_version_gc',
    'monitor_version_gc_meta',
    'incident_note_gc',
    'incident_note_gc_meta',
  ])
    await persisted.exec(`DROP TABLE ${table}`);
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  await monitorCall('status');
  assert.deepEqual(
    await persisted.exec('SELECT * FROM services ORDER BY id'),
    sourceAtUpgrade.services,
  );
  assert.deepEqual(
    await persisted.exec('SELECT * FROM checks ORDER BY service,slot'),
    sourceAtUpgrade.checks,
  );
  assert.deepEqual(await persisted.exec(noteSQL), sourceAtUpgrade.notes);
  assert.deepEqual(
    (await persisted.exec(queueSQL)).map((row) => row.revision),
    [3],
  );
  assert.deepEqual(
    (await persisted.exec(noteQueueSQL)).map((row) => row.note),
    ['legacy-private-orphan'],
  );
  const afterUpgradeQueues = [await persisted.exec(queueSQL), await persisted.exec(noteQueueSQL)];
  const rollbackClock = await monitor.fetch('https://monitor.internal/test-clock', {
    method: 'POST',
    body: JSON.stringify({ now: at - 3 * 60000 }),
  });
  assert.equal(rollbackClock.status, 200);
  await rollbackClock.text();
  await monitorCall('status');
  assert.deepEqual(
    [await persisted.exec(queueSQL), await persisted.exec(noteQueueSQL)],
    afterUpgradeQueues,
  );
  const restoredClock = await monitor.fetch('https://monitor.internal/test-clock', {
    method: 'POST',
    body: JSON.stringify({ now: at }),
  });
  assert.equal(restoredClock.status, 200);
  await restoredClock.text();
  await monitorCall('status');
  await monitorCall('ready', undefined, false, 503);
  const exported = await mf.dispatchFetch('https://edgelab.example/api/ops/export');
  assert.equal(exported.status, 200);
  await exported.json();
  await monitorCall(`incidents/${oldIncident}`);
  await monitorCall('audit');
  assert.deepEqual(
    [await persisted.exec(queueSQL), await persisted.exec(noteQueueSQL)],
    afterUpgradeQueues,
  );

  const detail = await monitorCall(`incidents/${oldIncident}`);
  const frozen = await migration.call('capture', { detail, now: at });
  assert.equal(frozen.evidence.versions[0].name, 'Frozen old version');
  assert.equal(frozen.evidence.limits.privateNotesIncluded, false);
  assert(!JSON.stringify(frozen).includes('Retained private body'));
  const requestId = randomUUID();
  const record = {
    requestId,
    incident: oldIncident,
    service: 'catalog',
    createdAt: at,
    completedAt: at,
    state: 'insufficient-evidence',
    evidence: frozen.evidence,
    evidenceHash: frozen.evidenceHash,
    evidenceSchemaVersion: 1,
    promptVersion: 1,
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    promptEvidenceIds: [],
    omittedEvidenceCount: 0,
    messageBytes: 0,
    inputBytes: 0,
    generated: null,
    failure: null,
  };
  // Explicit synthetic retained-record fixture, never a native/model result.
  const serialized = JSON.stringify(record);
  await persisted.exec(
    'INSERT INTO incident_briefs VALUES(?,?,?,?,?,?,?,?)',
    requestId,
    oldIncident,
    'catalog',
    at,
    'insufficient-evidence',
    serialized,
    null,
    null,
  );
  await persisted.exec('DELETE FROM checks WHERE service=? AND revision=?', 'catalog', 2);
  assert.equal(
    (await persisted.exec('SELECT revision FROM monitor_version_gc WHERE revision=2')).length,
    1,
  );
  const expiredResolved = randomUUID();
  await persisted.exec(
    'INSERT INTO incidents VALUES(?,?,?,?,?,?)',
    expiredResolved,
    'catalog',
    at - 32 * 86400000,
    at - 31 * 86400000,
    null,
    '',
  );
  for (let batch = 0; batch < 100; batch += 10)
    await persisted.exec(
      `INSERT INTO incident_notes VALUES ${Array.from({ length: 10 }, () => '(?,?,?,?)').join(',')}`,
      ...Array.from({ length: 10 }, (_, index) => [
        `expired-parent-note-${batch + index}`,
        expiredResolved,
        at,
        'Recent note on expired controlled resolved incident',
      ]).flat(),
    );
  const bodiesBeforeFailedCleanup = await persisted.exec(noteSQL);
  const queuesBeforeFailedCleanup = [
    await persisted.exec(queueSQL),
    await persisted.exec(noteQueueSQL),
  ];
  await monitorCall('__fixture/arm', { contains: 'DELETE FROM incident_notes WHERE incident IN' });
  const failedCleanup = await monitorCall('tick', { slot: Math.floor(at / 60000) }, false, 500);
  assert.match(failedCleanup.error, /Injected local MonitorStore cleanup failure/);
  assert.equal(
    (await persisted.exec('SELECT id FROM incidents WHERE id=?', expiredResolved)).length,
    1,
  );
  assert.deepEqual(await persisted.exec(noteSQL), bodiesBeforeFailedCleanup);
  assert.deepEqual(
    [await persisted.exec(queueSQL), await persisted.exec(noteQueueSQL)],
    queuesBeforeFailedCleanup,
  );
  await monitorCall('tick', { slot: Math.floor(at / 60000) });
  assert.equal(
    (await persisted.exec('SELECT id FROM incidents WHERE id=?', expiredResolved)).length,
    0,
  );
  assert.equal(
    (await persisted.exec('SELECT id FROM incident_notes WHERE incident=?', expiredResolved))
      .length,
    0,
  );
  assert.deepEqual(
    (await persisted.exec('SELECT revision FROM service_versions ORDER BY revision')).map(
      (row) => row.revision,
    ),
    [1],
  );
  assert.deepEqual(
    (await persisted.exec(noteSQL)).map((row) => row.id),
    ['retained-private-note'],
  );
  assert.equal(
    (await persisted.exec('SELECT record FROM incident_briefs WHERE request_id=?', requestId))[0]
      .record,
    serialized,
  );
  assert.deepEqual(
    (await monitorCall(`incident-briefs/${requestId}`, undefined, true)).brief,
    record,
  );
  assert.equal(
    (await persisted.exec('SELECT id FROM incidents WHERE id=?', oldIncident)).length,
    1,
  );
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  await monitorCall('status');
  assert.deepEqual(await persisted.exec(queueSQL), []);
  assert.deepEqual(await persisted.exec(noteQueueSQL), []);
  assert.deepEqual(
    (await monitorCall(`incident-briefs/${requestId}`, undefined, true)).brief,
    record,
  );
  console.log(
    'PASS actual MonitorStore constructor/read routes preserve source and queue state; completed cron collects unused versions/orphans while current policies, old open incidents, private notes and exact frozen brief hash/context survive eviction',
  );
  console.log(
    'PASS real completed-cron expiry deletes all 100 fresh notes with their expired resolved parent in one transaction; an injected post-delete failure restores parent, bodies and queues before retry',
  );

  // UPDATE OR REPLACE may implicitly displace a different row through a unique
  // key without issuing that row's DELETE triggers. Both candidates must be
  // detected even when the explicitly updated row keeps its own revision.
  for (const recursive of [0, 1]) {
    const displacedChecks = fixture(`check-update-replace-displacement-${recursive}`);
    await displacedChecks.call('schema');
    await displacedChecks.exec(`PRAGMA recursive_triggers=${recursive}`);
    await displacedChecks.statements([
      serviceStatement('catalog', 1),
      versionStatement('catalog', 1),
      versionStatement('catalog', 2),
      versionStatement('catalog', 3),
      checkStatement('catalog', 1, 2),
      checkStatement('catalog', 2, 3, null),
    ]);
    await displacedChecks.drain();
    const checkSourceBeforeConflict = await displacedChecks.state();
    const checkVersionsBeforeConflict = await displacedChecks.exec(versionsSQL);
    await displacedChecks.call(
      'exec',
      {
        query: 'UPDATE checks SET slot=? WHERE service=? AND slot=?',
        args: [2, 'catalog', 1],
      },
      500,
    );
    assert.deepEqual(await displacedChecks.state(), checkSourceBeforeConflict);
    assert.deepEqual(await displacedChecks.exec(versionsSQL), checkVersionsBeforeConflict);
    assert.deepEqual(await displacedChecks.exec(queueSQL), []);
    await displacedChecks.exec(
      'UPDATE OR REPLACE checks SET slot=? WHERE service=? AND slot=?',
      2,
      'catalog',
      1,
    );
    assert.deepEqual(await displacedChecks.exec('SELECT slot,revision FROM checks ORDER BY slot'), [
      { slot: 2, revision: 2 },
    ]);
    const checkDisplacementQueued = (await displacedChecks.exec(queueSQL)).some(
      (candidate) => candidate.service === 'catalog' && candidate.revision === 3,
    );
    await displacedChecks.drain();
    const checkDisplacementCollected =
      (
        await displacedChecks.exec(
          'SELECT revision FROM service_versions WHERE service=? AND revision=?',
          'catalog',
          3,
        )
      ).length === 0;
    assert.deepEqual(
      await displacedChecks.exec('SELECT revision FROM service_versions ORDER BY revision'),
      [{ revision: 1 }, { revision: 2 }],
    );

    const displacedService = fixture(`service-update-replace-displacement-${recursive}`);
    await displacedService.call('schema');
    await displacedService.exec(`PRAGMA recursive_triggers=${recursive}`);
    await displacedService.statements([
      serviceStatement('catalog', 1),
      serviceStatement('gateway', 2),
      versionStatement('catalog', 1),
      versionStatement('gateway', 2),
    ]);
    await displacedService.drain();
    const serviceSourceBeforeConflict = await displacedService.state();
    const serviceVersionsBeforeConflict = await displacedService.exec(versionsSQL);
    await displacedService.call(
      'exec',
      {
        query: 'UPDATE services SET id=? WHERE id=?',
        args: ['gateway', 'catalog'],
      },
      500,
    );
    assert.deepEqual(await displacedService.state(), serviceSourceBeforeConflict);
    assert.deepEqual(await displacedService.exec(versionsSQL), serviceVersionsBeforeConflict);
    assert.deepEqual(await displacedService.exec(queueSQL), []);
    await displacedService.exec(
      'UPDATE OR REPLACE services SET id=? WHERE id=?',
      'gateway',
      'catalog',
    );
    assert.deepEqual(await displacedService.exec('SELECT id,revision FROM services ORDER BY id'), [
      { id: 'gateway', revision: 1 },
    ]);
    const serviceDisplacementQueued = (await displacedService.exec(queueSQL)).some(
      (candidate) => candidate.service === 'gateway' && candidate.revision === 2,
    );
    await displacedService.drain();
    const serviceDisplacementCollected =
      (
        await displacedService.exec(
          'SELECT revision FROM service_versions WHERE service=? AND revision=?',
          'gateway',
          2,
        )
      ).length === 0;
    const displacement = {
      recursiveTriggers: Boolean(recursive),
      checkDisplacementQueued,
      checkDisplacementCollected,
      serviceDisplacementQueued,
      serviceDisplacementCollected,
    };
    console.log(JSON.stringify({ updateOrReplaceDisplacement: displacement }));
    assert.deepEqual(displacement, {
      recursiveTriggers: Boolean(recursive),
      checkDisplacementQueued: true,
      checkDisplacementCollected: true,
      serviceDisplacementQueued: true,
      serviceDisplacementCollected: true,
    });

    const retainedChecks = fixture(`check-update-replace-retained-${recursive}`);
    await retainedChecks.call('schema');
    await retainedChecks.exec(`PRAGMA recursive_triggers=${recursive}`);
    await retainedChecks.statements([
      serviceStatement('catalog', 1),
      versionStatement('catalog', 1),
      versionStatement('catalog', 2),
      versionStatement('catalog', 3),
      checkStatement('catalog', 1, 2),
      checkStatement('catalog', 2, 3),
      checkStatement('catalog', 3, 3, null, 'maintenance'),
    ]);
    await retainedChecks.drain();
    await retainedChecks.exec(
      'UPDATE OR REPLACE checks SET slot=? WHERE service=? AND slot=?',
      2,
      'catalog',
      1,
    );
    assert.deepEqual(await retainedChecks.exec(queueSQL), []);
    await retainedChecks.drain();
    assert.equal(
      (await retainedChecks.exec('SELECT revision FROM service_versions WHERE revision=3')).length,
      1,
    );
    await retainedChecks.exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', 3);
    await retainedChecks.drain();
    assert.deepEqual(
      await retainedChecks.exec('SELECT revision FROM service_versions ORDER BY revision'),
      [{ revision: 1 }, { revision: 2 }],
    );

    const retainedService = fixture(`service-update-replace-retained-${recursive}`);
    await retainedService.call('schema');
    await retainedService.exec(`PRAGMA recursive_triggers=${recursive}`);
    await retainedService.statements([
      serviceStatement('catalog', 1),
      serviceStatement('gateway', 2),
      versionStatement('catalog', 1),
      versionStatement('gateway', 2),
      checkStatement('gateway', 1, 2, null, 'maintenance'),
    ]);
    await retainedService.drain();
    await retainedService.exec(
      'UPDATE OR REPLACE services SET id=? WHERE id=?',
      'gateway',
      'catalog',
    );
    assert(
      !(await retainedService.exec(queueSQL)).some(
        (candidate) => candidate.service === 'gateway' && candidate.revision === 2,
      ),
    );
    await retainedService.drain();
    assert.equal(
      (
        await retainedService.exec(
          'SELECT revision FROM service_versions WHERE service=? AND revision=?',
          'gateway',
          2,
        )
      ).length,
      1,
    );
    await retainedService.exec('DELETE FROM checks WHERE service=?', 'gateway');
    await retainedService.drain();
    assert.deepEqual(await retainedService.exec(versionsSQL), []);
  }
  console.log(
    'PASS occupied-slot/service-ID UPDATE OR REPLACE collects displaced last references with recursive triggers off/on, preserves moved-source and other retained revisions, and failed conflicts roll back source/queue writes',
  );

  console.log(
    'PASS bounded retention helper contracts in actual local workerd/SQLite; no production or native AI calls',
  );
} finally {
  await mf.dispose();
}
