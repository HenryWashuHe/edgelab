import { webcrypto } from 'node:crypto';

export const MAX_COUNTER_SAMPLES = 32;
export const MAX_COUNTER_ARTIFACT_BYTES = 32 * 1024;
export const COUNTER_FINALIZATION_RESERVE = 1024;
export const MAX_COUNTER_SAMPLE_BYTES = 1024;
export const COUNTER_SOURCE = Object.freeze({
  example: 'cloudflare-build-a-counter-js',
  commit: '976c80e2120fdea5b4e1b1dd0eff2683802da981',
  fileSHA256: '1c7c0f960a1f9b91b0b7488fc228208d8ec2a39fdfaf0d89b553184fae9151a6',
  adapterVersion: 1,
});
const reasons = ['stopped', 'read-failed', 'invalid-sample', 'interrupted', 'sample-limit'];
const sampleKeys = ['observedAt', 'receivedAt', 'sourceRevision', 'sourceCommitAt', 'state'];
const bodyKeys = [
  'schemaVersion',
  'kind',
  'producerVersion',
  'source',
  'coverage',
  'startedAt',
  'lastReceivedAt',
  'samples',
  'end',
];
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).byteLength;
const timestamp = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) =>
  object(value) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const validVersion = (value) =>
  typeof value === 'string' &&
  value.length <= 32 &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  ) &&
  !value
    .split('+')[0]
    .split('-')
    .slice(1)
    .join('-')
    .split('.')
    .some((part) => /^0\d+$/.test(part));

