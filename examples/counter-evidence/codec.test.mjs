import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  COUNTER_SOURCE,
  CounterSamplesError,
  MAX_COUNTER_ARTIFACT_BYTES,
  MAX_COUNTER_SAMPLES,
  MAX_COUNTER_SAMPLE_BYTES,
  append,
  exportSamples,
  finish,
  importSamples,
  inspect,
  start,
} from './codec.mjs';
import { main, readBoundedFile } from './inspect.mjs';

const sample = (value = 0, at = 1000) => ({
  observedAt: at,
  receivedAt: at + 2,
  sourceRevision: null,
  sourceCommitAt: null,
  state: { value },
});
const record = () => finish(append(start(sample(), '3.13.0'), sample(1, 2000)), 'stopped', 2010);
const code = (expected) => (error) => {
  assert.ok(error instanceof CounterSamplesError);
  assert.equal(error.code, expected);
  return true;
};
const duplicate = (json, key, earlier, escaped = false) => {
  const finalKey = escaped
    ? '\\u' + key.charCodeAt(0).toString(16).padStart(4, '0') + key.slice(1)
    : key;
  return json.replace(
    JSON.stringify(key) + ':',
    JSON.stringify(key) + ':' + JSON.stringify(earlier) + ',"' + finalKey + '":',
  );
};

test('strict round-trip retains only discrete samples and the fixed source pin', async () => {
  assert.deepEqual(start(JSON.stringify(sample(), null, 2), '3.13.0'), start(sample(), '3.13.0'));
  const { artifact, json } = await exportSamples(record());
  assert.deepEqual(await importSamples(json), artifact);
  assert.deepEqual(artifact.source, COUNTER_SOURCE);
  assert.equal(artifact.coverage, 'discrete-read-samples');
  assert.equal(artifact.samples[0].sourceRevision, null);
  assert.equal(artifact.samples[1].sourceCommitAt, null);
  assert.match(artifact.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(json) < MAX_COUNTER_ARTIFACT_BYTES - 1024);
  assert.ok(Object.isFrozen(artifact.samples[0].state));
  assert.ok(Object.isFrozen(artifact.source));
  assert.ok(Object.isFrozen(artifact.end));
});

test('canonical hashing tolerates JSON key order but detects changed state', async () => {
  const { artifact } = await exportSamples(record());
  const reordered = Object.fromEntries(Object.entries(artifact).reverse());
  assert.deepEqual(await importSamples(JSON.stringify(reordered)), artifact);
  const changed = structuredClone(artifact);
  changed.samples[1].state.value = 2;
  await assert.rejects(importSamples(JSON.stringify(changed)), code('record-integrity'));
});

test('known root and nested duplicate keys cannot survive strict artifact import', async () => {
  const { artifact, json } = await exportSamples(record());
  for (const [key, earlier] of [
    ['schemaVersion', 1],
    ['contentHash', artifact.contentHash],
    ['commit', COUNTER_SOURCE.commit],
    ['observedAt', artifact.samples[0].observedAt],
    ['value', 0],
    ['reason', 'stopped'],
  ]) {
    const text = duplicate(json, key, earlier);
    assert.deepEqual(JSON.parse(text), artifact);
    await assert.rejects(importSamples(text), code('invalid-record'));
  }
});

test('escaped aliases cannot discard private earlier values behind valid fields and hash', async () => {
  const { artifact, json } = await exportSamples(record());
  const privateValue = { syntheticPrivate: { authorization: 'not-for-output' } };
  for (const key of ['samples', 'source', 'state', 'value', 'contentHash']) {
    const text = duplicate(json, key, privateValue, true);
    assert.deepEqual(JSON.parse(text), artifact);
    await assert.rejects(importSamples(text), (error) => {
      code('invalid-record')(error);
      assert.ok(!error.message.includes('not-for-output'));
      return true;
    });
  }
});

test('pretty, reordered and frozen runtime artifacts preserve their existing hashes and bytes', async () => {
  for (const [file, values] of [
    ['before-loss.json', [0, 0, 0]],
    ['after-loss.json', [0, 1, 1]],
  ]) {
    const text = await readFile(
      new URL('../../docs/evidence/counter-portability/' + file, import.meta.url),
      'utf8',
    );
    const artifact = await importSamples(text);
    assert.deepEqual(
      artifact.samples.map((item) => item.state.value),
      values,
    );
    const reordered = Object.fromEntries(Object.entries(artifact).reverse());
    assert.deepEqual(await importSamples(JSON.stringify(reordered, null, 2)), artifact);
    const { contentHash, ...body } = artifact;
    const exported = await exportSamples(body);
    assert.equal(exported.artifact.contentHash, contentHash);
    assert.equal(exported.json, text.trim());
    assert.ok(Object.isFrozen(artifact.samples[0].state));
  }
});

