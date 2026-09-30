import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const token = 'budget-test-operator-token-not-a-production-credential';
const target = {
  id: 'catalog',
  name: 'Catalog',
  url: 'https://origin.internal/health',
  transport: 'origin',
  assertion: 'ok-json',
};
await build({
  entryPoints: ['tests/fixtures/monitor-clock.ts'],
  outfile: 'output/budget-clock-worker/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
let calls = 0;
const runtimeOptions = (configuredTarget = target) =>
  convertV4MiniflareOptions({
    unsafeInspectDurableObjects: true,
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: 'output/budget-clock-worker/index.js',
        compatibilityDate: '2026-09-01',
        durableObjects: {
          LABS: { className: 'ReliabilityLab', useSQLite: true },
          MONITORS: { className: 'MonitorStore', useSQLite: true },
        },
        bindings: { MONITOR_TARGETS: JSON.stringify([configuredTarget]), OPERATOR_TOKEN: token },
        serviceBindings: {
          ORIGIN: async () => {
            calls++;
            return Response.json({
              ok: true,
              service: 'demo-catalog',
              revision: 'fixture',
              generatedAt: Date.now(),
              products: [
                { sku: 'fixture-one', available: 1 },
                { sku: 'fixture-two', available: 2 },
              ],
            });
          },
        },
      },
    ],
  });
const mf = new Miniflare(runtimeOptions());

