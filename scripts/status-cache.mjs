import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

// Real production gateway/MonitorStore, real ephemeral SQLite, controlled origins.
// Only fixture clocks, inspection and fault controls are added; no remote binding.
const MINUTE = 60000;
const TOKEN = 'status-cache-fixture-token-not-a-production-credential';
const PRIVATE = 'fixture-private-status-canary';
const root = 'output/status-cache';
const bundle = `${root}/worker.js`;
await mkdir(root, { recursive: true });
await build({
  entryPoints: ['tests/fixtures/status-cache.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceProjectVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const sourcePaths = [
  'package.json',
  'worker/monitor.ts',
  'worker/status-view-cache.ts',
  'worker/budget-signals.ts',
  'worker/index.ts',
  'tests/fixtures/status-cache.ts',
  'scripts/status-cache.mjs',
];
const sourceSHA256 = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(path))])),
);
const report = {
  schemaVersion: 1,
  kind: 'edgelab-local-status-cache-manifest',
  sourceProjectVersion,
  command: 'npm run test:status-cache',
  measuredAt: new Date().toISOString(),
  recipe: 'node scripts/status-cache.mjs',
  protocol: {
    route: '/api/ops/status',
    representation: 'Public JSON, including valid-bearer reads',
    canonicalWindows: ['24h', '7d'],
    readSources: ['storage', 'memory'],
    maxAgeMs: 10000,
    ageComparison: '0 <= ageMs < maxAgeMs; hits never renew materializedAt',
    sameUTCMinute: true,
    maxEntries: 2,
    maxCombinedSerializedBytes: 1048576,
    byteAccounting: 'UTF-8 snapshot plus private budget-age envelope; not JavaScript heap size',
    authoritativeRoutes: ['export', 'ready', 'audit', 'incident detail', 'brief history/detail'],
    observedGatewayVersions: [],
    observedStatusVersions: [],
  },
  environment: {
    node: process.version,
    miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
    workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
    compatibilityDate: '2026-09-01',
    productionRequests: 0,
    accountCalls: 0,
    nativeInferenceCalls: 0,
    remoteRequestCfRefresh: false,
    telemetry: false,
  },
  sourceSHA256,
  bundleSHA256: sha(await readFile(bundle)),
  assertions: [],
  fixtures: [],
  nativeFailures: [],
  costs: [],
  limitations: [
    'Controlled local mature two/five-target fixtures, not production account traffic, CPU, billing or capacity evidence.',
    'SQL statements/rows are fully consumed actual SQLite cursor counts, including trigger work. KV/alarm methods are counted separately and not converted into billed rows.',
    'The test-only clock stays in memory during every measured call; clock and source controls are outside measured intervals. Eviction resets memory and clock is set before the next measured call.',
    'Hits require the actual production warm cache. No SQL is skipped and no storage cursor or transaction is simulated.',
    'Post-execution JS faults and native missing-table SQLite faults are distinguished. Failed native attempts have separate attempt/error counts because they produce no cursor; their unknown row costs are not reported as measured zero.',
    'Controlled historical checks exercise missing, legacy, maintenance and failure evidence. They are not fabricated production incidents or operating history.',
  ],
};
const passed = (label) => {
  report.assertions.push(label);
  console.log(JSON.stringify({ passed: label }));
};
const blankOperations = {
  kvGet: 0,
  kvPut: 0,
  kvDelete: 0,
  kvList: 0,
  storageGet: 0,
  storagePut: 0,
  storageDelete: 0,
  storageList: 0,
  storageDeleteAll: 0,
  alarmGet: 0,
  alarmSet: 0,
  alarmDelete: 0,
};
const zeroCost = (cost, label) => {
  assert.equal(cost.statements, 0, `${label}: SQL statements`);
  assert.equal(cost.rowsRead, 0, `${label}: SQL rows read`);
  assert.equal(cost.rowsWritten, 0, `${label}: SQL rows written`);
  assert.equal(cost.attemptedStatements, 0, `${label}: native SQL attempts`);
  assert.equal(cost.failedStatements, 0, `${label}: failed native SQL attempts`);
  assert.equal(cost.nativeFaultsFired, 0, `${label}: native fault injections`);
  assert.deepEqual(cost.operations, blankOperations, `${label}: KV/alarms`);
};
const publicSafe = (data) => {
  const text = JSON.stringify(data);
  assert(!text.includes(PRIVATE), 'Private source canary exposed');
  assert(!text.includes(TOKEN), 'Operator credential exposed');
  assert(!text.includes('https://origin.internal/'), 'Private target URL exposed');
  for (const field of ['orphanNotes', 'requestId', 'target', 'note'])
    assert(!text.includes(`"${field}":`), `Private field exposed: ${field}`);
};
function substantive(value) {
  const copy = structuredClone(value);
  for (const key of ['schemaVersion', 'exportedAt', 'measurement', 'read']) delete copy[key];
  return copy;
}
function expectedChecks(end, minutes) {
  const rows = [];
  for (let slot = end - minutes + 1; slot <= end; slot++) {
    const old = end - slot >= 60;
    if (old && slot % 31 === 0) continue;
    const legacy = old && slot % 97 === 0;
    const outcome =
      old && slot % 53 === 0 ? 'maintenance' : old && slot % 89 === 0 ? 'slow' : 'good';
    rows.push({
      slot,
      outcome,
      latency: 20 + (slot % 19),
      observedAt: legacy ? null : slot * MINUTE + 1000,
    });
  }
  return rows;
}
function expectedMetrics(end, minutes) {
  const rows = expectedChecks(end, minutes);
  const observed = rows.filter((row) => row.observedAt !== null && row.outcome !== 'maintenance');
  const maintenance = rows.filter(
    (row) => row.observedAt !== null && row.outcome === 'maintenance',
  ).length;
  const good = observed.filter((row) => row.outcome === 'good').length;
  const latencies = observed.map((row) => row.latency).sort((a, b) => a - b);
  const allowedBad = observed.length * (1 - 99.9 / 100);
  return {
    total: rows.length,
    observed: observed.length,
    good,
    maintenance,
    unverified: rows.filter((row) => row.observedAt === null).length,
    expected: minutes,
    missing: minutes - rows.length,
    coverage: (100 * observed.length) / (minutes - maintenance),
    goodRatio: (100 * good) / observed.length,
    p95Ms: latencies[Math.ceil(observed.length * 0.95) - 1],
    budgetConsumed: (100 * (observed.length - good)) / allowedBad,
    windowStart: (end - minutes + 1) * MINUTE,
    windowEnd: (end + 1) * MINUTE,
  };
}

