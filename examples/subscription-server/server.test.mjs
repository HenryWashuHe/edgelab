import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServerFixture } from './fixture.mjs';

async function fixtureFor(t) {
  const fixture = await buildServerFixture();
  t.after(async () => {
    const final = await fixture.dispose();
    assert.equal(final.sourceStableAfterRunAndDisposal, true);
    assert.equal(final.tempRuntimeDisposed, true);
  });
  return fixture;
}

test('Exact pinned producer/replay bodies and original typed storage execute on native SQLite DO KV', async (t) => {
  const fixture = await fixtureFor(t);
  const sample = await fixture.call('sample');
  assert.equal(sample.sqlProbe, 1);
  assert.equal(sample.instanceOrdinal, 1);
  assert.equal(sample.generation, 1);
  assert.equal(sample.revision, 0);
  assert.deepEqual(sample.codeBase.pins, [{ gadgetId: 1, baseCommit: 'fixture-base' }]);
  assert.deepEqual(sample.retained, []);
  const replay = fixture.evidence.extraction.find((item) => item.name === 'subscribeToChat');
  assert.deepEqual([replay.startLine, replay.endLine], [9874, 9974]);
  assert.equal(
    fixture.evidence.extraction.some((item) => item.name === '#appendChatChangeRow'),
    true,
  );
  assert.equal(fixture.evidence.graph.length, 3);
  t.diagnostic(
    `Native SQLite DO; exact typed-storage; complete subscribeToChat lines ${replay.startLine}..${replay.endLine}; server bundle ${fixture.evidence.bundle.bytes} bytes SHA256 ${fixture.evidence.bundle.sha256}.`,
  );
});

test('Accepted rows persist and broadcast through the actual append tail; ordinary unsubscribe stops code and metadata callbacks', async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.call('subscribe', { subscriberId: 'primary' });
  assert.deepEqual(await fixture.call('append', {}), {
    status: 'accepted',
    generation: 1,
    revision: 1,
  });
  const before = await fixture.call('sample');
  assert.equal(before.revision, 1);
  assert.equal(before.subscriberCount, 1);
  assert.deepEqual(before.retained, [{ generation: 1, revision: 1, retired: false }]);
  const deliveries = await fixture.call('deliveries');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].result, 'fulfilled');
  assert.deepEqual(deliveries[0].row, {
    generation: 1,
    revision: 1,
    author: { type: 'agent', id: 'controlled-fixture', name: 'Controlled fixture' },
    change: { 1: [['index.txt', { set: 'row-1' }]] },
  });
  await fixture.call('unsubscribe', { subscriberId: 'primary' });
  await fixture.call('append', {});
  const after = await fixture.call('sample');
  assert.equal(after.revision, 2);
  assert.equal(after.subscriberCount, 0);
  assert.equal(after.attempts.length, 1);
  assert.equal(after.notifications.length, before.notifications.length);
  assert.deepEqual(await fixture.call('deliveries'), []);
});

test('An original live callback rejection removes its subscriber while accepted storage advances; resubscription replays retained rows', async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.call('subscribe', { subscriberId: 'primary', rejectRevision: 1 });
  await fixture.call('append', {});
  const rejected = await fixture.call('sample');
  assert.equal(rejected.revision, 1);
  assert.equal(rejected.subscriberCount, 0);
  assert.equal(rejected.disposals, 1);
  assert.deepEqual(await fixture.call('deliveries'), [
    { subscriberId: 'primary', generation: 1, revision: 1, result: 'rejected' },
  ]);
  await fixture.call('append', {});
  const ahead = await fixture.call('sample');
  assert.equal(ahead.revision, 2);
  assert.equal(ahead.attempts.length, 1);
  await fixture.call('subscribe', { subscriberId: 'replay' });
  const replay = await fixture.call('deliveries');
  assert.deepEqual(
    replay.map((item) => [item.subscriberId, item.result, item.row.generation, item.row.revision]),
    [
      ['replay', 'fulfilled', 1, 1],
      ['replay', 'fulfilled', 1, 2],
    ],
  );
  assert.equal((await fixture.call('sample')).subscriberCount, 1);
});

