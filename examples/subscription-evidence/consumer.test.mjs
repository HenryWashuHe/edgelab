import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildConsumerFixture } from './fixture.mjs';

let fixture;
const clients = new Set();
const deadlineMs = 2000;

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Controlled signal deadline exceeded')),
          deadlineMs,
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

function durable(generation = 1, rowsThrough = 0, epochChange, baseCommit = 'fixture-base') {
  return {
    codeBase: { pins: [{ gadgetId: 1, baseCommit }], generation, revision: rowsThrough },
    rowsThrough,
    ...(epochChange === undefined ? {} : { epochChange }),
  };
}
const set = (value) => ({ 1: [['index.txt', { set: value }]] });
const row = (revision, value, generation = 1) => ({
  generation,
  revision,
  author: { type: 'controlled-fixture' },
  change: set(value),
});
const text = (client) => client.getFiles(1)?.get('index.txt');
const drain = (client) => bounded(client.__evidenceDrain());

function observation(
  t,
  phase,
  client,
  model = client.__evidenceSnapshot(),
  isReady = client.isReady(),
) {
  t.diagnostic(JSON.stringify({ kind: 'ot-model-observation', phase, ...model, isReady }));
}

function clientFor(t, options = {}) {
  const record = {
    fetches: [],
    remoteEvents: [],
    fatals: 0,
    discarded: 0,
    submissions: 0,
    dirty: [],
  };
  const delegate = {
    async fetchCommitFiles(commit) {
      record.fetches.push(commit);
      return options.fetch ? options.fetch(commit) : new Map([['index.txt', 'base']]);
    },
    async submitCodeChange() {
      record.submissions++;
      throw new Error('Unexpected controlled submission');
    },
    isTransientError() {
      return false;
    },
    onRemoteChange(events) {
      record.remoteEvents.push(
        events.map((event) => ({
          gadgetId: event.gadgetId,
          path: event.path,
          change: structuredClone(event.change),
        })),
      );
      options.onRemote?.(events, client);
    },
    onLocalEditsDiscarded() {
      record.discarded++;
    },
    onDirtyState(value) {
      record.dirty.push(value);
    },
    onFatalError() {
      record.fatals++;
    },
  };
  const client = new fixture.ChatOtClient(delegate);
  clients.add(client);
  t.after(async () => {
    client.dispose();
    options.release?.();
    await drain(client);
    clients.delete(client);
    assert.equal(record.submissions, 0, 'The controlled proof must not submit commands');
    assert.equal(client.__evidenceSnapshot().disposed, true);
  });
  return { client, record };
}

async function ready(client, snapshot = durable()) {
  client.setDurableState(snapshot);
  await drain(client);
  assert.equal(client.isReady(), true);
}

before(async () => {
  fixture = await buildConsumerFixture();
});
after(async () => {
  for (const client of clients) client.dispose();
  if (fixture) {
    const final = await fixture.dispose();
    assert.equal(final.sourceHashesStableAfterRunAndDisposal, true);
    assert.equal(final.tempBundleDisposed, true);
  }
});

test('The exact pinned pure modules run with a disclosed read-only probe and complete dependency graph', (t) => {
  const proof = fixture.evidence;
  assert.equal(proof.upstreamCommit, '1ef6020a42fbabb6d27dd1063db3a075ba95c974');
  assert.equal(proof.graph.length, 5);
  assert.equal(proof.runtimeApiImports, 0);
  assert.equal(proof.domProvided, false);
  assert.equal(proof.adaptation.privateStateWrites, false);
  assert.equal(proof.graph.filter((item) => item.sha256 !== item.suppliedSha256).length, 1);
  assert.deepEqual(
    proof.dependencies.map((item) => [item.name, item.version]).sort(),
    [
      ['@codemirror/state', '6.7.1'],
      ['@marijn/find-cluster-break', '1.0.3'],
      ['fast-diff', '1.3.0'],
    ].sort(),
  );
  t.diagnostic(
    `Actual Node ${proof.environment.node}; platform ${proof.environment.platform}; esbuild ${proof.environment.esbuild}; 5 runtime inputs; no runtime API import or DOM supplied.`,
  );
  t.diagnostic(
    `Executed bundle ${proof.bundle.bytes} bytes; SHA256 ${proof.bundle.sha256}; original upstream files are separately pinned.`,
  );
});