async function runtime(targetCount) {
  let mode = 'good';
  let entered = 0;
  const held = [];
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    id: `service-${index}`,
    name: `Service ${index}`,
    url: `https://origin.internal/service-${index}`,
    transport: 'origin',
    assertion: 'ok-json',
  }));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: bundle,
          compatibilityDate: '2026-09-01',
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: {
            MONITOR_TARGETS: JSON.stringify(targets),
            OPERATOR_TOKEN: TOKEN,
            AI_BRIEFS_ENABLED: 'false',
          },
          serviceBindings: {
            ORIGIN: async () => {
              entered++;
              if (mode === 'hold') return new Promise((resolve) => held.push(resolve));
              return mode === 'bad'
                ? Response.json({ ok: false }, { status: 503 })
                : Response.json({ ok: true });
            },
          },
        },
      ],
    }),
  );
  const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  const stub = ns.get(ns.idFromName('operations'));
  const control = async (path, data = {}) => {
    const response = await stub.fetch(`https://monitor.internal/__fixture/${path}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    assert.equal(response.status, 200, `Fixture ${path}`);
    return response.json();
  };
  const clock = (now) => control('clock', { now });
  const sql = (query, args = []) => control('sql', { statements: [{ query, args }] });
  const query = async (statement, args = []) => (await sql(statement, args)).results[0];
  const request = async (path, options = {}) => {
    const response = await mf.dispatchFetch(`https://edgelab.example${path}`, options);
    const data = await response.json();
    return { response, data };
  };
  const status = (window = '24h', suffix = '') =>
    request(`/api/ops/status?window=${window}${suffix}`);
  const measure = async (operation, action) => {
    await control('reset-cost');
    const result = await action();
    const { bootId, ...cost } = await control('cost');
    report.costs.push({ targetCount, operation, ...cost });
    return { ...cost, result, bootId };
  };
  const tick = async (now) => {
    await clock(now);
    const response = await stub.fetch('https://monitor.internal/tick', {
      method: 'POST',
      body: JSON.stringify({ slot: Math.floor(now / MINUTE) }),
    });
    return { response, data: await response.json() };
  };
  const write = (path, body) =>
    request(`/api/ops/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const waitEntered = async (count) => {
    const deadline = Date.now() + 2000;
    while (entered < count && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 5));
    assert.equal(entered, count, 'Origin work entered');
  };
  return {
    mf,
    stub,
    targets,
    clock,
    control,
    sql,
    query,
    request,
    status,
    measure,
    tick,
    write,
    setMode: (value) => {
      mode = value;
    },
    enterCount: () => entered,
    waitEntered,
    release: () => {
      for (const done of held.splice(0)) done(Response.json({ ok: true }));
    },
    dispose: async () => {
      for (const done of held.splice(0)) done(Response.json({ ok: true }));
      await mf.dispose();
    },
  };
}

for (const targetCount of [2, 5]) {
  const run = await runtime(targetCount);
  try {
    const { clock, control, sql, query, request, status, measure, tick, write } = run;
    const health = await request('/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(
      health.data.version,
      sourceProjectVersion,
      'Actual gateway/package version agreement',
    );
    report.protocol.observedGatewayVersions.push({ targetCount, version: health.data.version });
    const now = Math.floor(Date.now() / MINUTE) * MINUTE + 1000;
    const end = Math.floor(now / MINUTE) - 1;
    const constructor = await control('cost');
    report.costs.push({ targetCount, operation: 'cold-constructor', ...constructor });
    assert(constructor.statements > 0, 'Constructor measured independently');
    await clock(now);
    const enrollment = await measure('initial-enrollment-status', () => status());
    assert.equal(enrollment.result.response.status, 200);
    assert.equal(
      enrollment.result.data.version,
      sourceProjectVersion,
      'Actual status/package version agreement',
    );
    assert.equal(enrollment.result.data.read.maxAgeMs, report.protocol.maxAgeMs);
    report.protocol.observedStatusVersions.push({
      targetCount,
      version: enrollment.result.data.version,
    });
    assert(enrollment.statements > 0);
    for (const target of run.targets) {
      await sql('UPDATE services SET created=? WHERE id=?', [(end - 10079) * MINUTE, target.id]);
      await sql('UPDATE service_versions SET recorded_at=? WHERE service=?', [
        (end - 10079) * MINUTE,
        target.id,
      ]);
      // One native SQLite statement creates a real seven-day source timeline.
      // Mature last hour is complete; earlier rows include deliberate gaps,
      // unknown timing, maintenance and failures for independent metric checks.
      await sql(
        `WITH RECURSIVE slots(slot) AS (SELECT ? UNION ALL SELECT slot+1 FROM slots WHERE slot<?)
         INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at)
         SELECT ?,slot,slot*60000+1040,
           CASE WHEN ?-slot>=60 AND slot%53=0 THEN 'maintenance' WHEN ?-slot>=60 AND slot%89=0 THEN 'slow' ELSE 'good' END,
           200,20+slot%19,1,CASE WHEN ?-slot>=60 AND slot%97=0 THEN NULL ELSE slot*60000+1000 END
         FROM slots WHERE ?-slot<60 OR slot%31!=0`,
        [end - 10079, end, target.id, end, end, end, end],
      );
    }
    // A mature dashboard also has the full20 scheduler footer entries. These
    // are controlled retained rows, not invented production scheduler history.
    await sql(
      `WITH RECURSIVE slots(slot) AS (SELECT ? UNION ALL SELECT slot+1 FROM slots WHERE slot<?)
       INSERT INTO scheduler_events(at,slot,status,detail)
       SELECT slot*60000+1000,slot,'started','{}' FROM slots
       UNION ALL SELECT slot*60000+1040,slot,'completed','{}' FROM slots`,
      [end - 9, end],
    );
    // Remove only derived fixture projection buffers/repair queues. This makes
    // bootstrap cost explicit instead of measuring thousands of artificial
    // repairs caused by inserting history after the empty enrollment read.
    await control('sql', {
      statements: [
        { query: 'DELETE FROM monitor_check_dirty' },
        { query: 'DELETE FROM monitor_check_cache' },
      ],
    });
    report.fixtures.push({
      targetCount,
      finishedHistorySlotsPerTarget: 10080,
      retainedFinishedChecksPerTarget: expectedChecks(end, 10080).length,
      recentSchedulerEventsBeforeCurrentTick: 20,
      outcomes:
        'Complete last 60 finished minutes; older rows have deterministic gaps, legacy timing, maintenance and slow outcomes.',
      profile:
        'Constructor/enrollment and mature input bootstrap are separate from storage-view misses and memory hits. No incident is present during baseline profiling.',
    });
    // Seeding is outside measurement. A real current-minute tick invalidates
    // earlier public snapshots and computes persisted budget/cleanup evidence.
    const scheduled = await measure('mature-input-bootstrap-cron', () => tick(now));
    assert.equal(scheduled.result.response.status, 200);
    for (const window of ['24h', '7d']) {
      const miss = await measure(`mature-miss-${window}`, () => status(window));
      const data = miss.result.data;
      assert.equal(miss.result.response.status, 200);
      assert(miss.rowsRead > 0);
      assert.equal(data.read.source, 'storage');
      assert.equal(data.read.materializedAt, now);
      assert.equal(data.read.servedAt, now);
      assert.equal(data.read.ageMs, 0);
      assert.equal(data.read.maxAgeMs, 10000);
      publicSafe(data);
      for (const service of data.services) {
        assert.deepEqual(service.metrics, expectedMetrics(end, window === '7d' ? 10080 : 1440));
        assert.equal(service.latest.slot, end + 1);
        assert.equal(service.budget.evaluationStatus, 'current');
        assert.equal(service.budget.evaluation.computedAt, now);
      }
      assert.equal(data.monitoring.status, 'healthy');
      assert(
        data.scheduler.find((event) => event.status === 'completed')?.detail.cleanup?.versions,
      );
      const exportRead = await measure(`authoritative-export-${window}`, () =>
        request(`/api/ops/export?window=${window}`),
      );
      assert.equal(exportRead.result.response.status, 200);
      assert.equal(exportRead.result.data.schemaVersion, 4);
      assert.equal(exportRead.result.data.read.source, 'storage');
      assert(exportRead.rowsRead > 0, 'Export bypasses cache');
      assert.deepEqual(substantive(exportRead.result.data), substantive(data));
      publicSafe(exportRead.result.data);
      const hits = await measure(`100-concurrent-hits-${window}`, () =>
        Promise.all(Array.from({ length: 100 }, (_, index) => status(window, `&ignored=${index}`))),
      );
      zeroCost(hits, `100 concurrent ${window}`);
      for (const hit of hits.result) {
        assert.equal(hit.response.status, 200);
        assert.equal(hit.data.read.source, 'memory');
        assert.equal(hit.data.read.materializedAt, now);
        assert.deepEqual(substantive(hit.data), substantive(data));
      }
      const repeated = await measure(`100-sequential-hits-${window}`, async () => {
        for (let index = 0; index < 100; index++) {
          const hit =
            window === '24h'
              ? await request(`/api/ops/status?window=noncanonical-${index}`)
              : await status(window, `&windowAlias=${index}`);
          assert.equal(hit.data.read.source, 'memory');
        }
      });
      zeroCost(repeated, `100 repeated ${window}`);
    }
    passed(
      `${targetCount} targets: mature source/export parity; two windows and 100 concurrent/sequential hits each use zero SQL/KV/alarm work`,
    );

    const privateStatus = await measure('authenticated-public-status-hit', () =>
      request('/api/ops/status', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    assert.equal(privateStatus.result.data.read.source, 'memory');
    zeroCost(privateStatus, 'Authenticated public status');
    publicSafe(privateStatus.result.data);
    const readiness = await measure('authoritative-readiness', () => request('/api/ready'));
    assert.equal(readiness.result.response.status, 200);
    assert(readiness.rowsRead > 0);
    assert.deepEqual(readiness.result.data.monitoring, privateStatus.result.data.monitoring);
    passed(
      `${targetCount} targets: valid bearer status is the identical public cache; readiness remains authoritative`,
    );

    await clock(now + 9999);
    const beforeTTL = await measure('ttl-9999-hit', () => status());
    zeroCost(beforeTTL, 'TTL9999');
    assert.equal(beforeTTL.result.data.read.ageMs, 9999);
    assert.equal(beforeTTL.result.data.now, now + 9999);
    await clock(now + 10000);
    const atTTL = await measure('ttl-10000-miss', () => status());
    assert(atTTL.rowsRead > 0);
    assert.equal(atTTL.result.data.read.source, 'storage');
    const minuteBoundary = Math.floor(now / MINUTE) * MINUTE + MINUTE;
    await clock(minuteBoundary - 1);
    const beforeMinute = await status();
    assert.equal(beforeMinute.data.read.source, 'storage');
    await clock(minuteBoundary);
    const minuteMiss = await measure('minute-rollover-miss', () => status());
    assert(minuteMiss.rowsRead > 0);
    assert.equal(minuteMiss.result.data.services[0].metrics.windowEnd, (end + 2) * MINUTE);
    assert.equal(minuteMiss.result.data.read.materializedAt, minuteBoundary);
    // A one-millisecond rollback remains within the same minute and after the
    // materialization timestamp. Only last served-clock regression can force
    // this miss; neither TTL expiry nor negative entry age explains it.
    await clock(minuteBoundary + 2000);
    assert.equal((await status()).data.read.source, 'memory');
    await clock(minuteBoundary + 1999);
    const rollback = await measure('backward-clock-miss', () => status());
    assert(rollback.rowsRead > 0);
    assert.equal(rollback.result.data.read.source, 'storage');
    passed(
      `${targetCount} targets: strict 10-second TTL, UTC minute rollover and backward clock rebuild`,
    );

    // Warm exactly at the freshness boundary, then age by one millisecond in
    // the same minute. Stored observation/scheduler/budget times stay unchanged.
    await clock(now + 180000);
    const exact = await status();
    assert.equal(exact.data.monitoring.status, 'healthy');
    assert.equal(exact.data.services[0].status, 'healthy');
    assert.equal(exact.data.services[0].budget.evaluationStatus, 'current');
    await clock(now + 180001);
    const expired = await measure('freshness-180001-hit', () => status());
    zeroCost(expired, 'Freshness180001');
    assert.equal(expired.result.data.read.source, 'memory');
    assert.equal(expired.result.data.read.materializedAt, now + 180000);
    assert.equal(expired.result.data.read.ageMs, 1);
    assert.equal(expired.result.data.monitoring.status, 'stalled');
    for (const [index, service] of expired.result.data.services.entries()) {
      assert.equal(service.status, 'unknown');
      assert.equal(service.budget.evaluationStatus, 'stale');
      assert.equal(service.latest.observedAt, now);
      assert.equal(service.budget.evaluation.computedAt, now);
      assert.deepEqual(service.metrics, exact.data.services[index].metrics);
      assert.deepEqual(service.history, exact.data.services[index].history);
      assert.deepEqual(service.latest, exact.data.services[index].latest);
      assert.deepEqual(service.state, exact.data.services[index].state);
      assert.deepEqual(service.budget.evaluation, exact.data.services[index].budget.evaluation);
      assert.deepEqual(service.budget.lastFiring, exact.data.services[index].budget.lastFiring);
    }
    assert.deepEqual(expired.result.data.scheduler, exact.data.scheduler);
    assert.deepEqual(expired.result.data.incidents, exact.data.incidents);
    assert.equal(expired.result.data.monitoring.lastCompletedAt, now);
    assert.equal(expired.result.data.monitoring.ageMs, 180001);
    const directStale = await request('/api/ready');
    assert.equal(directStale.response.status, 503);
    assert.deepEqual(directStale.data.monitoring, expired.result.data.monitoring);
    passed(
      `${targetCount} targets: memory-hit freshness 180000→180001 ages status/budget/readiness without renewing evidence`,
    );

    await clock(now + 4 * MINUTE);
    const tickNow = now + 4 * MINUTE;
    await tick(tickNow);
    await status();
    const beforePolicy = (
      await query('SELECT revision,policy,state FROM services WHERE id=?', ['service-0'])
    )[0];
    const policy = await write('policy', {
      service: 'service-0',
      revision: 1,
      policy: { latencyObjectiveMs: 1000 },
    });
    assert.equal(policy.response.status, 200);
    const afterPolicy = await measure('policy-invalidates-view', () => status());
    assert(afterPolicy.rowsRead > 0);
    assert.equal(afterPolicy.result.data.services[0].revision, 2);
    assert.equal(afterPolicy.result.data.services[0].budget.evaluationStatus, 'policy-changed');
    assert.equal(afterPolicy.result.data.services[0].status, 'unknown');
    // An old revision response must never restore the previous cached policy.
    const conflict = await write('policy', {
      service: 'service-0',
      revision: 1,
      policy: { paused: true },
    });
    assert.equal(conflict.response.status, 409);
    const afterConflict = await status();
    assert.equal(afterConflict.data.services[0].revision, 2);
    assert.equal(afterConflict.data.services[0].policy.paused, false);

    // A late executed policy SQL fault rolls back its revision, invalidates the
    // warm view, returns sanitized503 and never serves fallback public success.
    await control('arm', { contains: 'INSERT INTO audit' });
    const failedPolicy = await write('policy', {
      service: 'service-0',
      revision: 2,
      policy: { paused: true },
    });
    assert.equal(failedPolicy.response.status, 503);
    assert.equal(failedPolicy.data.code, 'monitor-storage-unavailable');
    publicSafe(failedPolicy.data);
    assert.equal((await control('cost')).faultsFired, 1);
    const recoveredPolicy = await measure('failed-policy-clears-cache', () => status());
    assert(recoveredPolicy.rowsRead > 0);
    const durablePolicy = (
      await query('SELECT revision,policy FROM services WHERE id=?', ['service-0'])
    )[0];
    assert.equal(durablePolicy.revision, 2);
    assert.equal(JSON.parse(durablePolicy.policy).paused, false);
    assert.equal(JSON.parse(beforePolicy.policy).latencyObjectiveMs, 1500);
    passed(
      `${targetCount} targets: successful policy commit/conflict and executed transactional failure preserve revision fences and invalidate warm views`,
    );

    const nativeBefore = (
      await query('SELECT revision,policy,state FROM services WHERE id=?', ['service-0'])
    )[0];
    const queueBeforeNative = await query(
      'SELECT service,revision FROM monitor_version_gc ORDER BY id',
    );
    const nativePolicy = await measure('native-sql-policy-failure', async () => {
      await control('arm', { contains: 'UPDATE services SET policy=', native: true });
      return write('policy', { service: 'service-0', revision: 2, policy: { paused: true } });
    });
    assert.equal(nativePolicy.result.response.status, 503);
    assert.equal(nativePolicy.result.data.code, 'monitor-storage-unavailable');
    publicSafe(nativePolicy.result.data);
    assert(
      !JSON.stringify(nativePolicy.result.data).includes('__fixture_missing_native_sql_table'),
    );
    assert.equal(nativePolicy.nativeFaultsFired, 1, 'Actual native SQLite missing-table exception');
    assert.equal(nativePolicy.failedStatements, 1);
    assert.equal(nativePolicy.attemptedStatements, nativePolicy.statements + 1);
    assert(nativePolicy.rowsWritten > 0, 'Selected UPDATE completed before native failure');
    assert.deepEqual(
      (await query('SELECT revision,policy,state FROM services WHERE id=?', ['service-0']))[0],
      nativeBefore,
    );
    assert.deepEqual(
      await query('SELECT service,revision FROM monitor_version_gc ORDER BY id'),
      queueBeforeNative,
    );
    const nativeRecovery = await measure('native-policy-failure-clears-warm-cache', () => status());
    assert(nativeRecovery.rowsRead > 0);
    assert.equal(nativeRecovery.result.data.services[0].revision, 2);
    assert.equal(nativeRecovery.result.data.services[0].policy.paused, false);
    report.nativeFailures.push({
      targetCount,
      operation: 'policy-write',
      consumedStatements: nativePolicy.statements,
      attemptedStatements: nativePolicy.attemptedStatements,
      failedAttempts: nativePolicy.failedStatements,
      nativeFaultsFired: nativePolicy.nativeFaultsFired,
      consumedCursorRowsRead: nativePolicy.rowsRead,
      consumedCursorRowsWritten: nativePolicy.rowsWritten,
      failedAttemptCursorCost: null,
      selectedWriteExecuted: true,
      sourceAndQueueRolledBack: true,
      sanitized503: true,
      staleFallbackServed: false,
    });
    passed(
      `${targetCount} targets: native SQLite exception after consumed policy UPDATE rolls source/queue back and clears warm public cache`,
    );

    // Actual probe work waits outside its transaction while status warms. Its
    // later completion and final scheduler/cleanup publication invalidate that
    // view, rather than letting it remain current for the full TTL.
    const inFlightAt = tickNow + MINUTE;
    await clock(inFlightAt);
    run.setMode('hold');
    const expectedEntered = run.enterCount() + targetCount;
    const pending = tick(inFlightAt);
    await run.waitEntered(expectedEntered);
    const whilePending = await status();
    assert.equal(whilePending.data.scheduler[0].status, 'started');
    const latestBefore = whilePending.data.services[0].latest.slot;
    run.release();
    assert.equal((await pending).response.status, 200);
    run.setMode('good');
    const afterComplete = await measure('probe-completion-invalidates-warm-view', () => status());
    assert(afterComplete.rowsRead > 0);
    assert(afterComplete.result.data.services[0].latest.slot > latestBefore);
    assert.equal(afterComplete.result.data.services[0].latest.revision, 2);
    assert.equal(afterComplete.result.data.services[0].budget.evaluation.computedAt, inFlightAt);
    assert.equal(afterComplete.result.data.scheduler[0].status, 'completed');
    assert(afterComplete.result.data.scheduler[0].detail.cleanup.versions);
    passed(
      `${targetCount} targets: probe completion/budget/committed cleanup replace an in-flight warmed status`,
    );

    const incident = randomUUID();
    await sql('INSERT INTO incidents(id,service,opened,note) VALUES(?,?,?,?)', [
      incident,
      'service-0',
      inFlightAt,
      PRIVATE,
    ]);
    // External source fixture changes are not production API commits. Force a
    // normal TTL rebuild before testing the real acknowledge mutation path.
    await clock(inFlightAt + 10000);
    const unacknowledged = await status();
    assert.equal(
      unacknowledged.data.incidents.find((item) => item.id === incident).acknowledged,
      null,
    );
    const acknowledgement = await write('acknowledge', { incident, note: PRIVATE });
    assert.equal(acknowledgement.response.status, 200);
    const afterAck = await measure('acknowledgement-invalidates-view', () => status());
    assert(afterAck.rowsRead > 0);
    assert.equal(
      afterAck.result.data.incidents.find((item) => item.id === incident).acknowledged,
      inFlightAt + 10000,
    );
    publicSafe(afterAck.result.data);
    const privateAudit = await measure('authenticated-audit-bypass', () =>
      request('/api/ops/audit', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    assert(privateAudit.rowsRead > 0);
    assert(JSON.stringify(privateAudit.result.data).includes(PRIVATE));
    const privateDetail = await measure('authenticated-incident-detail', () =>
      request(`/api/ops/incidents/${incident}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    assert.equal(privateDetail.result.response.status, 200);
    assert(privateDetail.rowsRead > 0);
    assert(JSON.stringify(privateDetail.result.data).includes(PRIVATE));
    const publicDetail = await measure('public-incident-detail-authoritative', () =>
      request(`/api/ops/incidents/${incident}`),
    );
    assert.equal(publicDetail.result.response.status, 200);
    assert(publicDetail.rowsRead > 0);
    publicSafe(publicDetail.result.data);
    const privateBriefs = await measure('authenticated-brief-history', () =>
      request(`/api/ops/incidents/${incident}/briefs`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    assert.equal(privateBriefs.result.response.status, 200);
    assert(privateBriefs.rowsRead > 0);
    const missingBrief = await measure('authenticated-brief-lookup', () =>
      request(`/api/ops/incident-briefs/${randomUUID()}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    assert.equal(missingBrief.result.response.status, 404);
    assert(missingBrief.rowsRead > 0);
    const publicAfterAudit = await measure('public-hit-after-private-audit', () => status());
    publicSafe(publicAfterAudit.result.data);
    zeroCost(publicAfterAudit, 'Public after private audit');
    passed(
      `${targetCount} targets: acknowledgement refreshes lifecycle; audit/detail/brief reads remain authoritative and private data never enters public cache`,
    );

    const changedTargets = run.targets.map((target, index) =>
      index === 0 ? { ...target, name: 'Renamed service' } : target,
    );
    await control('targets', { raw: JSON.stringify(changedTargets) });
    const targetMiss = await measure('deployment-target-fingerprint-miss', () => status());
    assert(targetMiss.rowsRead > 0);
    assert.equal(targetMiss.result.data.services[0].name, 'Renamed service');
    assert.equal(targetMiss.result.data.services[0].revision, 3);
    assert.equal(targetMiss.result.data.services[0].status, 'unknown');
    passed(`${targetCount} targets: raw deployment target fingerprint fences old public entries`);

    // Read faults after the native SELECT executes clear BOTH public windows.
    await clock(inFlightAt + 19999);
    const protectedOtherWindow = await status('7d');
    assert.equal(protectedOtherWindow.data.read.materializedAt, inFlightAt + 19999);
    await clock(inFlightAt + 20000);
    const failedRead = await measure('native-sql-read-failure', async () => {
      await control('arm', { contains: 'SELECT * FROM services WHERE id=?', native: true });
      return status();
    });
    assert.equal(failedRead.result.response.status, 503);
    assert.equal(failedRead.result.data.code, 'monitor-storage-unavailable');
    publicSafe(failedRead.result.data);
    assert(!JSON.stringify(failedRead.result.data).includes('__fixture_missing_native_sql_table'));
    assert.equal(failedRead.nativeFaultsFired, 1);
    assert.equal(failedRead.failedStatements, 1);
    assert.equal(failedRead.attemptedStatements, failedRead.statements + 1);
    assert(failedRead.rowsRead > 0, 'Selected SELECT consumed before native failure');
    const afterFailure = await measure('failure-clears-other-window', () => status('7d'));
    assert(afterFailure.rowsRead > 0);
    assert.equal(afterFailure.result.data.read.source, 'storage');
    report.nativeFailures.push({
      targetCount,
      operation: 'status-read',
      consumedStatements: failedRead.statements,
      attemptedStatements: failedRead.attemptedStatements,
      failedAttempts: failedRead.failedStatements,
      nativeFaultsFired: failedRead.nativeFaultsFired,
      consumedCursorRowsRead: failedRead.rowsRead,
      consumedCursorRowsWritten: failedRead.rowsWritten,
      failedAttemptCursorCost: null,
      sanitized503: true,
      otherWindowWasOneMillisecondOld: true,
      bothWindowsCleared: true,
      staleFallbackServed: false,
    });
    passed(
      `${targetCount} targets: native SQLite read failure returns 503 with no stale fallback and clears both windows`,
    );

    const previousBoot = (await control('cost')).bootId;
    await run.mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
    await clock(inFlightAt + 20001);
    const coldCost = await control('cost');
    assert.notEqual(coldCost.bootId, previousBoot);
    assert(coldCost.statements > 0, 'Evicted constructor cost captured separately');
    report.costs.push({ targetCount, operation: 'eviction-constructor', ...coldCost });
    const rebuilt = await measure('eviction-public-miss', () => status());
    assert(rebuilt.rowsRead > 0);
    assert.equal(rebuilt.result.data.read.source, 'storage');
    // Constructor eviction resets the DO instance, while its worker's current
    // configured target remains the authority for enrollment reconciliation.
    assert.equal(rebuilt.result.data.services[0].name, changedTargets[0].name);
    assert.equal(
      rebuilt.result.data.services[0].revision,
      targetMiss.result.data.services[0].revision,
    );
    const afterEvictionHit = await measure('eviction-second-read-hit', () => status());
    zeroCost(afterEvictionHit, 'Eviction second read');
    passed(
      `${targetCount} targets: real eviction loses only memory cache and rebuilds from preserved authoritative source`,
    );

    await control('clock', { invalid: 'nan' });
    const invalidNow = await status();
    assert.equal(invalidNow.response.status, 503);
    publicSafe(invalidNow.data);
    await clock(inFlightAt + 20002);
    const afterInvalid = await measure('invalid-time-clears-view', () => status());
    assert(afterInvalid.rowsRead > 0);
    assert.equal(afterInvalid.result.data.read.source, 'storage');
    passed(
      `${targetCount} targets: invalid time cannot return cached success or preserve a stale memory entry`,
    );

    // Individually valid views must also share a combined 1 MiB budget. A large
    // local import makes both envelopes fit separately but exceed it together.
    const largeId = 'bounded-' + 'x'.repeat(600000);
    await sql('INSERT INTO incidents(id,service,opened,resolved,note) VALUES(?,?,?,?,?)', [
      largeId,
      'service-0',
      inFlightAt + 1,
      inFlightAt + 2,
      PRIVATE,
    ]);
    await clock(inFlightAt + 30003);
    const largeDay = await measure('large-single-window24h-admission', () => status());
    const largeWeek = await measure('large-single-window7d-admission', () => status('7d'));
    const dayBytes = Buffer.byteLength(JSON.stringify(largeDay.result.data));
    const weekBytes = Buffer.byteLength(JSON.stringify(largeWeek.result.data));
    assert(dayBytes < 1048576 && weekBytes < 1048576);
    assert(dayBytes + weekBytes > 1048576 + 1024);
    publicSafe(largeDay.result.data);
    publicSafe(largeWeek.result.data);
    const newestWindowHit = await measure('combined-cap-keeps-newest-window', () => status('7d'));
    zeroCost(newestWindowHit, 'Combined cap newest window');
    const evictedWindow = await measure('combined-cap-evicts-older-window', () => status());
    assert(evictedWindow.rowsRead > 0);
    assert.equal(evictedWindow.result.data.read.source, 'storage');
    assert.equal(evictedWindow.result.data.read.materializedAt, inFlightAt + 30003);
    assert.equal(
      evictedWindow.result.data.incidents.find((item) => item.id === largeId).id.length,
      largeId.length,
    );
    passed(
      `${targetCount} targets: two individually valid large views honor the combined 1 MiB cap by evicting the older window`,
    );

    // Oversize public source remains an authoritative uncached response. This
    // pathological local import must not erase or truncate legitimate history.
    const hugeId = 'oversize-' + 'x'.repeat(1048576);
    await sql('UPDATE incidents SET id=? WHERE id=?', [hugeId, largeId]);
    await clock(inFlightAt + 40003);
    const oversize = await measure('oversize-first-storage-read', () => status());
    assert.equal(oversize.result.response.status, 200);
    assert.equal(oversize.result.data.read.source, 'storage');
    assert(Buffer.byteLength(JSON.stringify(oversize.result.data)) > 1048576);
    publicSafe(oversize.result.data);
    const oversizeAgain = await measure('oversize-not-admitted-to-memory', () => status());
    assert(oversizeAgain.rowsRead > 0);
    assert.equal(oversizeAgain.result.data.read.source, 'storage');
    assert.equal(
      oversizeAgain.result.data.incidents.find((item) => item.id === hugeId).id.length,
      hugeId.length,
    );
    passed(
      `${targetCount} targets: >1 MiB view bypasses cache without dropping authoritative public source`,
    );
  } finally {
    await run.dispose();
  }
}

const finalSHA = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, sha(await readFile(path))])),
);
assert.deepEqual(finalSHA, sourceSHA256, 'Measured sources changed during runtime suite');
report.sourceStableDuringRun = true;
await writeFile(`${root}/results.json`, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    result: 'passed',
    assertions: report.assertions.length,
    report: `${root}/results.json`,
  }),
);
