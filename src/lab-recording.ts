import {
  LAB_OBSERVER_PROTOCOL,
  LAB_OBSERVER_SNAPSHOT_EVENTS,
  MAX_LAB_OBSERVER_FRAME_BYTES,
  parseLabObserverFrame,
  type LabObserverDataFrame,
  type LabObserverEvent,
  type LabObserverFrame,
} from '../worker/lab-observer';
import { parseUniqueJson } from '../worker/unique-json.mjs';

export const LAB_RECORDING_SCHEMA_VERSION = 1;
export const MAX_LAB_RECORDING_ENTRIES = 256;
export const MAX_LAB_RECORDING_BYTES = 192 * 1024;
export const LAB_RECORDING_FINALIZATION_HEADROOM = 1024;
const captureBytes = MAX_LAB_RECORDING_BYTES - LAB_RECORDING_FINALIZATION_HEADROOM;
const encoder = new TextEncoder();

export type LabRecordingEndReason =
  | 'stopped'
  | 'disconnected'
  | 'interrupted'
  | 'expired'
  | 'unavailable'
  | 'invalid-frame'
  | 'frame-limit'
  | 'byte-limit';
export interface LabRecordingEntry {
  receivedAt: number;
  frame: LabObserverFrame;
}
export interface LabRecordingEnd {
  reason: LabRecordingEndReason;
  /** Browser time of stopping, not a server commit; null means unavailable. */
  at: number | null;
}
export interface LabRecording {
  schemaVersion: 1;
  kind: 'edgelab-observer-recording';
  protocol: typeof LAB_OBSERVER_PROTOCOL;
  producerVersion: string;
  /** Actual first and last captured receipt times; neither orders the stream. */
  startedAt: number;
  lastReceivedAt: number;
  entries: readonly LabRecordingEntry[];
  end: LabRecordingEnd | null;
}
export interface LabRecordingArtifact extends Omit<LabRecording, 'end'> {
  end: LabRecordingEnd;
  /** SHA-256 detects content changes; it is not a signature or origin proof. */
  contentHash: string;
}
export interface LabRecordingExport {
  artifact: LabRecordingArtifact;
  json: string;
}
export interface LabRecordingRevisionGap {
  fromRevision: number;
  toRevision: number;
  count: number;
}
export interface LabRecordingStep {
  entry: LabRecordingEntry;
  latestData: LabObserverDataFrame;
  /** Reconstructed observed evidence, bounded to twelve and scoped to runId. */
  events: readonly LabObserverEvent[];
  gapBefore: LabRecordingRevisionGap | null;
  runChanged: boolean;
  hasEarlierGap: boolean;
}
type ErrorCode =
  | 'invalid-recording'
  | 'invalid-frame'
  | 'recording-size'
  | 'recording-open'
  | 'recording-integrity';