export class CounterSamplesError extends Error {
  constructor(code) {
    const messages = {
      'invalid-record': 'The counter sample record could not be validated.',
      'invalid-sample': 'The counter read sample could not be validated.',
      'record-size': 'The counter samples exceed their fixed size or sample limit.',
      'record-open': 'Finish the counter samples before exporting.',
      'record-integrity': 'The counter sample content hash does not match.',
    };
    super(messages[code] ?? messages['invalid-record']);
    this.name = 'CounterSamplesError';
    this.code = code;
  }
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') +
    '}'
  );
}
function freeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function sampleFrom(input, sequence) {
  try {
    if (typeof input === 'string') {
      if (bytes(input) > MAX_COUNTER_SAMPLE_BYTES) throw new Error();
      input = JSON.parse(input);
    }
    if (
      !exact(input, sequence === undefined ? sampleKeys : ['sequence', ...sampleKeys]) ||
      (sequence !== undefined && input.sequence !== sequence) ||
      !timestamp(input.observedAt) ||
      !timestamp(input.receivedAt) ||
      input.sourceRevision !== null ||
      input.sourceCommitAt !== null ||
      !exact(input.state, ['value']) ||
      !Number.isSafeInteger(input.state.value) ||
      Math.abs(input.state.value) > 1_000_000_000
    )
      throw new Error();
    const sample = {
      ...(sequence === undefined ? {} : { sequence }),
      observedAt: input.observedAt,
      receivedAt: input.receivedAt,
      sourceRevision: null,
      sourceCommitAt: null,
      state: { value: input.state.value },
    };
    if (bytes(canonical(sample)) > MAX_COUNTER_SAMPLE_BYTES) throw new Error();
    return sample;
  } catch {
    throw new CounterSamplesError('invalid-sample');
  }
}
function bodyFrom(value, artifact = false) {
  try {
    if (
      !exact(value, artifact ? [...bodyKeys, 'contentHash'] : bodyKeys) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'edgelab-counter-samples' ||
      !validVersion(value.producerVersion) ||
      !exact(value.source, Object.keys(COUNTER_SOURCE)) ||
      !Object.entries(COUNTER_SOURCE).every(([key, expected]) => value.source[key] === expected) ||
      value.coverage !== 'discrete-read-samples' ||
      !timestamp(value.startedAt) ||
      !timestamp(value.lastReceivedAt) ||
      !Array.isArray(value.samples) ||
      value.samples.length < 1
    )
      throw new CounterSamplesError('invalid-record');
    if (value.samples.length > MAX_COUNTER_SAMPLES) throw new CounterSamplesError('record-size');
    const samples = value.samples.map((sample, index) => {
      if (!object(sample)) throw new CounterSamplesError('invalid-record');
      return sampleFrom(sample, index + 1);
    });
    if (
      value.startedAt !== samples[0].receivedAt ||
      value.lastReceivedAt !== samples.at(-1).receivedAt
    )
      throw new CounterSamplesError('invalid-record');
    let end = null;
    if (value.end !== null) {
      if (
        !exact(value.end, ['reason', 'at']) ||
        !reasons.includes(value.end.reason) ||
        (value.end.at !== null && !timestamp(value.end.at)) ||
        (value.end.reason === 'sample-limit' && samples.length !== MAX_COUNTER_SAMPLES)
      )
        throw new CounterSamplesError('invalid-record');
      end = { reason: value.end.reason, at: value.end.at };
    }
    if (artifact && end === null) throw new CounterSamplesError('record-open');
    const body = {
      schemaVersion: 1,
      kind: 'edgelab-counter-samples',
      producerVersion: value.producerVersion,
      source: { ...COUNTER_SOURCE },
      coverage: 'discrete-read-samples',
      startedAt: value.startedAt,
      lastReceivedAt: value.lastReceivedAt,
      samples,
      end,
    };
    if (
      bytes(canonical({ ...body, end: null })) >
      MAX_COUNTER_ARTIFACT_BYTES - COUNTER_FINALIZATION_RESERVE
    )
      throw new CounterSamplesError('record-size');
    return body;
  } catch (error) {
    if (error instanceof CounterSamplesError) throw error;
    throw new CounterSamplesError('invalid-record');
  }
}
export function start(sample, producerVersion) {
  if (!validVersion(producerVersion)) throw new CounterSamplesError('invalid-record');
  const parsed = sampleFrom(sample);
  return freeze(
    bodyFrom({
      schemaVersion: 1,
      kind: 'edgelab-counter-samples',
      producerVersion,
      source: COUNTER_SOURCE,
      coverage: 'discrete-read-samples',
      startedAt: parsed.receivedAt,
      lastReceivedAt: parsed.receivedAt,
      samples: [{ sequence: 1, ...parsed }],
      end: null,
    }),
  );
}
export function finish(record, reason, at) {
  const body = bodyFrom(record);
  if (body.end) return freeze(body);
  return freeze(bodyFrom({ ...body, end: { reason, at } }));
}
/** A failed append closes the unchanged valid prefix; samples never reorder. */
export function append(record, input) {
  const body = bodyFrom(record);
  if (body.end) return freeze(body);
  if (body.samples.length >= MAX_COUNTER_SAMPLES)
    return finish(body, 'sample-limit', body.lastReceivedAt);
  let sample;
  try {
    sample = sampleFrom(input);
  } catch {
    return finish(body, 'invalid-sample', null);
  }
  const next = bodyFrom({
    ...body,
    lastReceivedAt: sample.receivedAt,
    samples: [...body.samples, { sequence: body.samples.length + 1, ...sample }],
  });
  return next.samples.length === MAX_COUNTER_SAMPLES
    ? finish(next, 'sample-limit', sample.receivedAt)
    : freeze(next);
}
async function digest(body) {
  const result = await webcrypto.subtle.digest('SHA-256', encoder.encode(canonical(body)));
  return Buffer.from(result).toString('hex');
}
/** Clone and freeze validated evidence before asynchronous hashing yields. */
export async function exportSamples(record) {
  const body = freeze(bodyFrom(record));
  if (!body.end) throw new CounterSamplesError('record-open');
  const artifact = freeze({ ...body, contentHash: await digest(body) });
  const json = canonical(artifact);
  if (bytes(json) > MAX_COUNTER_ARTIFACT_BYTES) throw new CounterSamplesError('record-size');
  return { artifact, json };
}
export async function importSamples(text) {
  if (typeof text !== 'string') throw new CounterSamplesError('invalid-record');
  if (bytes(text) > MAX_COUNTER_ARTIFACT_BYTES) throw new CounterSamplesError('record-size');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CounterSamplesError('invalid-record');
  }
  const body = freeze(bodyFrom(value, true));
  if (typeof value.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.contentHash))
    throw new CounterSamplesError('invalid-record');
  if ((await digest(body)) !== value.contentHash) throw new CounterSamplesError('record-integrity');
  return freeze({ ...body, contentHash: value.contentHash });
}
/** Summarize discrete observations without attributing changes to commands. */
export function inspect(record) {
  const body = bodyFrom(record, object(record) && Object.hasOwn(record, 'contentHash'));
  const samples = body.samples;
  return Object.freeze({
    sampleCount: samples.length,
    firstValue: samples[0].state.value,
    lastValue: samples.at(-1).state.value,
    minimumValue: Math.min(...samples.map((sample) => sample.state.value)),
    maximumValue: Math.max(...samples.map((sample) => sample.state.value)),
    valueChanges: samples.filter(
      (sample, index) => index > 0 && sample.state.value !== samples[index - 1].state.value,
    ).length,
    observationClockRegressions: samples.filter(
      (sample, index) => index > 0 && sample.observedAt < samples[index - 1].observedAt,
    ).length,
    receiptClockRegressions: samples.filter(
      (sample, index) => index > 0 && sample.receivedAt < samples[index - 1].receivedAt,
    ).length,
    firstObservedAt: samples[0].observedAt,
    lastObservedAt: samples.at(-1).observedAt,
    startedAt: body.startedAt,
    lastReceivedAt: body.lastReceivedAt,
    endReason: body.end?.reason ?? null,
    endedAt: body.end?.at ?? null,
  });
}
export { exportSamples as export, importSamples as import };
