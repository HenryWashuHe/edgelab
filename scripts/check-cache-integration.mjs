import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

await build({
  entryPoints: ['tests/fixtures/check-cache.ts'],
  outfile: 'output/check-cache-worker/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'cache',
        modules: true,
        scriptPath: 'output/check-cache-worker/index.js',
        compatibilityDate: '2026-09-01',
        durableObjects: { CACHE: { className: 'CheckCacheFixture', useSQLite: true } },
      },
    ],
  }),
);
try {
  const namespace = await mf.getDurableObjectNamespace('CACHE', 'cache');
  const stub = namespace.get(namespace.idFromName('row-cost'));
  const call = async (action, body = {}) => {
    const response = await stub.fetch(`https://cache-fixture.internal/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const exec = (query, ...args) => call('exec', { query, args });
  const read = (service, end, nested = false) => call('read', { service, end, nested });
  const equivalent = async (service, end, nested = false) => {
    const cached = await read(service, end, nested);
    const source = await call('source', { service, end });
    assert.deepEqual(cached.checks, source.checks);
    assert(cached.checks.length <= 10080);
    return cached;
  };
  const end = 30_000_000;
  for (const service of ['catalog', 'gateway']) await call('seed', { service, end, count: 12000 });
  const originalCost = {};
  for (const minutes of [1440, 10080]) {
    const start = end - minutes + 1;
    const stats = await exec(
      "SELECT COUNT(*) total,COALESCE(SUM(outcome!='maintenance' AND observed_at IS NOT NULL),0) observed,COALESCE(SUM(outcome='good' AND observed_at IS NOT NULL),0) good,COALESCE(SUM(outcome='maintenance' AND observed_at IS NOT NULL),0) maintenance,COALESCE(SUM(observed_at IS NULL),0) unverified FROM checks WHERE service=? AND slot BETWEEN ? AND ?",
      'catalog',
      start,
      end,
    );
    const p95 = await exec(
      "SELECT latency FROM checks WHERE service=? AND slot BETWEEN ? AND ? AND outcome!='maintenance' AND observed_at IS NOT NULL ORDER BY latency LIMIT 1 OFFSET ?",
      'catalog',
      start,
      end,
      Math.ceil(minutes * 0.95) - 1,
    );
    const hourly = await exec(
      "SELECT CAST(slot/60 AS INTEGER)*3600000 AS at,COUNT(*) AS total,SUM(outcome='good' AND observed_at IS NOT NULL) AS good,SUM(outcome='maintenance' AND observed_at IS NOT NULL) AS maintenance,SUM(observed_at IS NULL) AS unverified FROM checks WHERE service=? AND slot BETWEEN ? AND ? GROUP BY CAST(slot/60 AS INTEGER) ORDER BY at",
      'catalog',
      start,
      end,
    );
    originalCost[minutes] = {
      stats: stats.rowsRead,
      p95: p95.rowsRead,
      hourly: hourly.rowsRead,
      total: stats.rowsRead + p95.rowsRead + hourly.rowsRead,
    };
  }
  const oldBudget = await exec(
    'SELECT slot,observed_at AS observedAt,revision,outcome FROM checks WHERE service=? AND slot BETWEEN ? AND ? ORDER BY slot',
    'catalog',
    end - 4319,
    end,
  );
  await exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', end - 5);
  await exec('UPDATE checks SET observed_at=NULL WHERE service=? AND slot=?', 'catalog', end - 7);
  const bootstrap = await equivalent('catalog', end, true);
  assert.equal(bootstrap.diagnostics.mode, 'bootstrap');
  const steady = await equivalent('catalog', end);
  assert.equal(steady.diagnostics.mode, 'hit');
  assert.equal(steady.diagnostics.sourceRowsRead, 0);
  assert(steady.diagnostics.rowsRead <= 8);
  assert.equal(steady.diagnostics.rowsWritten, 0);
  // Callers may mutate their returned objects without altering persisted evidence.
  steady.checks[0].outcome = 'timeout';
  await equivalent('catalog', end);
  await mf.unsafeEvictDurableObject('cache', 'CheckCacheFixture', { name: 'row-cost' });
  const evicted = await equivalent('catalog', end, true);
  assert.equal(evicted.diagnostics.mode, 'hit');
  assert.equal(evicted.diagnostics.sourceRowsRead, 0);
  assert(evicted.diagnostics.rowsRead <= 8);
  await call('seed', { service: 'catalog', end: end + 1, count: 1 });
  const appended = await equivalent('catalog', end + 1);
  assert.equal(appended.diagnostics.mode, 'append');
  assert(appended.diagnostics.sourceRowsRead <= 4);
  assert(appended.diagnostics.rowsRead <= 16);
  console.log(
    'PASS persisted seven-day cache, nested transactions, same-slot reads, one-slot advancement and actual eviction remain bounded',
  );

  // A missing covered minute receives a late completed check, not a new slot.
  await call('seed', { service: 'catalog', end: end - 5, count: 1 });
  const late = await equivalent('catalog', end + 1);
  assert.equal(late.diagnostics.mode, 'repair');
  assert.equal(late.diagnostics.dirtySlots, 1);
  assert(late.diagnostics.sourceRowsRead <= 4);
  await exec(
    'UPDATE checks SET outcome=?,status=?,latency=?,revision=?,observed_at=NULL WHERE service=? AND slot=?',
    'invalid-body',
    200,
    2500,
    5,
    'catalog',
    end - 8,
  );
  const updated = await equivalent('catalog', end + 1);
  assert.equal(updated.diagnostics.dirtySlots, 1);
  assert(updated.diagnostics.sourceRowsRead <= 4);
  await exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', end - 9);
  const deleted = await equivalent('catalog', end + 1);
  assert.equal(deleted.diagnostics.dirtySlots, 1);
  assert(!deleted.checks.some((check) => check.slot === end - 9));
  await equivalent('gateway', end + 1);
  await exec('DELETE FROM checks WHERE service=? AND slot=?', 'gateway', end - 10);
  await exec(
    'UPDATE checks SET service=? WHERE service=? AND slot=?',
    'gateway',
    'catalog',
    end - 10,
  );
  await equivalent('catalog', end + 1);
  await equivalent('gateway', end + 1);
  await exec('UPDATE checks SET slot=? WHERE service=? AND slot=?', end + 4, 'catalog', end - 11);
  await equivalent('catalog', end + 1);
  await equivalent('catalog', end + 4);
  console.log(
    'PASS authoritative late insert, legacy/corrected outcome, deletion, moved slot and OLD/NEW service repair',
  );

  await exec('DELETE FROM checks WHERE service=? AND slot<?', 'catalog', end - 11000);
  const outside = await equivalent('catalog', end + 4);
  assert.equal(outside.diagnostics.mode, 'hit');
  assert.equal(outside.diagnostics.sourceRowsRead, 0);
  await exec(
    'DELETE FROM checks WHERE service=? AND slot BETWEEN ? AND ?',
    'catalog',
    end - 30,
    end - 20,
  );
  const retained = await equivalent('catalog', end + 4);
  assert.equal(retained.diagnostics.mode, 'repair');
  assert.equal(retained.diagnostics.dirtySlots, 11);
  const rollback = await equivalent('catalog', end - 100);
  assert.equal(rollback.diagnostics.mode, 'rebuild');
  await equivalent('catalog', end + 4);
  await exec('UPDATE monitor_check_cache SET checks=? WHERE service=?', 'not-json', 'catalog');
  assert.equal((await equivalent('catalog', end + 4)).diagnostics.mode, 'rebuild');
  await exec('UPDATE monitor_check_cache SET version=99 WHERE service=?', 'catalog');
  assert.equal((await equivalent('catalog', end + 4)).diagnostics.mode, 'rebuild');
  await equivalent('empty', end);
  await call('seed', { service: 'empty', end: end - 40, count: 1 });
  const filledGap = await equivalent('empty', end);
  assert.equal(filledGap.diagnostics.mode, 'repair');
  assert.equal(filledGap.checks.length, 1);
  await equivalent('empty', -1);
  console.log(
    'PASS source pruning inside/outside coverage, rollback, damaged/version-mismatched projections and empty covered gaps',
  );

  const beforeMigration = (await exec('SELECT COUNT(*) AS count FROM checks')).rows[0].count;
  await exec('ALTER TABLE checks DROP COLUMN observed_at');
  await exec('ALTER TABLE checks ADD COLUMN observed_at INTEGER');
  await call('invalidate');
  const legacy = await equivalent('catalog', end + 4);
  assert(legacy.checks.every((check) => check.observedAt === null));
  assert.equal((await exec('SELECT COUNT(*) AS count FROM checks')).rows[0].count, beforeMigration);
  await equivalent('gateway', end + 4);
  await call('prune', { activeIds: ['catalog'] });
  assert.deepEqual((await exec('SELECT service FROM monitor_check_cache ORDER BY service')).rows, [
    { service: 'catalog' },
  ]);
  assert.equal((await exec('SELECT COUNT(*) AS count FROM checks')).rows[0].count, beforeMigration);
  assert((await equivalent('catalog', end + 4)).diagnostics.rowsRead <= 8);
  console.log(
    'PASS schema-migration invalidation and removed-service cache cleanup preserve all source observations',
  );

  const incidentBase = 1_700_000_000_000;
  for (const service of ['catalog', 'gateway', 'removed'])
    await exec(
      "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<5999) INSERT INTO incidents SELECT printf('%s-closed-%05d',?,n),?,?+n*60000,?+n*60000+1000,NULL,'PRIVATE_INCIDENT_FIXTURE' FROM seq",
      service,
      service,
      incidentBase + (service === 'removed' ? 999999999 : 0),
      incidentBase,
    );
  for (const [service, count] of [
    ['catalog', 150],
    ['gateway', 70],
  ])
    await exec(
      "WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<?) INSERT INTO incidents SELECT printf('%s-open-%05d',?,n),?,?+n,NULL,NULL,'PRIVATE_INCIDENT_FIXTURE' FROM seq",
      count - 1,
      service,
      service,
      incidentBase - 999999999,
    );
  // Measure the actual pre-fix schema too, not just the old SQL on new indexes.
  await exec('DROP INDEX incidents_open_by_service');
  await exec('DROP INDEX incidents_resolved_by_service');
  const oldOpen = await exec(
    'SELECT id,service,opened,resolved,acknowledged FROM incidents WHERE service IN (?,?) AND resolved IS NULL ORDER BY opened DESC,id DESC',
    'catalog',
    'gateway',
  );
  const oldResolved = await exec(
    'SELECT id,service,opened,resolved,acknowledged FROM incidents WHERE service IN (?,?) AND resolved IS NOT NULL ORDER BY opened DESC,id DESC LIMIT 100',
    'catalog',
    'gateway',
  );
  await call('incident-schema');
  const boundedIncidents = await call('incidents', {
    activeIds: ['gateway', 'catalog', 'catalog'],
  });
  assert.deepEqual(boundedIncidents.incidents, [...oldOpen.rows, ...oldResolved.rows]);
  assert.equal(
    boundedIncidents.incidents.filter((incident) => incident.resolved === null).length,
    220,
  );
  assert.equal(
    boundedIncidents.incidents.filter((incident) => incident.resolved !== null).length,
    100,
  );
  assert(!JSON.stringify(boundedIncidents.incidents).includes('PRIVATE_INCIDENT_FIXTURE'));
  assert(!boundedIncidents.incidents.some((incident) => incident.service === 'removed'));
  assert(boundedIncidents.rowsRead <= 2 * (220 + 2 * 100) + 20);
  assert(boundedIncidents.rowsRead < oldOpen.rowsRead + oldResolved.rowsRead);
  assert.deepEqual((await call('incidents', { activeIds: [] })).incidents, []);
  await mf.unsafeEvictDurableObject('cache', 'CheckCacheFixture', { name: 'row-cost' });
  assert.deepEqual(
    (await call('incidents', { activeIds: ['catalog', 'gateway'] })).incidents,
    boundedIncidents.incidents,
  );
  console.log(
    'PASS partial-index incident list matches global SQL ordering, all220activeopen and latest100resolved without private-note leakage',
  );

  const evidence = {
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      runtime: 'local workerd via Miniflare',
      miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
      workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
      accountCalls: 0,
      nativeInferenceCalls: 0,
    },
    fixture: 'local-workerd-two-services-12000-checks-each',
    method:
      'Actual consumed SqlStorageCursor.rowsRead; local controlled data, no account quota or production inference',
    assumptions: {
      sourceChecksPerService: 12000,
      sourceServices: 2,
      cacheCapacityFinishedSlotsPerService: 10080,
      baselineService: 'catalog',
      baselineSourceIndex: 'PRIMARY KEY(service,slot)',
      baselineOutcomes:
        'all good, status200, latency20ms, revision1, actual start slot+1000ms and completion slot+1020ms',
      baselineReports:
        'Three independent range scans: counts/sums, latency sort with nearest-rank95% offset, and hourly grouping',
      baselineBudget: 'One ordered source scan across4320finishedslots',
      bootstrapChanges:
        'One deleted covered slot and one legacy null observation start before first cache load',
      scope:
        'Helper and list cursor costs only; excludes constructorDDL, probe writes, cleanup, policies, readiness and other account usage',
    },
    originalSnapshotRowsReadPerService: originalCost,
    originalBudgetRowsReadPerService: oldBudget.rowsRead,
    bootstrap: bootstrap.diagnostics,
    repeated: steady.diagnostics,
    afterEviction: evicted.diagnostics,
    nextFinishedMinute: appended.diagnostics,
    lateCompletion: late.diagnostics,
    incidents: {
      resolvedRowsPerService: 6000,
      activeServices: 2,
      inactiveServices: 1,
      activeOpenRows: 220,
      originalListRowsRead: oldOpen.rowsRead + oldResolved.rowsRead,
      boundedListRowsRead: boundedIncidents.rowsRead,
      returnedRows: boundedIncidents.incidents.length,
      baselineSchema:
        'Original incident primary-key only; new derived partial indexes temporarily dropped inside this isolated fixture, then restored via ensureSchema',
    },
  };
  await writeFile('output/check-cache-measurements.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  await mf.dispose();
}
