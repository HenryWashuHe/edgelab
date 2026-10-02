import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildConsumerFixture } from '../subscription-evidence/fixture.mjs';
import { buildServerFixture } from './fixture.mjs';

let consumerFixture;
let nativeFixturesDisposed = 0;
let consumersDisposed = 0;
let casesCompleted = 0;
let startedAt;
let sourceBaseCommit;
let runnerBytes;
let runnerPin;
const nativeFinalMetadata = [];
const observations = [];
const runnerFile = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);

async function bounded(promise, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Controlled paired proof deadline exceeded')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function gate() {
  let release;
  let announce;
  let released = false;
  const entered = new Promise((resolve) => {
    announce = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered,
    async wait(value) {
      announce();
      await waiting;
      return value;
    },
    release() {
      if (!released) {
        released = true;
        release();
      }
    },
  };
}

function baseSnapshot(native) {
  assert.deepEqual(native.codeBase, {
    generation: native.generation,
    revision: native.revision,
    pins: [{ gadgetId: 1, baseCommit: 'fixture-base' }],
  });
  return {
    codeBase: structuredClone(native.codeBase),
    // These native fixture rows are not materialized. The base delegate is a
    // disclosed controlled file map; accepted rows must still enter pushRow.
    rowsThrough: 0,
  };
}

const drain = (client) => bounded(client.__evidenceDrain(), 2000);
const content = (client) => client.getFiles(1)?.get('index.txt');

function observation(t, phase, native, client, transport = { fulfilled: 0, rejected: 0 }) {
  const model = client.__evidenceSnapshot();
  const value = {
    kind: 'paired-position-observation',
    phase,
    native: {
      generation: native.generation,
      revision: native.revision,
      retainedRows: native.retained.length,
    },
    consumer: { ...model, isReady: client.isReady() },
    controllerFacade: transport,
    generationMatch: native.generation === model.generation,
    revisionMatch: native.revision === model.appliedRevision,
    clocks: {
      nativeSampleObservedAt: native.observedAt,
      consumerSampleObservedAt: Date.now(),
      meaning: 'observation-clocks-not-commit-times',
    },
  };
  observations.push(structuredClone(value));
  t.diagnostic(JSON.stringify(value));
}

function bundleBinding(t, server) {
  const select = (bundle) => {
    assert.ok(Number.isSafeInteger(bundle.bytes) && bundle.bytes > 0);
    assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
    return { bytes: bundle.bytes, sha256: bundle.sha256 };
  };
  t.diagnostic(
    JSON.stringify({
      kind: 'paired-executed-bundles',
      server: select(server.evidence.bundle),
      consumer: select(consumerFixture.evidence.bundle),
      transport: 'local-controller-http-and-controlled-subscriber-facade',
      boundary: 'quiescent-internal-ot-model-not-rpc-or-rendering',
    }),
  );
}

async function caseFixture(t, name) {
  // The builder owns its startup deadline and failure cleanup. Do not abandon
  // construction with an outer Promise.race: dispose any late successful build
  // if node:test has already canceled this case.
  const server = await buildServerFixture();
  if (t.signal.aborted) {
    await server.dispose();
    throw new Error('Controlled paired case canceled during native construction');
  }
  const clients = [];
  const releases = [];
  const call = (action, body) => bounded(server.call(action, body));
  t.after(async () => {
    const failures = [];
    let final;
    try {
      for (const release of releases) release();
      for (const client of clients) {
        client.dispose();
        try {
          await drain(client);
          assert.equal(client.__evidenceSnapshot().disposed, true);
          consumersDisposed++;
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      try {
        final = await server.dispose();
        assert.equal(final.sourceStableAfterRunAndDisposal, true);
        assert.equal(final.tempRuntimeDisposed, true);
        nativeFixturesDisposed++;
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await consumerFixture.assertStable();
      assert.deepEqual(await readFile(runnerFile), runnerBytes);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw failures[0];
    nativeFinalMetadata.push({ case: name, ...final });
    t.diagnostic(
      JSON.stringify({
        kind: 'paired-case-lifecycle',
        case: name,
        nativeSourceStableAfterDisposal: true,
        nativeRuntimeDisposed: true,
        consumerInputsStable: true,
        disposedConsumers: clients.length,
      }),
    );
  });
  bundleBinding(t, server);
  return {
    server,
    call,
    async sample() {
      const sample = await call('sample');
      assert.equal(sample.generation, 1, 'Only the fixed native chat generation is supported');
      assert.ok(
        Number.isSafeInteger(sample.revision) && sample.revision >= 0 && sample.revision <= 8,
      );
      assert.ok(Number.isSafeInteger(sample.instanceOrdinal) && sample.instanceOrdinal > 0);
      assert.ok(Array.isArray(sample.retained));
      assert.ok(
        Number.isSafeInteger(sample.observedAt) &&
          sample.observedAt >= 0 &&
          sample.observedAt <= 8640000000000000,
      );
      for (const row of sample.retained) {
        assert.equal(row.generation, sample.generation);
        assert.ok(
          Number.isSafeInteger(row.revision) && row.revision > 0 && row.revision <= sample.revision,
        );
        assert.equal(row.retired, false);
      }
      return sample;
    },
    client(options = {}) {
      const events = [];
      const fatalSignals = [];
      const client = new consumerFixture.ChatOtClient({
        async fetchCommitFiles(commit) {
          assert.equal(
            commit,
            'fixture-base',
            'The controlled base delegate must match the native pin',
          );
          const files = new Map([['index.txt', 'controlled-base']]);
          return options.fetchGate ? options.fetchGate.wait(files) : files;
        },
        async submitCodeChange() {
          throw new Error('Paired proof must not submit client edits');
        },
        isTransientError() {
          return false;
        },
        onRemoteChange(changes) {
          events.push(changes.map((event) => structuredClone(event)));
          options.onRemote?.(changes, client);
        },
        onLocalEditsDiscarded() {},
        onDirtyState() {},
        onFatalError() {
          fatalSignals.push(true);
        },
      });
      clients.push(client);
      if (options.fetchGate) releases.push(() => options.fetchGate.release());
      return { client, events, fatalSignals };
    },
    async bridge(client) {
      const attempts = await call('deliveries');
      assert.ok(Array.isArray(attempts));
      const transport = { fulfilled: 0, rejected: 0 };
      const rows = [];
      for (const attempt of attempts) {
        assert.ok(['primary', 'replay'].includes(attempt.subscriberId));
        assert.equal(attempt.generation, 1);
        assert.ok(
          Number.isSafeInteger(attempt.revision) && attempt.revision > 0 && attempt.revision <= 8,
        );
        if (attempt.result === 'rejected') {
          assert.equal(Object.hasOwn(attempt, 'row'), false);
          transport.rejected++;
          continue;
        }
        assert.equal(attempt.result, 'fulfilled');
        assert.equal(attempt.row.generation, attempt.generation);
        assert.equal(attempt.row.revision, attempt.revision);
        // Controller HTTP records are deliberately coupled to pushRow here.
        // This is not the application's real RPC subscriber or UI callback.
        assert.equal(client.pushRow(attempt.row), undefined);
        rows.push(attempt.row);
        transport.fulfilled++;
      }
      return { transport, rows };
    },
  };
}

async function ready(client, native) {
  client.setDurableState(baseSnapshot(native));
  await drain(client);
  assert.equal(client.isReady(), true);
  assert.equal(client.__evidenceSnapshot().fatal, false);
  assert.equal(client.__evidenceSnapshot().disposed, false);
}

function assertQuiescentMatch(native, client) {
  const model = client.__evidenceSnapshot();
  assert.equal(model.generation, native.generation);
  assert.equal(model.appliedRevision, native.revision);
  assert.equal(model.ready, true);
  assert.equal(model.fatal, false);
  assert.equal(model.disposed, false);
  assert.equal(client.isReady(), true);
}

before(async () => {
  startedAt = new Date().toISOString();
  runnerBytes = await readFile(runnerFile);
  runnerPin = {
    path: 'examples/subscription-server/paired.test.mjs',
    bytes: runnerBytes.length,
    sha256: createHash('sha256').update(runnerBytes).digest('hex'),
  };
  const commit = await execute('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    timeout: 2000,
    maxBuffer: 4096,
    encoding: 'utf8',
  });
  sourceBaseCommit = commit.stdout.trim();
  assert.match(sourceBaseCommit, /^[a-f0-9]{40}$/);
  consumerFixture = await buildConsumerFixture();
});
after(async (t) => {
  if (consumerFixture) {
    const final = await consumerFixture.dispose();
    assert.equal(final.sourceHashesStableAfterRunAndDisposal, true);
    assert.equal(final.tempBundleDisposed, true);
    assert.deepEqual(await readFile(runnerFile), runnerBytes);
    assert.equal(casesCompleted, 4);
    assert.equal(nativeFixturesDisposed, 4);
    assert.equal(consumersDisposed, 5);
    t.diagnostic(
      JSON.stringify({
        kind: 'paired-proof-lifecycle',
        nativeFixturesDisposed,
        consumersDisposed,
        consumerSourcesStableAfterDisposal: true,
        consumerBundleDisposed: true,
      }),
    );
    const evidenceBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'controlled-paired-native-producer-ot-model-boundary',
        startedAt,
        finishedAt: new Date().toISOString(),
        sourceBaseCommit,
        sourceTree: 'maintained-worktree-with-explicit-file-pins',
        upstreamCommit: '1ef6020a42fbabb6d27dd1063db3a075ba95c974',
        runnerPin,
        casesCompleted,
        nativeFixturesDisposed,
        consumersDisposed,
        runtimeDisposed: true,
        runnerBytesStableAfterExecution: true,
        consumer: final,
        native: nativeFinalMetadata,
        observations,
        limitations: [
          'Local controller HTTP and controlled subscriber facades, not actual RPC transport or the full application.',
          'The unchanged OT consumer receives actual fixed native accepted rows through an explicit Node bridge and controlled base-file delegate.',
          'A matching generation and revision with fatal=false, disposed=false and isReady=true after the stable queue establishes only the controlled quiescent internal OT state.',
          'Observed clocks are sample clocks, not commit or rendering timestamps.',
          'Existing fatal/readiness hooks, native retained-row reads and subscription replay already expose and recover these controlled boundaries.',
          'No issue305 reproduction, new recovery, novel diagnostic answer, production incidence or demand is established.',
        ],
      }),
    );
    // TAP escapes hashes and backslashes in diagnostics. An ASCII envelope
    // preserves the exact executed metadata, including private member names.
    t.diagnostic(
      `PAIRED_BOUNDARY_EVIDENCE ${JSON.stringify({
        schemaVersion: 1,
        encoding: 'base64url-json-utf8',
        bytes: evidenceBytes.length,
        sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
        data: evidenceBytes.toString('base64url'),
      })}`,
    );
  }
});

test(
  'A native committed row crosses the controller facade while the actual consumer base fetch is held, then reaches quiescent model state',
  { timeout: 20000 },
  async (t) => {
    const run = await caseFixture(t, 'held-base');
    const initial = await run.sample();
    const fetchGate = gate();
    const { client, fatalSignals } = run.client({ fetchGate });
    client.setDurableState(baseSnapshot(initial));
    await bounded(fetchGate.entered, 2000);
    await run.call('subscribe', { subscriberId: 'primary', rejectRevision: 0 });
    await run.call('append', {});
    const native = await run.sample();
    assert.equal(native.revision, 1);
    const delivered = await run.bridge(client);
    assert.deepEqual(delivered.transport, { fulfilled: 1, rejected: 0 });
    assert.equal(client.__evidenceSnapshot().appliedRevision, 0);
    assert.equal(client.__evidenceSnapshot().ready, false);
    assert.equal(client.isReady(), false);
    observation(
      t,
      'native-row-saved-pushRow-returned-work-pending',
      native,
      client,
      delivered.transport,
    );
    fetchGate.release();
    await drain(client);
    assertQuiescentMatch(native, client);
    assert.equal(content(client), delivered.rows[0].change[1][0][1].set);
    assert.equal(fatalSignals.length, 0);
    observation(
      t,
      'held-base-released-stable-queue-model-match',
      native,
      client,
      delivered.transport,
    );
    casesCompleted++;
  },
);

test(
  'Actual cold native eviction preserves retained rows; ordinary subscription replay and duplicate replay rebuild the model',
  { timeout: 20000 },
  async (t) => {
    const run = await caseFixture(t, 'cold-replay');
    await run.sample();
    await run.call('append', {});
    await run.call('append', {});
    const beforeEviction = await run.sample();
    assert.equal(beforeEviction.revision, 2);
    assert.deepEqual(
      beforeEviction.retained.map((row) => row.revision),
      [1, 2],
    );
    await bounded(run.server.evict());
    const afterEviction = await run.sample();
    assert.equal(afterEviction.generation, beforeEviction.generation);
    assert.equal(afterEviction.revision, beforeEviction.revision);
    assert.deepEqual(afterEviction.retained, beforeEviction.retained);
    assert.ok(afterEviction.instanceOrdinal > beforeEviction.instanceOrdinal);
    const { client, events } = run.client();
    await ready(client, afterEviction);
    await run.call('subscribe', { subscriberId: 'primary', rejectRevision: 0 });
    const replay = await run.bridge(client);
    assert.deepEqual(replay.transport, { fulfilled: 2, rejected: 0 });
    assert.deepEqual(
      replay.rows.map((row) => row.revision),
      [1, 2],
    );
    await drain(client);
    assertQuiescentMatch(afterEviction, client);
    assert.equal(content(client), replay.rows[1].change[1][0][1].set);
    observation(
      t,
      'cold-native-retained-row-replay-model-match',
      afterEviction,
      client,
      replay.transport,
    );
    const priorEvents = events.length;
    await run.call('subscribe', { subscriberId: 'replay', rejectRevision: 0 });
    const duplicate = await run.bridge(client);
    assert.deepEqual(duplicate.transport, { fulfilled: 2, rejected: 0 });
    await drain(client);
    assert.equal(events.length, priorEvents);
    assertQuiescentMatch(afterEviction, client);
    observation(
      t,
      'same-consumer-duplicate-replay-deduplicated',
      afterEviction,
      client,
      duplicate.transport,
    );
    casesCompleted++;
  },
);

test(
  'Controlled subscriber rejection leaves the native row saved; existing resubscription replay catches the consumer up',
  { timeout: 20000 },
  async (t) => {
    const run = await caseFixture(t, 'subscriber-rejection');
    const initial = await run.sample();
    const { client, fatalSignals } = run.client();
    await ready(client, initial);
    await run.call('subscribe', { subscriberId: 'primary', rejectRevision: 1 });
    await run.call('append', {});
    const rejected = await run.bridge(client);
    assert.deepEqual(rejected.transport, { fulfilled: 0, rejected: 1 });
    await drain(client);
    const native = await run.sample();
    assert.equal(native.revision, 1);
    assert.equal(native.retained.length, 1);
    assert.equal(native.subscriberCount, 0);
    assert.equal(client.__evidenceSnapshot().generation, native.generation);
    assert.equal(client.__evidenceSnapshot().appliedRevision, 0);
    assert.equal(client.isReady(), true);
    assert.equal(fatalSignals.length, 0);
    observation(
      t,
      'subscriber-facade-rejected-native-saved-consumer-behind',
      native,
      client,
      rejected.transport,
    );
    await run.call('subscribe', { subscriberId: 'replay', rejectRevision: 0 });
    const replay = await run.bridge(client);
    assert.deepEqual(replay.transport, { fulfilled: 1, rejected: 0 });
    await drain(client);
    assertQuiescentMatch(native, client);
    observation(t, 'ordinary-resubscription-replay-model-match', native, client, replay.transport);
    casesCompleted++;
  },
);

test(
  'Equal native/model positions can remain fatal after a downstream callback throws; retained native replay still supports a fresh client',
  { timeout: 20000 },
  async (t) => {
    const run = await caseFixture(t, 'downstream-failure');
    const initial = await run.sample();
    let beforeThrow;
    let beforeThrowReady;
    const { client, fatalSignals } = run.client({
      onRemote(events, active) {
        if (events.length) {
          beforeThrow = active.__evidenceSnapshot();
          beforeThrowReady = active.isReady();
          throw new Error('Controlled paired downstream callback failure');
        }
      },
    });
    await ready(client, initial);
    await run.call('subscribe', { subscriberId: 'primary', rejectRevision: 0 });
    await run.call('append', {});
    const delivered = await run.bridge(client);
    assert.deepEqual(delivered.transport, { fulfilled: 1, rejected: 0 });
    await drain(client);
    const native = await run.sample();
    assert.equal(beforeThrow.generation, native.generation);
    assert.equal(beforeThrow.appliedRevision, native.revision);
    assert.equal(beforeThrow.fatal, false);
    assert.equal(beforeThrowReady, true);
    assert.equal(client.__evidenceSnapshot().generation, native.generation);
    assert.equal(client.__evidenceSnapshot().appliedRevision, native.revision);
    assert.equal(client.__evidenceSnapshot().fatal, true);
    assert.equal(client.__evidenceSnapshot().disposed, false);
    assert.equal(client.isReady(), false);
    assert.equal(fatalSignals.length, 1);
    assert.equal(content(client), delivered.rows[0].change[1][0][1].set);
    observation(
      t,
      'equal-native-and-model-position-fatal-not-confirmed',
      native,
      client,
      delivered.transport,
    );
    await bounded(run.server.evict());
    const coldNative = await run.sample();
    assert.equal(coldNative.generation, native.generation);
    assert.equal(coldNative.revision, native.revision);
    assert.deepEqual(coldNative.retained, native.retained);
    assert.ok(coldNative.instanceOrdinal > native.instanceOrdinal);
    observation(
      t,
      'cold-native-read-preserves-position-original-consumer-still-fatal',
      coldNative,
      client,
    );
    const fresh = run.client();
    await ready(fresh.client, coldNative);
    await run.call('subscribe', { subscriberId: 'replay', rejectRevision: 0 });
    const replay = await run.bridge(fresh.client);
    await drain(fresh.client);
    assertQuiescentMatch(coldNative, fresh.client);
    assert.equal(fresh.fatalSignals.length, 0);
    assert.equal(client.__evidenceSnapshot().fatal, true);
    assert.equal(client.isReady(), false);
    observation(
      t,
      'fresh-consumer-existing-replay-quiescent-model-match',
      coldNative,
      fresh.client,
      replay.transport,
    );
    t.diagnostic(
      'Existing fatal/readiness signals, native retained-row reads and replay already expose these boundaries. This controlled coupling adds no general rendering acknowledgement or new recovery mechanism.',
    );
    casesCompleted++;
  },
);