test('extra or private fields are rejected at every nested schema boundary', async () => {
  const { artifact } = await exportSamples(record());
  const additions = [
    (value) => (value.authorization = 'private'),
    (value) => (value.source.capability = 'private'),
    (value) => (value.samples[0].requestId = 'private'),
    (value) => (value.samples[0].state.headers = { secret: 'private' }),
    (value) => (value.end.path = 'private'),
  ];
  for (const add of additions) {
    const changed = structuredClone(artifact);
    add(changed);
    await assert.rejects(importSamples(JSON.stringify(changed)), CounterSamplesError);
  }
  assert.throws(() => start({ ...sample(), token: 'private' }, '3.13.0'), code('invalid-sample'));
  assert.throws(
    () => start({ ...sample(), state: { value: 0, secret: 'private' } }, '3.13.0'),
    code('invalid-sample'),
  );
});

test('unknown source pin, schema, kind and coverage are not accepted', async () => {
  const { artifact } = await exportSamples(record());
  const changes = [
    (value) => (value.source.commit = '0'.repeat(40)),
    (value) => (value.source.fileSHA256 = '0'.repeat(64)),
    (value) => (value.source.adapterVersion = 2),
    (value) => (value.schemaVersion = 2),
    (value) => (value.kind = 'edgelab-observer-recording'),
    (value) => (value.coverage = 'complete-history'),
  ];
  for (const change of changes) {
    const changed = structuredClone(artifact);
    change(changed);
    await assert.rejects(importSamples(JSON.stringify(changed)), code('invalid-record'));
  }
});

test('sample sequence is contiguous and wrapper clocks match first and last receipts', async () => {
  const { artifact } = await exportSamples(record());
  for (const change of [
    (value) => (value.samples[0].sequence = 0),
    (value) => (value.samples[1].sequence = 1),
    (value) => (value.samples[1].sequence = 3),
    (value) => (value.startedAt += 1),
    (value) => (value.lastReceivedAt += 1),
  ]) {
    const changed = structuredClone(artifact);
    change(changed);
    await assert.rejects(importSamples(JSON.stringify(changed)), CounterSamplesError);
  }
});

test('observation and receipt clock regression never reorders or invents source metadata', async () => {
  const first = { ...sample(1), observedAt: 3000, receivedAt: 4000 };
  const second = { ...sample(1), observedAt: 2000, receivedAt: 1000 };
  const captured = finish(append(start(first, '3.13.0'), second), 'interrupted', 500);
  const imported = await importSamples((await exportSamples(captured)).json);
  assert.deepEqual(
    imported.samples.map((item) => item.sequence),
    [1, 2],
  );
  const summary = inspect(imported);
  assert.equal(summary.observationClockRegressions, 1);
  assert.equal(summary.receiptClockRegressions, 1);
  assert.equal(summary.startedAt, 4000);
  assert.equal(summary.lastReceivedAt, 1000);
  assert.equal(summary.valueChanges, 0);
  assert.ok(Object.values(summary).every((value) => value === null || typeof value !== 'object'));
});

test('source revision and commit timestamps must remain explicitly null', async () => {
  for (const metadata of [
    { sourceRevision: 1 },
    { sourceCommitAt: 1000 },
    { sourceRevision: undefined },
  ])
    assert.throws(() => start({ ...sample(), ...metadata }, '3.13.0'), code('invalid-sample'));
  const { artifact } = await exportSamples(record());
  const changed = structuredClone(artifact);
  delete changed.samples[0].sourceRevision;
  await assert.rejects(importSamples(JSON.stringify(changed)), CounterSamplesError);
});

test('counter values, timestamps and producer version have strict finite bounds', () => {
  for (const value of [NaN, Infinity, 1.5, 1_000_000_001, -1_000_000_001, '1'])
    assert.throws(() => start(sample(value), '3.13.0'), code('invalid-sample'));
  for (const at of [-1, 1.5, NaN, Infinity, 8_640_000_000_000_001])
    assert.throws(() => start(sample(0, at), '3.13.0'), code('invalid-sample'));
  for (const version of ['01.0.0', '1.0', '1.0.0-01', '1.0.0-secret\n', '1.0.0+' + 'x'.repeat(33)])
    assert.throws(() => start(sample(), version), code('invalid-record'));
  for (const value of [-1_000_000_000, 1_000_000_000])
    assert.equal(start(sample(value), '1.0.0-rc.1+local').samples[0].state.value, value);
});

test('invalid and oversized append closes the unchanged valid prefix', () => {
  const captured = start(sample(), '3.13.0');
  for (const invalid of [
    { ...sample(1), state: { value: 1, token: 'secret' } },
    ' '.repeat(MAX_COUNTER_SAMPLE_BYTES) + JSON.stringify(sample(1)),
    'not-json',
  ]) {
    const closed = append(captured, invalid);
    assert.deepEqual(closed.samples, captured.samples);
    assert.deepEqual(closed.end, { reason: 'invalid-sample', at: null });
    assert.equal(captured.end, null);
    assert.ok(Object.isFrozen(closed.samples[0].state));
  }
});

