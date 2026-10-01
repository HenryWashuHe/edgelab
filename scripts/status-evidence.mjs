import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { format } from 'prettier';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(`Project the pinned local status-reuse evidence; no runtime or network calls.
  node scripts/status-evidence.mjs          Check the generated projection.
  node scripts/status-evidence.mjs --check  Check the generated projection.
  node scripts/status-evidence.mjs --write  Explicitly regenerate the thin projection.

Source: docs/evidence/releases/3.7.0-status-cache.json
Output: src/data/status-reuse-evidence.json
Only recorded cohorts are copied. No billing, CPU or hypothetical workload estimates.`);
  process.exit(0);
}
assert(
  args.length === 0 || (args.length === 1 && ['--check', '--write'].includes(args[0])),
  'Only --check and explicit --write are supported; there is no live mode.',
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = 'docs/evidence/releases/3.7.0-status-cache.json';
const artifactCommit = '565ea3504eadfd0b85e682ddf5922dfb0454bc17';
const artifactSHA256 = '551c4c23f4e5dc9b3ed084a9330093c2ecb18874db0fb509c01f6d5050586853';
const bytes = await readFile(resolve(root, artifactPath));
assert.equal(createHash('sha256').update(bytes).digest('hex'), artifactSHA256);
const report = JSON.parse(bytes.toString('utf8'));
assert.equal(report.schemaVersion, 1);
assert.equal(report.kind, 'edgelab-local-status-cache-manifest');
assert.equal(report.sourceProjectVersion, '3.7.0');
assert.equal(report.measuredAt, '2026-10-01T01:15:44.822Z');
assert.equal(report.sourceStableDuringRun, true);
assert.equal(report.assertions.length, 28);
assert.deepEqual(report.protocol.canonicalWindows, ['24h', '7d']);
assert.equal(report.protocol.maxAgeMs, 10000);
assert.equal(report.protocol.sameUTCMinute, true);
assert.equal(report.protocol.maxEntries, 2);
assert.equal(report.protocol.maxCombinedSerializedBytes, 1048576);
for (const key of ['productionRequests', 'accountCalls', 'nativeInferenceCalls'])
  assert.equal(report.environment[key], 0);
for (const key of ['observedGatewayVersions', 'observedStatusVersions'])
  assert.deepEqual(report.protocol[key], [
    { targetCount: 2, version: '3.7.0' },
    { targetCount: 5, version: '3.7.0' },
  ]);

const integer = (value) => {
  assert(Number.isSafeInteger(value) && value >= 0, 'Invalid recorded counter');
  return value;
};
const hash = (value) => {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid source hash');
  return value;
};
const unique = (entries, predicate) => {
  const matches = entries.filter(predicate);
  assert.equal(matches.length, 1, 'Recorded operation must be unique');
  return matches[0];
};
const methodCalls = (operations, names) =>
  names.reduce((total, name) => total + integer(operations[name]), 0);

function measurement(targetCount, window, id, operation, requests) {
  const cost = unique(
    report.costs,
    (entry) => entry.targetCount === targetCount && entry.operation === `${operation}-${window}`,
  );
  assert.equal(cost.failedStatements, 0);
  assert.equal(cost.nativeFaultsFired, 0);
  if (requests === 100) {
    for (const key of ['statements', 'attemptedStatements', 'rowsRead', 'rowsWritten'])
      assert.equal(cost[key], 0);
    Object.values(cost.operations).forEach((value) => assert.equal(value, 0));
  }
  // Copy named counters only. Method totals sum measured calls, not billed rows.
  return {
    id,
    requests,
    attemptedStatements: integer(cost.attemptedStatements),
    statements: integer(cost.statements),
    rowsRead: integer(cost.rowsRead),
    rowsWritten: integer(cost.rowsWritten),
    kvCalls: methodCalls(cost.operations, ['kvGet', 'kvPut', 'kvDelete', 'kvList']),
    storageCalls: methodCalls(cost.operations, [
      'storageGet',
      'storagePut',
      'storageDelete',
      'storageList',
      'storageDeleteAll',
    ]),
    alarmCalls: methodCalls(cost.operations, ['alarmGet', 'alarmSet', 'alarmDelete']),
  };
}
function nativeFailure(targetCount, operation) {
  const entry = unique(
    report.nativeFailures,
    (failure) => failure.targetCount === targetCount && failure.operation === operation,
  );
  assert.equal(entry.failedAttemptCursorCost, null);
  assert.equal(entry.failedAttempts, 1);
  assert.equal(entry.nativeFaultsFired, 1);
  assert.equal(entry.sanitized503, true);
  assert.equal(entry.staleFallbackServed, false);
  const common = {
    attemptedStatements: integer(entry.attemptedStatements),
    consumedStatements: integer(entry.consumedStatements),
    failedAttempts: integer(entry.failedAttempts),
    nativeFaultsFired: integer(entry.nativeFaultsFired),
    consumedCursorRowsRead: integer(entry.consumedCursorRowsRead),
    consumedCursorRowsWritten: integer(entry.consumedCursorRowsWritten),
    failedAttemptCursorCost: null,
    sanitized503: true,
    staleFallbackServed: false,
  };
  if (operation === 'policy-write') {
    assert.equal(entry.selectedWriteExecuted, true);
    assert.equal(entry.sourceAndQueueRolledBack, true);
    return { ...common, selectedWriteExecuted: true, sourceAndQueueRolledBack: true };
  }
  assert.equal(entry.otherWindowWasOneMillisecondOld, true);
  assert.equal(entry.bothWindowsCleared, true);
  return { ...common, otherWindowWasOneMillisecondOld: true, bothWindowsCleared: true };
}
const sourcePaths = [
  'package.json',
  'worker/monitor.ts',
  'worker/status-view-cache.ts',
  'worker/budget-signals.ts',
  'worker/index.ts',
  'tests/fixtures/status-cache.ts',
  'scripts/status-cache.mjs',
];
assert.deepEqual(Object.keys(report.sourceSHA256), sourcePaths);
const projected = {
  schemaVersion: 1,
  source: {
    projectVersion: report.sourceProjectVersion,
    measuredAt: report.measuredAt,
    artifactPath,
    artifactCommit,
    artifactURL: `https://github.com/HenryWashuHe/edgelab/blob/${artifactCommit}/${artifactPath}`,
    artifactSHA256,
    bundleSHA256: hash(report.bundleSHA256),
    sourceSHA256: sourcePaths.map((path) => ({ path, sha256: hash(report.sourceSHA256[path]) })),
    sourceStableDuringRun: report.sourceStableDuringRun,
    proofGroups: report.assertions.length,
    command: report.command,
    runtime: {
      node: report.environment.node,
      miniflare: report.environment.miniflare,
      workerd: report.environment.workerd,
      compatibilityDate: report.environment.compatibilityDate,
    },
    execution: { productionRequests: 0, accountCalls: 0, nativeInferenceCalls: 0 },
  },
  limits: {
    maxAgeMs: report.protocol.maxAgeMs,
    sameUTCMinute: report.protocol.sameUTCMinute,
    maxEntries: report.protocol.maxEntries,
    maxCombinedSerializedBytes: report.protocol.maxCombinedSerializedBytes,
  },
  profiles: [2, 5].map((targetCount) => {
    const fixture = unique(report.fixtures, (entry) => entry.targetCount === targetCount);
    const sourceTimesProof = unique(
      report.assertions,
      (entry) =>
        entry ===
        `${targetCount} targets: memory-hit freshness 180000→180001 ages status/budget/readiness without renewing evidence`,
    );
    return {
      targetCount,
      fixture: {
        finishedHistorySlotsPerTarget: integer(fixture.finishedHistorySlotsPerTarget),
        retainedFinishedChecksPerTarget: integer(fixture.retainedFinishedChecksPerTarget),
        recentSchedulerEvents: integer(fixture.recentSchedulerEventsBeforeCurrentTick),
      },
      sourceTimesProof,
      windows: ['24h', '7d'].map((window) => ({
        window,
        measurements: [
          measurement(targetCount, window, 'storage-miss', 'mature-miss', 1),
          measurement(targetCount, window, 'authoritative-export', 'authoritative-export', 1),
          measurement(targetCount, window, 'concurrent-hits', '100-concurrent-hits', 100),
          measurement(targetCount, window, 'sequential-hits', '100-sequential-hits', 100),
        ],
      })),
      policyFailure: nativeFailure(targetCount, 'policy-write'),
      readFailure: nativeFailure(targetCount, 'status-read'),
    };
  }),
};
const outputPath = resolve(root, 'src/data/status-reuse-evidence.json');
if (args[0] === '--write') {
  const style = JSON.parse(await readFile(resolve(root, '.prettierrc.json'), 'utf8'));
  await writeFile(
    outputPath,
    await format(JSON.stringify(projected), { ...style, parser: 'json' }),
  );
  console.log('Wrote thin status-reuse projection from pinned 3.7.0 local evidence.');
} else {
  const existing = JSON.parse(await readFile(outputPath, 'utf8'));
  assert(isDeepStrictEqual(existing, projected), 'Projection changed; inspect before --write.');
  console.log(
    'PASS pinned status-reuse projection: recorded cohorts, bounded source metadata, native unknown costs.',
  );
}