test('pushRow returns with work pending while the initial base fetch is held, then advances the actual model', async (t) => {
  const fetchGate = gate();
  const { client, record } = clientFor(t, {
    fetch: () => fetchGate.wait(new Map([['index.txt', 'base']])),
    release: () => fetchGate.release(),
  });
  client.setDurableState(durable());
  await bounded(fetchGate.entered);
  client.pushRow(row(1, 'row-1'));
  assert.deepEqual(client.__evidenceSnapshot(), {
    generation: 0,
    appliedRevision: 0,
    ready: false,
    fatal: false,
    disposed: false,
  });
  assert.equal(text(client), undefined);
  assert.equal(record.remoteEvents.length, 0);
  observation(t, 'pushRow-returned-before-base-release', client);
  fetchGate.release();
  await drain(client);
  assert.equal(client.__evidenceSnapshot().appliedRevision, 1);
  assert.equal(text(client), 'row-1');
  assert.equal(client.isReady(), true);
  assert.equal(record.fatals, 0);
  observation(t, 'queue-drained-after-base-release', client);
  t.diagnostic(
    'Signal barrier distinguishes pushRow returning with pending work from internal OT-model application; no RPC callback or rendering acknowledgement is inferred.',
  );
});

test('A missing revision holds later rows; ordered replay fills the gap and identical redelivery is deduplicated', async (t) => {
  const { client, record } = clientFor(t);
  await ready(client);
  client.pushRow(row(2, 'row-2'));
  client.pushRow(row(2, 'row-2'));
  await drain(client);
  assert.equal(client.__evidenceSnapshot().appliedRevision, 0);
  assert.equal(text(client), 'base');
  assert.equal(record.remoteEvents.length, 1);
  client.pushRow(row(1, 'row-1'));
  await drain(client);
  assert.equal(client.__evidenceSnapshot().appliedRevision, 2);
  assert.equal(text(client), 'row-2');
  assert.deepEqual(
    record.remoteEvents.slice(1).map((events) => events[0].change.set),
    ['row-1', 'row-2'],
  );
  client.pushRow(row(1, 'row-1'));
  client.pushRow(row(2, 'row-2'));
  await drain(client);
  assert.equal(record.remoteEvents.length, 3);
  assert.equal(record.fatals, 0);
  t.diagnostic(
    'Actual generation/revision queue drains 1 then 2; identical redelivery causes no extra remote callback. Conflicting duplicate authenticity is outside this proof.',
  );
});

test('An invalid text operation fails before its revision advances and leaves the prior model fatal', async (t) => {
  const { client, record } = clientFor(t);
  await ready(client);
  client.pushRow(row(1, 'row-1'));
  await drain(client);
  client.pushRow({
    generation: 1,
    revision: 2,
    author: { type: 'controlled-fixture' },
    change: { 1: [['index.txt', { edit: [99] }]] },
  });
  await drain(client);
  assert.deepEqual(client.__evidenceSnapshot(), {
    generation: 1,
    appliedRevision: 1,
    ready: true,
    fatal: true,
    disposed: false,
  });
  assert.equal(client.isReady(), false);
  assert.equal(text(client), 'row-1');
  assert.equal(record.fatals, 1);
  observation(t, 'invalid-text-application-failed', client);
  client.pushRow(row(2, 'replacement'));
  await drain(client);
  assert.equal(client.__evidenceSnapshot().appliedRevision, 1);
  assert.equal(text(client), 'row-1');
  assert.equal(record.fatals, 1);
  t.diagnostic(
    'Real CodeMirror text-length validation fails; the prior model revision remains unchanged and the fatal client does not automatically apply another row.',
  );
});

test('A downstream callback can fail after the internal model revision advanced; isReady then reports fatal', async (t) => {
  let observedAtCallback;
  let callbackValue;
  let callbackReady;
  const { client, record } = clientFor(t, {
    onRemote(events, active) {
      if (events.length) {
        observedAtCallback = active.__evidenceSnapshot();
        callbackValue = text(active);
        callbackReady = active.isReady();
        throw new Error('Controlled downstream callback failure');
      }
    },
  });
  await ready(client);
  client.pushRow(row(1, 'row-1'));
  await drain(client);
  assert.deepEqual(observedAtCallback, {
    generation: 1,
    appliedRevision: 1,
    ready: true,
    fatal: false,
    disposed: false,
  });
  assert.equal(callbackValue, 'row-1');
  assert.deepEqual(client.__evidenceSnapshot(), {
    generation: 1,
    appliedRevision: 1,
    ready: true,
    fatal: true,
    disposed: false,
  });
  assert.equal(client.isReady(), false);
  assert.equal(record.fatals, 1);
  assert.equal(text(client), 'row-1');
  observation(
    t,
    'downstream-callback-before-controlled-throw',
    client,
    observedAtCallback,
    callbackReady,
  );
  observation(t, 'downstream-callback-after-queue-catch', client);
  t.diagnostic(
    'appliedRevision is an internal model watermark, not proof that a downstream callback or renderer completed.',
  );
});