try {
  const ns = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  let stub = ns.get(ns.idFromName('operations'));
  const setClock = async (now) => {
    const response = await stub.fetch('https://monitor.internal/test-clock', {
      method: 'POST',
      body: JSON.stringify({ now }),
    });
    assert.equal(response.status, 200);
  };
  const tick = async (now) => {
    await setClock(now);
    const response = await stub.fetch('https://monitor.internal/tick', {
      method: 'POST',
      body: JSON.stringify({ slot: Math.floor(now / MINUTE) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const read = async () => {
    const response = await mf.dispatchFetch('https://edgelab.example/api/ops/status');
    assert.equal(response.status, 200);
    return response.json();
  };
  const budget = async () => (await read()).services[0].budget;
  const policy = async (revision, patch) => {
    const response = await mf.dispatchFetch('https://edgelab.example/api/ops/policy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'catalog', revision, policy: patch }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const now = Math.floor(Date.now() / MINUTE) * MINUTE + 1000;
  await setClock(now);
  const initial = await budget();
  assert.equal(initial.evaluationStatus, 'not-evaluated');
  assert.equal(initial.evaluation, null);
  assert.equal(initial.lastFiring, null);
  let storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  const currentSlot = Math.floor(now / MINUTE);
  const end = currentSlot - 1;
  const start = end - 4320 + 1;
  await storage.exec('UPDATE services SET created=? WHERE id=?', start * MINUTE, 'catalog');
  await storage.exec(
    'UPDATE service_versions SET recorded_at=? WHERE service=? AND revision=?',
    start * MINUTE,
    'catalog',
    1,
  );
  // Full, correctly timed history makes all three paired rules mature. One bad
  // sample is enough for the fast 99.9% sampled-check rule, without an incident streak.
  const seedHistory = async (revision, lastSlot) => {
    const firstSlot = lastSlot - 4320 + 1;
    // Durable Object SQLite permits at most 100 bound parameters per statement.
    for (let batch = firstSlot; batch <= lastSlot; batch += 12) {
      const slots = Array.from(
        { length: Math.min(12, lastSlot - batch + 1) },
        (_, index) => batch + index,
      );
      await storage.exec(
        `INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES ${slots.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
        ...slots.flatMap((slot) => [
          'catalog',
          slot,
          slot * MINUTE + 1020,
          slot === lastSlot ? 'http-error' : 'good',
          slot === lastSlot ? 503 : 200,
          20,
          revision,
          slot * MINUTE + 1000,
        ]),
      );
    }
  };
  await seedHistory(1, end);
  await tick(now);
  const firing = await budget();
  assert.equal(firing.evaluationStatus, 'current');
  assert.equal(firing.evaluation.state, 'firing');
  assert(firing.lastFiring);
  assert.equal(firing.lastFiring.firstFiredAt, now);
  assert.equal(firing.lastFiring.lastConfirmedAt, now);
  assert.equal(firing.lastFiring.revision, 1);
  assert.deepEqual(firing.lastFiring.policyContext, {
    service: 'catalog',
    revision: 1,
    recordedAt: start * MINUTE,
    name: 'Catalog',
    transport: 'origin',
    assertion: 'ok-json',
    policy: (await read()).services[0].policy,
    provenance: 'recorded',
  });
  assert(!JSON.stringify(firing.lastFiring).includes(target.url));
  const helperBundle = await build({
    entryPoints: ['worker/budget-signals.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const { BudgetSignals } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(helperBundle.outputFiles[0].text).toString('base64')
  );
  const invalidContextSignals = new BudgetSignals({
    transactionSync: () => assert.fail('Invalid policy context must not access storage'),
  });
  const validInput = {
    service: 'catalog',
    revision: 1,
    policy: firing.lastFiring.policyContext.policy,
    policyRecordedAt: start * MINUTE,
    policyContext: firing.lastFiring.policyContext,
    now,
  };
  for (const patch of [
    { service: 'different-service' },
    { revision: 2 },
    { recordedAt: start * MINUTE + 1 },
    { policy: { ...validInput.policy, availabilityTarget: 99.8 } },
  ])
    assert.throws(
      () =>
        invalidContextSignals.update({
          ...validInput,
          policyContext: { ...validInput.policyContext, ...patch },
        }),
      { message: 'Budget policy context must match the evaluated service revision and policy' },
    );
  console.log(
    'PASS mismatched service, revision, capture time, or policy context is rejected before storage access',
  );
  assert.equal((await read()).incidents.length, 0);
  await tick(now + 1000);
  const continuing = await budget();
  assert.equal(continuing.lastFiring.firstFiredAt, now);
  assert.equal(continuing.lastFiring.lastConfirmedAt, now + 1000);
  assert.equal(calls, 1);
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  assert.deepEqual(await budget(), continuing);
  console.log(
    'PASS sampled burn warning without a failure streak, duplicate evaluation continuity, and actual eviction persistence',
  );

  await storage.exec(
    'UPDATE checks SET outcome=?,status=?,observed_at=NULL WHERE service=? AND slot=?',
    'good',
    200,
    'catalog',
    end,
  );
  await tick(now + 2000);
  const legacyGap = await budget();
  assert.equal(legacyGap.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(legacyGap.lastFiring, continuing.lastFiring);
  await storage.exec('DELETE FROM checks WHERE service=? AND slot=?', 'catalog', end);
  await tick(now + 3000);
  const missingGap = await budget();
  assert.equal(missingGap.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(missingGap.lastFiring, continuing.lastFiring);
  await storage.exec(
    'INSERT INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
    'catalog',
    end,
    end * MINUTE + 1020,
    'good',
    200,
    20,
    1,
    end * MINUTE + 1000,
  );
  await tick(now + 4000);
  const clear = await budget();
  assert.equal(clear.evaluationStatus, 'current');
  assert.equal(clear.evaluation.state, 'clear');
  assert.deepEqual(clear.lastFiring, continuing.lastFiring);
  console.log(
    'PASS legacy/missing samples cannot confidently clear; qualified current recovery retains prior warning evidence',
  );

  await storage.exec(
    'UPDATE checks SET outcome=?,status=? WHERE service=? AND slot=?',
    'http-error',
    503,
    'catalog',
    end,
  );
  await tick(now + 5000);
  const refired = await budget();
  assert.equal(refired.evaluation.state, 'firing');
  assert.equal(refired.lastFiring.firstFiredAt, now + 5000);
  await storage.exec(
    'UPDATE checks SET observed_at=NULL WHERE service=? AND slot=?',
    'catalog',
    end,
  );
  await tick(now + 6000);
  const interrupted = await budget();
  assert.equal(interrupted.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(interrupted.lastFiring, refired.lastFiring);
  await storage.exec(
    'UPDATE checks SET observed_at=? WHERE service=? AND slot=?',
    end * MINUTE + 1000,
    'catalog',
    end,
  );
  await tick(now + 7000);
  const confirmedAgain = await budget();
  assert.equal(confirmedAgain.evaluation.state, 'firing');
  assert.equal(confirmedAgain.lastFiring.firstFiredAt, now + 7000);
  await storage.exec(
    'UPDATE checks SET outcome=?,status=? WHERE service=? AND slot=?',
    'good',
    200,
    'catalog',
    end,
  );
  for (const offset of [10, 11, 12])
    await storage.exec(
      'UPDATE checks SET outcome=?,status=? WHERE service=? AND slot=?',
      'http-error',
      503,
      'catalog',
      end - offset,
    );
  await tick(now + 7500);
  const sustained = await budget();
  assert.equal(sustained.evaluation.highestFiring, 'sustained');
  assert.equal(sustained.lastFiring.rule, 'sustained');
  assert.equal(sustained.lastFiring.firstFiredAt, now + 7500);
  for (const offset of [10, 11, 12])
    await storage.exec(
      'UPDATE checks SET outcome=?,status=? WHERE service=? AND slot=?',
      'good',
      200,
      'catalog',
      end - offset,
    );
  await storage.exec(
    'UPDATE checks SET outcome=?,status=? WHERE service=? AND slot=?',
    'http-error',
    503,
    'catalog',
    end,
  );
  await tick(now + 7800);
  const rapidAgain = await budget();
  assert.equal(rapidAgain.evaluation.highestFiring, 'rapid');
  assert.equal(rapidAgain.lastFiring.firstFiredAt, now + 7800);
  const historicalWarning = rapidAgain.lastFiring;
  console.log(
    'PASS interrupted, cleared, or changed-rule firing evidence starts a new confirmed interval',
  );

  await setClock(now + 8000);
  await policy(1, { availabilityTarget: 99.95 });
  const changed = await budget();
  assert.equal(changed.evaluationStatus, 'policy-changed');
  assert.equal(changed.evaluation.revision, 1);
  assert.deepEqual(changed.lastFiring, historicalWarning);
  await tick(now + 9000);
  const newPolicy = await budget();
  assert.equal(newPolicy.evaluationStatus, 'current');
  assert.equal(newPolicy.evaluation.revision, 2);
  assert.equal(newPolicy.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(newPolicy.lastFiring, historicalWarning);
  await policy(2, { paused: true });
  assert.equal((await budget()).evaluationStatus, 'policy-changed');
  await tick(now + 10000);
  const maintenance = await budget();
  assert.equal(maintenance.evaluation.state, 'maintenance');
  assert.deepEqual(maintenance.lastFiring, historicalWarning);
  await policy(3, { paused: false });
  await tick(now + 11000);
  const resumed = await budget();
  assert.equal(resumed.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(resumed.lastFiring, historicalWarning);
  console.log(
    'PASS policy generations and maintenance preserve historical warnings without presenting them as current confidence',
  );

  const computedAt = resumed.evaluation.computedAt;
  await setClock(computedAt + 180000);
  assert.equal((await budget()).evaluationStatus, 'current');
  await setClock(computedAt + 180001);
  const stale = await budget();
  assert.equal(stale.evaluationStatus, 'stale');
  assert.equal(stale.evaluation.computedAt, computedAt);
  assert.deepEqual((await budget()).lastFiring, historicalWarning);
  assert.equal((await budget()).evaluation.computedAt, computedAt);
  const ready = await mf.dispatchFetch('https://edgelab.example/api/ready');
  assert.equal(ready.status, 503);
  assert.equal((await storage.exec('SELECT service FROM budget_signals')).length, 1);
  await setClock(computedAt - 1);
  assert.equal((await budget()).evaluationStatus, 'stale');
  console.log(
    'PASS evaluation freshness boundary, future-time rejection, and read-only monitoring readiness aging',
  );

  const later = now + 31 * DAY;
  await storage.exec(
    'INSERT INTO budget_signals(service,revision,computed_at,evaluation,last_firing) VALUES(?,?,?,?,?)',
    'removed',
    1,
    now,
    JSON.stringify(firing.evaluation),
    JSON.stringify(historicalWarning),
  );
  await tick(later);
  const retained = await budget();
  assert.equal(retained.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(retained.lastFiring, historicalWarning);
  assert.equal(
    (
      await storage.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        1,
      )
    ).length,
    0,
  );
  assert.equal(retained.lastFiring.policyContext.policy.availabilityTarget, 99.9);
  assert.deepEqual(
    (await storage.exec('SELECT service FROM budget_signals')).map((row) => row.service),
    ['catalog'],
  );
  console.log(
    'PASS removed-service retention pruning preserves the configured service’s historical warning evidence',
  );
  await seedHistory(4, Math.floor(later / MINUTE) - 1);
  await tick(later + 1000);
  const firingNewPolicy = await budget();
  assert.equal(firingNewPolicy.evaluation.state, 'firing');
  assert.equal(firingNewPolicy.evaluation.revision, 4);
  assert.equal(firingNewPolicy.lastFiring.rule, historicalWarning.rule);
  assert.equal(firingNewPolicy.lastFiring.revision, 4);
  assert.equal(firingNewPolicy.lastFiring.firstFiredAt, later + 1000);
  assert.equal(firingNewPolicy.lastFiring.lastConfirmedAt, later + 1000);
  console.log(
    'PASS a mature new policy’s firing interval cannot inherit the old policy’s first-fired timestamp',
  );
  const afterStall = later + 4 * MINUTE + 1000;
  await setClock(afterStall);
  const oldFiring = await budget();
  assert.equal(oldFiring.evaluationStatus, 'stale');
  assert.deepEqual(oldFiring.lastFiring, firingNewPolicy.lastFiring);
  const previousEnd = Math.floor(later / MINUTE) - 1;
  const currentEnd = Math.floor(afterStall / MINUTE) - 1;
  // Fresh underlying observations can requalify the same rule even when signal
  // evaluation itself stopped. They cannot prove an uninterrupted firing interval.
  for (let slot = previousEnd + 1; slot <= currentEnd; slot++)
    await storage.exec(
      'INSERT OR REPLACE INTO checks(service,slot,at,outcome,status,latency,revision,observed_at) VALUES(?,?,?,?,?,?,?,?)',
      'catalog',
      slot,
      slot * MINUTE + 1020,
      'good',
      200,
      20,
      4,
      slot * MINUTE + 1000,
    );
  await tick(afterStall);
  const freshFiring = await budget();
  assert.equal(freshFiring.evaluationStatus, 'current');
  assert.equal(freshFiring.evaluation.state, 'firing');
  assert.equal(freshFiring.lastFiring.rule, firingNewPolicy.lastFiring.rule);
  assert.equal(freshFiring.lastFiring.revision, firingNewPolicy.lastFiring.revision);
  assert.equal(freshFiring.lastFiring.firstFiredAt, afterStall);
  assert.equal(freshFiring.lastFiring.lastConfirmedAt, afterStall);
  console.log('PASS requalified firing after a stale evaluation starts a fresh confirmed interval');

  const { policyContext: legacyContext, ...legacyWarning } = freshFiring.lastFiring;
  await storage.exec(
    'UPDATE budget_signals SET last_firing=? WHERE service=?',
    JSON.stringify(legacyWarning),
    'catalog',
  );
  const legacyRead = await budget();
  assert.deepEqual(legacyRead.lastFiring, { ...legacyWarning, policyContext: null });
  assert.equal(
    Object.hasOwn(
      JSON.parse(
        (await storage.exec('SELECT last_firing FROM budget_signals WHERE service=?', 'catalog'))[0]
          .last_firing,
      ),
      'policyContext',
    ),
    false,
  );
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  assert.equal((await budget()).lastFiring.policyContext, null);
  await tick(afterStall + 1000);
  const confirmedLegacy = await budget();
  assert.equal(confirmedLegacy.evaluation.state, 'firing');
  assert.equal(confirmedLegacy.lastFiring.firstFiredAt, legacyWarning.firstFiredAt);
  assert.equal(confirmedLegacy.lastFiring.lastConfirmedAt, afterStall + 1000);
  assert.deepEqual(confirmedLegacy.lastFiring.policyContext, legacyContext);
  console.log(
    'PASS legacy warnings expose unavailable policy context without mutating reads; a new confirmation captures it',
  );

  const originalWarning = confirmedLegacy.lastFiring;
  const renamedTarget = {
    ...target,
    name: 'Replacement catalog contract',
    assertion: 'catalog-json',
  };
  await mf.setOptions(runtimeOptions(renamedTarget));
  const replacementNamespace = await mf.getDurableObjectNamespace('MONITORS', 'gateway');
  stub = replacementNamespace.get(replacementNamespace.idFromName('operations'));
  storage = await mf.unsafeGetDurableObjectStorage('gateway', 'MonitorStore', {
    name: 'operations',
  });
  await setClock(afterStall + 2000);
  const renamedService = (await read()).services[0];
  assert.equal(renamedService.revision, 5);
  assert.equal(renamedService.name, renamedTarget.name);
  await policy(5, { availabilityTarget: 99.8, latencyObjectiveMs: 250 });
  const replacementPolicy = (await read()).services[0];
  assert.equal(replacementPolicy.revision, 6);
  assert.equal(replacementPolicy.policy.availabilityTarget, 99.8);
  assert.equal(replacementPolicy.policy.latencyObjectiveMs, 250);
  assert.deepEqual(replacementPolicy.budget.lastFiring, originalWarning);
  const afterContextRetention = afterStall + 31 * DAY;
  await tick(afterContextRetention);
  const contextRetained = await budget();
  assert.equal(contextRetained.evaluation.revision, 6);
  assert.equal(contextRetained.evaluation.state, 'insufficient-evidence');
  assert.deepEqual(contextRetained.lastFiring, originalWarning);
  assert.equal(
    (
      await storage.exec(
        'SELECT revision FROM service_versions WHERE service=? AND revision=?',
        'catalog',
        originalWarning.revision,
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await storage.exec(
        'SELECT slot FROM checks WHERE service=? AND revision=?',
        'catalog',
        originalWarning.revision,
      )
    ).length,
    0,
  );
  assert.equal(contextRetained.lastFiring.policyContext.name, target.name);
  assert.equal(contextRetained.lastFiring.policyContext.assertion, target.assertion);
  assert.equal(contextRetained.lastFiring.policyContext.policy.availabilityTarget, 99.95);
  assert.notEqual(
    contextRetained.lastFiring.policyContext.policy.availabilityTarget,
    replacementPolicy.policy.availabilityTarget,
  );
  assert(!JSON.stringify(contextRetained.lastFiring.policyContext).includes(target.url));
  await mf.unsafeEvictDurableObject('gateway', 'MonitorStore', { name: 'operations' });
  assert.deepEqual(await budget(), contextRetained);
  console.log(
    'PASS immutable warning policy survives target/name/assertion/objective replacement, 31-day source pruning, and eviction',
  );
} finally {
  await mf.dispose();
}
