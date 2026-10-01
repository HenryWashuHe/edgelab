import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import report from '../docs/evidence/releases/3.7.0-status-cache.json';
import artifactText from '../docs/evidence/releases/3.7.0-status-cache.json?raw';
import projection from '../src/data/status-reuse-evidence.json';
import { runtimeEvidence, statusReuseMeasurements } from '../src/runtime-evidence';

const artifactPath = 'docs/evidence/releases/3.7.0-status-cache.json';
const artifactCommit = '565ea3504eadfd0b85e682ddf5922dfb0454bc17';
const operations: Record<string, string> = {
  'storage-miss': 'mature-miss',
  'authoritative-export': 'authoritative-export',
  'concurrent-hits': '100-concurrent-hits',
  'sequential-hits': '100-sequential-hits',
};
const deepKeys = (value: unknown): string[] =>
  value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => [key, ...deepKeys(child)])
    : [];

describe('pinned static status-reuse evidence', () => {
  it('pins full artifact bytes, source hashes and runtime scope rather than the current app version', async () => {
    const source = runtimeEvidence.source;
    expect(source.projectVersion).toBe('3.7.0');
    expect(source.measuredAt).toBe(report.measuredAt);
    expect(source.proofGroups).toBe(report.assertions.length);
    expect(source.sourceStableDuringRun).toBe(true);
    expect(source.artifactPath).toBe(artifactPath);
    expect(source.artifactCommit).toBe(artifactCommit);
    expect(source.artifactURL).toBe(
      `https://github.com/HenryWashuHe/edgelab/blob/${artifactCommit}/${artifactPath}`,
    );
    const artifactDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(artifactText),
    );
    expect(source.artifactSHA256).toBe(
      [...new Uint8Array(artifactDigest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    );
    expect(source.bundleSHA256).toBe(report.bundleSHA256);
    expect(
      Object.fromEntries(source.sourceSHA256.map((entry) => [entry.path, entry.sha256])),
    ).toEqual(report.sourceSHA256);
    expect(source.runtime).toEqual({
      node: report.environment.node,
      miniflare: report.environment.miniflare,
      workerd: report.environment.workerd,
      compatibilityDate: report.environment.compatibilityDate,
    });
    expect(source.execution).toEqual({
      productionRequests: 0,
      accountCalls: 0,
      nativeInferenceCalls: 0,
    });
    expect(runtimeEvidence.limits).toEqual({
      maxAgeMs: report.protocol.maxAgeMs,
      sameUTCMinute: report.protocol.sameUTCMinute,
      maxEntries: report.protocol.maxEntries,
      maxCombinedSerializedBytes: report.protocol.maxCombinedSerializedBytes,
    });
    expect(runtimeEvidence).toEqual(projection);
  });

  for (const targetCount of [2, 5]) {
    for (const window of ['24h', '7d']) {
      it(`${targetCount} targets/${window}: preserves exact one-request and 100-request cohort totals`, () => {
        const selection = statusReuseMeasurements(targetCount, window)!;
        expect(selection).not.toBeNull();
        expect(selection.selected.measurements.map((entry) => entry.id)).toEqual([
          'storage-miss',
          'authoritative-export',
          'concurrent-hits',
          'sequential-hits',
        ]);
        expect(selection.selected.measurements.map((entry) => entry.requests)).toEqual([
          1, 1, 100, 100,
        ]);
        for (const entry of selection.selected.measurements) {
          const cost = report.costs.find(
            (candidate) =>
              candidate.targetCount === targetCount &&
              candidate.operation === `${operations[entry.id]}-${window}`,
          )!;
          expect(entry.attemptedStatements).toBe(cost.attemptedStatements);
          expect(entry.statements).toBe(cost.statements);
          expect(entry.rowsRead).toBe(cost.rowsRead);
          expect(entry.rowsWritten).toBe(cost.rowsWritten);
          expect(entry.kvCalls).toBe(
            cost.operations.kvGet +
              cost.operations.kvPut +
              cost.operations.kvDelete +
              cost.operations.kvList,
          );
          expect(entry.storageCalls).toBe(
            cost.operations.storageGet +
              cost.operations.storagePut +
              cost.operations.storageDelete +
              cost.operations.storageList +
              cost.operations.storageDeleteAll,
          );
          expect(entry.alarmCalls).toBe(
            cost.operations.alarmGet + cost.operations.alarmSet + cost.operations.alarmDelete,
          );
          if (entry.requests === 100) {
            expect(entry).toMatchObject({
              attemptedStatements: 0,
              statements: 0,
              rowsRead: 0,
              rowsWritten: 0,
              kvCalls: 0,
              storageCalls: 0,
              alarmCalls: 0,
            });
          }
        }
        expect(report.assertions).toContain(selection.profile.sourceTimesProof);
        const fixture = report.fixtures.find((entry) => entry.targetCount === targetCount)!;
        expect(selection.profile.fixture).toEqual({
          finishedHistorySlotsPerTarget: fixture.finishedHistorySlotsPerTarget,
          retainedFinishedChecksPerTarget: fixture.retainedFinishedChecksPerTarget,
          recentSchedulerEvents: fixture.recentSchedulerEventsBeforeCurrentTick,
        });
      });
    }
  }

  it('retains native fault attempts and rollback evidence without converting unknown row cost into zero', () => {
    for (const profile of runtimeEvidence.profiles) {
      for (const [operation, failure] of [
        ['policy-write', profile.policyFailure],
        ['status-read', profile.readFailure],
      ] as const) {
        const archived = report.nativeFailures.find(
          (entry) => entry.targetCount === profile.targetCount && entry.operation === operation,
        )!;
        for (const key of [
          'attemptedStatements',
          'consumedStatements',
          'failedAttempts',
          'nativeFaultsFired',
          'consumedCursorRowsRead',
          'consumedCursorRowsWritten',
          'failedAttemptCursorCost',
          'sanitized503',
          'staleFallbackServed',
        ] as const)
          expect(failure[key]).toBe(archived[key]);
        expect(failure.failedAttemptCursorCost).toBeNull();
        expect(failure.failedAttempts).toBe(1);
        expect(failure.attemptedStatements).toBe(failure.consumedStatements + 1);
        expect(failure.sanitized503).toBe(true);
        expect(failure.staleFallbackServed).toBe(false);
      }
      expect(profile.policyFailure.sourceAndQueueRolledBack).toBe(true);
      expect(profile.policyFailure.selectedWriteExecuted).toBe(true);
      expect(profile.policyFailure.consumedCursorRowsWritten).toBeGreaterThan(0);
      expect(profile.readFailure.bothWindowsCleared).toBe(true);
      expect(profile.readFailure.otherWindowWasOneMillisecondOld).toBe(true);
    }
  });

  it('does not invent an unmeasured selection and keeps the captured projection immutable', () => {
    expect(statusReuseMeasurements(3, '24h')).toBeNull();
    expect(statusReuseMeasurements(2, '30d')).toBeNull();
    expect(statusReuseMeasurements(NaN, '7d')).toBeNull();
    const row = statusReuseMeasurements(2, '24h')!.selected.measurements[0];
    const before = JSON.stringify(runtimeEvidence);
    expect(Object.isFrozen(runtimeEvidence)).toBe(true);
    expect(Object.isFrozen(runtimeEvidence.source.sourceSHA256[0])).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Reflect.set(row, 'rowsRead', 999)).toBe(false);
    expect(JSON.stringify(runtimeEvidence)).toBe(before);
  });

  it('ships only the small allowlisted projection and has no runtime/backend/browser-storage dependency', async () => {
    const keys = deepKeys(projection);
    for (const forbidden of [
      'bootId',
      'costs',
      'assertions',
      'environment',
      'authorization',
      'token',
      'requestId',
      'capability',
      'notes',
      'targetURL',
      'body',
      'response',
    ])
      expect(keys).not.toContain(forbidden);
    expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThan(12000);
    const compiled = await build({
      entryPoints: ['src/runtime-evidence.ts'],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      metafile: true,
    });
    expect(Object.keys(compiled.metafile!.inputs).sort()).toEqual([
      'src/data/status-reuse-evidence.json',
      'src/runtime-evidence.ts',
    ]);
    expect(compiled.outputFiles[0].text).not.toContain('cold-constructor');
    expect(compiled.outputFiles[0].text).not.toContain('bootId');
    const component = await build({
      entryPoints: ['src/RuntimeEvidence.tsx'],
      outdir: 'output/runtime-evidence-build-check',
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      metafile: true,
    });
    expect(
      Object.keys(component.metafile!.inputs)
        .filter((path) => !path.startsWith('node_modules/'))
        .sort(),
    ).toEqual([
      'src/RuntimeEvidence.tsx',
      'src/data/status-reuse-evidence.json',
      'src/runtime-evidence.css',
      'src/runtime-evidence.ts',
    ]);
    const forbiddenAccess = vi.fn(() => {
      throw new Error('Static evidence must not access APIs, sessions or storage');
    });
    vi.stubGlobal('fetch', forbiddenAccess);
    vi.stubGlobal('WebSocket', forbiddenAccess);
    vi.stubGlobal('localStorage', { getItem: forbiddenAccess, setItem: forbiddenAccess });
    vi.stubGlobal('sessionStorage', { getItem: forbiddenAccess, setItem: forbiddenAccess });
    try {
      vi.resetModules();
      const reloaded = await import('../src/runtime-evidence');
      expect(reloaded.statusReuseMeasurements(5, '7d')!.selected.measurements).toHaveLength(4);
      expect(forbiddenAccess).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