export class LabRecordingError extends Error {
  constructor(readonly code: ErrorCode) {
    const messages: Record<ErrorCode, string> = {
      'invalid-recording': 'This is not a supported EdgeLab observer recording.',
      'invalid-frame': 'The observer frame or receipt time could not be validated.',
      'recording-size': 'The observer recording exceeds its fixed size or entry limit.',
      'recording-open': 'Stop the observer recording before exporting it.',
      'recording-integrity': 'The observer recording content hash does not match.',
    };
    super(messages[code]);
    this.name = 'LabRecordingError';
  }
}
const reasons: readonly LabRecordingEndReason[] = [
  'stopped',
  'disconnected',
  'interrupted',
  'expired',
  'unavailable',
  'invalid-frame',
  'frame-limit',
  'byte-limit',
];
const bodyKeys = [
  'schemaVersion',
  'kind',
  'protocol',
  'producerVersion',
  'startedAt',
  'lastReceivedAt',
  'entries',
  'end',
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

/** Canonical JSON is independent of object key order, with array order retained. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  throw new LabRecordingError('invalid-recording');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function strictFrame(value: unknown): LabObserverFrame | null {
  try {
    if (typeof value === 'string') {
      if (encoder.encode(value).byteLength > MAX_LAB_OBSERVER_FRAME_BYTES) return null;
      value = parseUniqueJson(value);
    }
    const parsed = parseLabObserverFrame(value);
    // The live parser deliberately strips extras. An archive must reject them,
    // rather than hiding private bytes or silently changing imported evidence.
    if (
      !parsed ||
      encoder.encode(canonical(parsed)).byteLength > MAX_LAB_OBSERVER_FRAME_BYTES ||
      canonical(value) !== canonical(parsed)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function validVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
  );
}
function bodyFrom(value: unknown, artifact = false): LabRecording {
  try {
    if (
      !record(value) ||
      !exactKeys(value, artifact ? [...bodyKeys, 'contentHash'] : bodyKeys) ||
      value.schemaVersion !== LAB_RECORDING_SCHEMA_VERSION ||
      value.kind !== 'edgelab-observer-recording' ||
      value.protocol !== LAB_OBSERVER_PROTOCOL ||
      !validVersion(value.producerVersion) ||
      !timestamp(value.startedAt) ||
      !timestamp(value.lastReceivedAt) ||
      !Array.isArray(value.entries) ||
      value.entries.length < 1
    )
      throw new LabRecordingError('invalid-recording');
    if (value.entries.length > MAX_LAB_RECORDING_ENTRIES)
      throw new LabRecordingError('recording-size');
    const entries: LabRecordingEntry[] = [];
    let latest: LabObserverDataFrame | null = null;
    let terminal: LabObserverFrame | null = null;
    for (const item of value.entries) {
      if (
        !record(item) ||
        !exactKeys(item, ['receivedAt', 'frame']) ||
        !timestamp(item.receivedAt) ||
        !record(item.frame)
      )
        throw new LabRecordingError('invalid-recording');
      const frame = strictFrame(item.frame);
      if (!frame || terminal) throw new LabRecordingError('invalid-recording');
      if (!latest) {
        if (frame.kind !== 'snapshot') throw new LabRecordingError('invalid-recording');
        latest = frame;
      } else if ('state' in frame) {
        if (frame.kind !== 'update' || frame.revision <= latest.revision)
          throw new LabRecordingError('invalid-recording');
        latest = frame;
      } else terminal = frame;
      entries.push({ receivedAt: item.receivedAt, frame });
    }
    if (
      value.startedAt !== entries[0].receivedAt ||
      value.lastReceivedAt !== entries[entries.length - 1].receivedAt
    )
      throw new LabRecordingError('invalid-recording');
    let end: LabRecordingEnd | null = null;
    if (value.end !== null) {
      if (
        !record(value.end) ||
        !exactKeys(value.end, ['reason', 'at']) ||
        !reasons.includes(value.end.reason as LabRecordingEndReason) ||
        (value.end.at !== null && !timestamp(value.end.at))
      )
        throw new LabRecordingError('invalid-recording');
      end = {
        reason: value.end.reason as LabRecordingEndReason,
        at: value.end.at as number | null,
      };
    }
    if (
      (artifact && !end) ||
      (terminal && (!end || end.reason !== terminal.kind || end.at !== value.lastReceivedAt)) ||
      (end?.reason === 'frame-limit' && entries.length !== MAX_LAB_RECORDING_ENTRIES)
    )
      throw new LabRecordingError('invalid-recording');
    const body: LabRecording = {
      schemaVersion: LAB_RECORDING_SCHEMA_VERSION,
      kind: 'edgelab-observer-recording',
      protocol: LAB_OBSERVER_PROTOCOL,
      producerVersion: value.producerVersion,
      startedAt: value.startedAt,
      lastReceivedAt: value.lastReceivedAt,
      entries,
      end,
    };
    // A next entry contains a bounded frame plus at most 64 bytes for its
    // receipt wrapper and the changed last-receipt field. A much smaller
    // prefix cannot plausibly have stopped because that entry exceeded bytes.
    if (
      end?.reason === 'byte-limit' &&
      encoder.encode(canonical({ ...body, end: null })).byteLength <
        captureBytes - MAX_LAB_OBSERVER_FRAME_BYTES - 64
    )
      throw new LabRecordingError('invalid-recording');
    return body;
  } catch (error) {
    if (error instanceof LabRecordingError) throw error;
    throw new LabRecordingError('invalid-recording');
  }
}
function checkCaptureSize(value: LabRecording) {
  if (encoder.encode(canonical(value)).byteLength > captureBytes)
    throw new LabRecordingError('recording-size');
}

/** Begin only with the actual first snapshot; there is no synthetic snapshot. */
export function beginLabRecording(
  value: unknown,
  receivedAt: number,
  producerVersion: string,
): LabRecording {
  const frame = strictFrame(value);
  if (
    !frame ||
    frame.kind !== 'snapshot' ||
    !timestamp(receivedAt) ||
    !validVersion(producerVersion)
  )
    throw new LabRecordingError('invalid-frame');
  const body: LabRecording = {
    schemaVersion: LAB_RECORDING_SCHEMA_VERSION,
    kind: 'edgelab-observer-recording',
    protocol: LAB_OBSERVER_PROTOCOL,
    producerVersion,
    startedAt: receivedAt,
    lastReceivedAt: receivedAt,
    entries: [{ receivedAt, frame }],
    end: null,
  };
  checkCaptureSize(body);
  return freeze(body);
}

/** Closed prefixes never reopen, and new callbacks cannot replace their reason. */
export function finalizeLabRecording(
  recording: LabRecording,
  reason: LabRecordingEndReason,
  at: number | null,
): LabRecording {
  const body = bodyFrom(recording);
  if (body.end) return recording;
  if (!reasons.includes(reason) || (at !== null && !timestamp(at)))
    throw new LabRecordingError('invalid-recording');
  const finished = bodyFrom({ ...body, end: { reason, at } });
  // Fixed metadata has bounded size; no entry is truncated to make room.
  if (encoder.encode(canonical(finished)).byteLength + 128 > MAX_LAB_RECORDING_BYTES)
    throw new LabRecordingError('recording-size');
  return freeze(finished);
}

/** Append in receipt order; a regressing receipt clock cannot reorder evidence. */
export function appendLabRecording(
  recording: LabRecording,
  value: unknown,
  receivedAt: number,
): LabRecording {
  const body = bodyFrom(recording);
  if (body.end) return recording;
  const at = timestamp(receivedAt) ? receivedAt : null;
  const frame = strictFrame(value);
  const previous = body.entries[body.entries.length - 1].frame;
  if (
    !frame ||
    at === null ||
    !('state' in previous) ||
    frame.kind === 'snapshot' ||
    ('state' in frame && frame.revision <= previous.revision)
  )
    return finalizeLabRecording(recording, 'invalid-frame', at);
  if (body.entries.length >= MAX_LAB_RECORDING_ENTRIES)
    return finalizeLabRecording(recording, 'frame-limit', at);
  const next: LabRecording = {
    ...body,
    lastReceivedAt: receivedAt,
    entries: [...body.entries, { receivedAt, frame }],
  };
  if (encoder.encode(canonical(next)).byteLength > captureBytes)
    return finalizeLabRecording(recording, 'byte-limit', at);
  if (!('state' in frame)) return freeze(bodyFrom({ ...next, end: { reason: frame.kind, at } }));
  if (next.entries.length === MAX_LAB_RECORDING_ENTRIES)
    return finalizeLabRecording(next, 'frame-limit', at);
  return freeze(next);
}
async function digest(value: string): Promise<string> {
  const bytes = encoder.encode(value);
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Freeze a fresh validated snapshot before yielding to asynchronous hashing. */
export async function exportLabRecording(recording: LabRecording): Promise<LabRecordingExport> {
  const body = freeze(bodyFrom(recording));
  if (!body.end) throw new LabRecordingError('recording-open');
  checkCaptureSize({ ...body, end: null });
  const contentHash = await digest(canonical(body));
  const artifact = freeze({ ...body, end: body.end, contentHash });
  const json = canonical(artifact);
  if (encoder.encode(json).byteLength > MAX_LAB_RECORDING_BYTES)
    throw new LabRecordingError('recording-size');
  return { artifact, json };
}

/** Untrusted files never become display data until schema and hash both pass. */
export async function importLabRecording(json: string): Promise<LabRecordingArtifact> {
  if (typeof json !== 'string') throw new LabRecordingError('invalid-recording');
  if (encoder.encode(json).byteLength > MAX_LAB_RECORDING_BYTES)
    throw new LabRecordingError('recording-size');
  let value: unknown;
  try {
    value = parseUniqueJson(json);
  } catch {
    throw new LabRecordingError('invalid-recording');
  }
  const body = freeze(bodyFrom(value, true));
  const contentHash = (value as Record<string, unknown>).contentHash;
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash))
    throw new LabRecordingError('invalid-recording');
  checkCaptureSize({ ...body, end: null });
  if ((await digest(canonical(body))) !== contentHash)
    throw new LabRecordingError('recording-integrity');
  return freeze({ ...body, end: body.end!, contentHash });
}