test('A future-generation row waits for the corresponding generation metadata before application', async (t) => {
  const { client, record } = clientFor(t, {
    fetch: (commit) =>
      new Map([['index.txt', commit === 'fixture-new-base' ? 'new-base' : 'base']]),
  });
  await ready(client);
  client.pushRow(row(1, 'future-row', 2));
  await drain(client);
  assert.equal(client.__evidenceSnapshot().generation, 1);
  assert.equal(client.__evidenceSnapshot().appliedRevision, 0);
  assert.equal(text(client), 'base');
  client.setDurableState(durable(2, 0, undefined, 'fixture-new-base'));
  await drain(client);
  assert.equal(client.__evidenceSnapshot().generation, 2);
  assert.equal(client.__evidenceSnapshot().appliedRevision, 1);
  assert.equal(text(client), 'future-row');
  assert.equal(record.fetches.length, 2);
  assert.equal(record.fatals, 0);
  t.diagnostic(
    'The actual client holds the future-generation row; a controlled destructive-generation snapshot enables its later application.',
  );
});

test('The existing materialized-watermark path rebuilds missing delivered rows without waiting for its grace timer', async (t) => {
  const { client, record } = clientFor(t);
  await ready(client);
  assert.equal(record.fetches.length, 1);
  observation(t, 'before-materialized-watermark-recovery', client);
  client.setDurableState(durable(1, 2, set('materialized-2')));
  await drain(client);
  assert.deepEqual(client.__evidenceSnapshot(), {
    generation: 1,
    appliedRevision: 2,
    ready: true,
    fatal: false,
    disposed: false,
  });
  assert.equal(text(client), 'materialized-2');
  assert.equal(record.fetches.length, 2);
  assert.equal(record.remoteEvents.length, 2);
  assert.deepEqual(record.remoteEvents, [[], []]);
  assert.equal(client.isReady(), true);
  observation(t, 'after-materialized-watermark-recovery', client);
  t.diagnostic(
    'Existing upstream recovery consumes the supplied materialized snapshot immediately when no unsynced local edits are at risk; no synthetic row replay or sleep is used.',
  );
});

test('A fresh client reconstructs the same materialized model without receiving individual rows', async (t) => {
  const { client, record } = clientFor(t);
  await ready(client, durable(1, 2, set('materialized-2')));
  assert.equal(client.__evidenceSnapshot().appliedRevision, 2);
  assert.equal(text(client), 'materialized-2');
  assert.equal(record.fetches.length, 1);
  assert.deepEqual(record.remoteEvents, [[]]);
  assert.equal(record.fatals, 0);
  t.diagnostic(
    'New-client rebuild is an existing upstream mechanism under controlled metadata/base delegates; this is not an EdgeLab-added recovery feature.',
  );
});

test('Disposal during a held fetch prevents a late base result from making the model ready', async (t) => {
  const fetchGate = gate();
  const { client, record } = clientFor(t, {
    fetch: () => fetchGate.wait(new Map([['index.txt', 'base']])),
    release: () => fetchGate.release(),
  });
  client.setDurableState(durable());
  await bounded(fetchGate.entered);
  client.dispose();
  fetchGate.release();
  await drain(client);
  assert.deepEqual(client.__evidenceSnapshot(), {
    generation: 0,
    appliedRevision: 0,
    ready: false,
    fatal: false,
    disposed: true,
  });
  assert.equal(text(client), undefined);
  assert.equal(record.remoteEvents.length, 0);
  assert.equal(record.fatals, 0);
  t.diagnostic(
    'Every controlled client is disposed; held delegates are released through owned barriers and observed with a bounded queue drain.',
  );
});

test('All exact upstream, dependency, recipe and foundation input bytes remain unchanged after consumer execution', async (t) => {
  await fixture.assertStable();
  t.diagnostic(
    'Byte-for-byte source stability is checked after execution and again after temporary-bundle disposal in the final hook; no full app, server or network path was run.',
  );
});