test('duplicate raw samples safely close the unchanged valid prefix', async () => {
  const captured = start(sample(), '3.13.0');
  const json = JSON.stringify(sample(1, 2000));
  for (const [key, earlier, escaped] of [
    ['receivedAt', 2002, false],
    ['state', { syntheticPrivate: 'not-for-output' }, true],
    ['value', { syntheticPrivate: 'not-for-output' }, true],
  ]) {
    const text = duplicate(json, key, earlier, escaped);
    assert.deepEqual(JSON.parse(text), sample(1, 2000));
    assert.throws(() => start(text, '3.13.0'), code('invalid-sample'));
    const closed = append(captured, text);
    assert.deepEqual(closed.samples, captured.samples);
    assert.deepEqual(closed.end, { reason: 'invalid-sample', at: null });
    assert.equal(captured.end, null);
    assert.ok(Object.isFrozen(closed.samples[0].state));
    const exported = await exportSamples(closed);
    assert.ok(!exported.json.includes('not-for-output'));
    assert.deepEqual(await importSamples(exported.json), exported.artifact);
  }
});

test('32 samples close at the sample limit and cannot be reopened or appended', () => {
  let captured = start(sample(), '3.13.0');
  for (let index = 1; index < MAX_COUNTER_SAMPLES; index++)
    captured = append(captured, sample(index, index * 1000));
  assert.equal(captured.samples.length, MAX_COUNTER_SAMPLES);
  assert.deepEqual(captured.end, { reason: 'sample-limit', at: 31_002 });
  assert.deepEqual(append(captured, sample(99)), captured);
  assert.deepEqual(finish(captured, 'stopped', 40_000), captured);
  const copied = append(structuredClone(captured), sample(99));
  assert.ok(Object.isFrozen(copied.samples[0].state));
});

test('capture does not retain input aliases and export freezes a clone before hashing', async () => {
  const input = sample();
  const captured = start(input, '3.13.0');
  input.state.value = 99;
  assert.equal(captured.samples[0].state.value, 0);
  assert.throws(() => (captured.samples[0].state.value = 5), TypeError);
  const mutable = structuredClone(finish(captured, 'stopped', null));
  const exporting = exportSamples(mutable);
  mutable.samples[0].state.value = 99;
  mutable.end.reason = 'read-failed';
  const { artifact, json } = await exporting;
  assert.equal(artifact.samples[0].state.value, 0);
  assert.equal(artifact.end.reason, 'stopped');
  assert.deepEqual(await importSamples(json), artifact);
});

test('open exports, impossible end reason and malformed hashes are rejected', async () => {
  const captured = start(sample(), '3.13.0');
  await assert.rejects(exportSamples(captured), code('record-open'));
  assert.throws(() => finish(captured, 'sample-limit', 1000), code('invalid-record'));
  assert.throws(() => finish(captured, 'complete', 1000), code('invalid-record'));
  assert.throws(() => finish(captured, 'stopped', Infinity), code('invalid-record'));
  const { artifact } = await exportSamples(record());
  for (const hash of ['', 'A'.repeat(64), '0'.repeat(63), null])
    await assert.rejects(
      importSamples(JSON.stringify({ ...artifact, contentHash: hash })),
      code('invalid-record'),
    );
});

test('empty, excess-sample, oversized and non-JSON artifacts fail safely', async () => {
  const { artifact, json } = await exportSamples(record());
  await assert.rejects(
    importSamples(' '.repeat(MAX_COUNTER_ARTIFACT_BYTES + 1)),
    code('record-size'),
  );
  await assert.rejects(
    importSamples(json + ' '.repeat(MAX_COUNTER_ARTIFACT_BYTES)),
    code('record-size'),
  );
  await assert.rejects(importSamples('private invalid JSON'), code('invalid-record'));
  await assert.rejects(
    importSamples(JSON.stringify({ ...artifact, samples: [] })),
    code('invalid-record'),
  );
  await assert.rejects(
    importSamples(
      JSON.stringify({
        ...artifact,
        samples: Array(MAX_COUNTER_SAMPLES + 1).fill(artifact.samples[0]),
      }),
    ),
    code('record-size'),
  );
});

test('offline CLI reads bounded UTF-8 and never prints rejected file content or paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'counter-evidence-'));
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value) => logs.push(value);
  console.error = (value) => errors.push(value);
  try {
    const path = join(directory, 'private-filename.json');
    await writeFile(path, (await exportSamples(record())).json);
    assert.equal(await main([path]), 0);
    assert.match(logs[0], /Source revision and source commit time: unavailable/);
    assert.match(logs[0], /does not establish authenticity/);
    assert.match(logs[0], /Observation clock/);
    assert.match(logs[0], /Recorder receipt clock/);
    await writeFile(path, 'private-contents ' + ' '.repeat(MAX_COUNTER_ARTIFACT_BYTES));
    await assert.rejects(readBoundedFile(path));
    assert.equal(await main([path]), 1);
    await writeFile(path, Buffer.from([0xff]));
    await assert.rejects(readBoundedFile(path));
    assert.equal(await main([]), 1);
    assert.equal(await main([path, path]), 1);
    assert.equal(await main([join(directory, 'missing-private-file')]), 1);
    assert.ok(!errors.join('\n').includes('private-'));
    assert.ok(!logs.join('\n').includes(directory));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});