/** Inspect an observed prefix; this never runs the engine or fills a gap. */
export function inspectLabRecording(
  recording: Pick<LabRecording, 'entries'>,
  index: number,
): LabRecordingStep {
  if (!Number.isInteger(index) || index < 0 || index >= recording.entries.length)
    throw new RangeError('Recording entry is outside the captured prefix.');
  let latestData: LabObserverDataFrame | null = null;
  let events: LabObserverEvent[] = [];
  let hasEarlierGap = false;
  let selected: LabRecordingStep | null = null;
  for (let position = 0; position <= index; position++) {
    const entry = recording.entries[position];
    let gapBefore: LabRecordingRevisionGap | null = null;
    let runChanged = false;
    if ('state' in entry.frame) {
      if (latestData && entry.frame.revision > latestData.revision + 1) {
        gapBefore = {
          fromRevision: latestData.revision + 1,
          toRevision: entry.frame.revision - 1,
          count: entry.frame.revision - latestData.revision - 1,
        };
        hasEarlierGap = true;
      }
      runChanged = latestData !== null && latestData.runId !== entry.frame.runId;
      if (!latestData || runChanged || entry.frame.kind === 'snapshot') events = [];
      const byId = new Map(events.map((event) => [event.id, event]));
      for (const event of entry.frame.events) byId.set(event.id, event);
      events = [...byId.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, LAB_OBSERVER_SNAPSHOT_EVENTS);
      latestData = entry.frame;
    }
    if (!latestData) throw new LabRecordingError('invalid-recording');
    selected = { entry, latestData, events: events.slice(), gapBefore, runChanged, hasEarlierGap };
  }
  return freeze(selected!);
}