test('Complete subscribe catch-up retains message-before-metadata ordering and excludes retired rows; replay ignores startAfter', async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.call('append', {});
  await fixture.call('append', {});
  await fixture.call('retire', { throughRevision: 1 });
  await fixture.call('message', {});
  await fixture.call('subscribe', { subscriberId: 'primary', startAfter: 0 });
  const sample = await fixture.call('sample');
  assert.deepEqual(
    sample.notifications.map((item) => item.kind),
    ['stream', 'message', 'metadata'],
  );
  assert.deepEqual(sample.retained, [
    { generation: 1, revision: 1, retired: true },
    { generation: 1, revision: 2, retired: false },
  ]);
  assert.deepEqual(
    (await fixture.call('deliveries')).map((item) => item.revision),
    [2],
  );
  await fixture.call('subscribe', { subscriberId: 'replay', startAfter: Date.now() + 60000 });
  assert.deepEqual(
    (await fixture.call('deliveries')).map((item) => item.revision),
    [2],
  );
  assert.deepEqual(
    (await fixture.call('sample')).notifications.slice(3).map((item) => item.kind),
    ['stream'],
  );
  t.diagnostic(
    'Retirement is an actual extracted row-retire method; fixed message seeding is a controlled input, not real materialization. No lost-row gap is manufactured by disabling recovery.',
  );
});

test('Replay rejection uses complete unsubscribe and a controlled transport break follows the original onRpcBroken cleanup', async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.call('append', {});
  await fixture.call('subscribe', { subscriberId: 'primary', rejectRevision: 1 });
  const rejected = await fixture.call('sample');
  assert.equal(rejected.subscriberCount, 0);
  assert.equal(rejected.disposals, 1);
  await fixture.call('append', {});
  const after = await fixture.call('sample');
  assert.equal(after.attempts.length, 1);
  assert.equal(after.notifications.length, rejected.notifications.length);
  await fixture.call('subscribe', { subscriberId: 'replay' });
  await fixture.call('break', { subscriberId: 'replay' });
  const broken = await fixture.call('sample');
  assert.equal(broken.subscriberCount, 0);
  await fixture.call('append', {});
  const stopped = await fixture.call('sample');
  assert.equal(stopped.attempts.length, broken.attempts.length);
  assert.equal(stopped.notifications.length, broken.notifications.length);
});

test('Native sync and actual eviction reconstruct a new instance while durable chat positions and replay rows survive', async (t) => {
  const fixture = await fixtureFor(t);
  await fixture.call('subscribe', { subscriberId: 'primary' });
  await fixture.call('append', {});
  await fixture.call('append', {});
  const before = await fixture.call('sample');
  const acceptedRows = (await fixture.call('deliveries')).map((item) => item.row);
  assert.deepEqual(
    acceptedRows,
    [1, 2].map((revision) => ({
      generation: 1,
      revision,
      author: { type: 'agent', id: 'controlled-fixture', name: 'Controlled fixture' },
      change: { 1: [['index.txt', { set: `row-${revision}` }]] },
    })),
  );
  await fixture.evict();
  const after = await fixture.call('sample');
  assert.equal(after.sqlProbe, 1);
  assert.equal(after.instanceOrdinal, before.instanceOrdinal + 1);
  assert.equal(after.generation, before.generation);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.codeBase, before.codeBase);
  assert.deepEqual(after.retained, before.retained);
  assert.equal(after.subscriberCount, 0);
  assert.deepEqual(after.attempts, []);
  assert.deepEqual(after.notifications, []);
  await fixture.call('subscribe', { subscriberId: 'replay' });
  assert.deepEqual(
    (await fixture.call('deliveries')).map((item) => item.row),
    acceptedRows,
  );
  await fixture.call('append', {});
  assert.equal((await fixture.call('sample')).revision, 3);
  assert.deepEqual(
    (await fixture.call('deliveries')).map((item) => item.row.revision),
    [3],
  );
  t.diagnostic(
    'Actual reconstructed instance is proved by constructor-only instanceOrdinal, independently of the upstream Date.now streamGeneration timestamp. Durable chat generation stays 1 and revisions survive.',
  );
});
