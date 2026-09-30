import {
  defaults,
  validateConfig,
  type Circuit,
  type Config,
  type LabEvent,
  type LabState,
  type Outcome,
} from './engine';

export const LAB_OBSERVER_PROTOCOL = 'edgelab-observer-v1';
export const LAB_OBSERVER_CAPABILITY_PREFIX = 'edgelab-cap.';
export const MAX_LAB_OBSERVERS = 4;
export const MAX_LAB_OBSERVER_FRAME_BYTES = 16_384;
export const LAB_OBSERVER_SNAPSHOT_EVENTS = 12;

export interface LabObserverState {
  config: Config;
  tokens: number;
  circuit: Circuit;
  failures: number;
  total: number;
  originCalls: number;
  counts: Record<Outcome, number>;
}
export interface LabObserverEvent {
  id: number;
  at: number;
  latencyMs: number;
  outcome: Outcome;
  status: number;
  circuit: Circuit;
  originAttempted: boolean;
}
export interface LabObserverDataFrame {
  schemaVersion: 1;
  kind: 'snapshot' | 'update';
  runId: string;
  revision: number;
  committedAt: number | null;
  now: number;
  expiresAt: number;
  state: LabObserverState;
  events: LabObserverEvent[];
}
export interface LabObserverTerminalFrame {
  schemaVersion: 1;
  kind: 'expired' | 'unavailable';
  reason: 'idle-expired' | 'lab-unavailable';
  now: number;
}
export type LabObserverFrame = LabObserverDataFrame | LabObserverTerminalFrame;

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const outcomes: Outcome[] = ['origin', 'stale', 'limited', 'blocked', 'error'];
const circuits: Circuit[] = ['closed', 'open', 'half-open'];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number =>
  nonnegative(value) && Number.isSafeInteger(value);
const timestamp = (value: unknown): value is number =>
  integer(value) && value <= 8_640_000_000_000_000;
const circuit = (value: unknown): value is Circuit =>
  typeof value === 'string' && circuits.includes(value as Circuit);
const outcome = (value: unknown): value is Outcome =>
  typeof value === 'string' && outcomes.includes(value as Outcome);

/** Browser handshakes carry the existing lab capability only in an exact offered protocol pair. */
export function parseLabObserverProtocols(header: string | null): string | null {
  if (!header || header.length > 128) return null;
  const offered = header.split(',').map((entry) => entry.trim());
  if (
    offered.length !== 2 ||
    offered[0] !== LAB_OBSERVER_PROTOCOL ||
    !offered[1].startsWith(LAB_OBSERVER_CAPABILITY_PREFIX)
  )
    return null;
  const id = offered[1].slice(LAB_OBSERVER_CAPABILITY_PREFIX.length);
  return uuidV4.test(id) ? id : null;
}

function projectConfig(value: unknown): Config | null {
  if (!record(value)) return null;
  const selected = {
    capacity: value.capacity,
    refillPerSecond: value.refillPerSecond,
    failureThreshold: value.failureThreshold,
    cooldownMs: value.cooldownMs,
    originLatencyMs: value.originLatencyMs,
    originTimeoutMs: value.originTimeoutMs,
    staleFallback: value.staleFallback,
    originMode: value.originMode,
  };
  try {
    return validateConfig(selected, defaults);
  } catch {
    return null;
  }
}

function projectState(value: unknown): LabObserverState | null {
  if (!record(value) || !record(value.counts)) return null;
  const config = projectConfig(value.config);
  if (
    !config ||
    !nonnegative(value.tokens) ||
    value.tokens > config.capacity ||
    !circuit(value.circuit) ||
    !integer(value.failures) ||
    !integer(value.total) ||
    !integer(value.originCalls) ||
    value.originCalls > value.total ||
    !outcomes.every((key) => integer((value.counts as Record<string, unknown>)[key]))
  )
    return null;
  const completed = outcomes.reduce(
    (sum, key) => sum + ((value.counts as Record<string, unknown>)[key] as number),
    0,
  );
  if (!Number.isSafeInteger(completed) || completed > value.total) return null;
  return {
    config,
    tokens: value.tokens,
    circuit: value.circuit,
    failures: value.failures,
    total: value.total,
    originCalls: value.originCalls,
    counts: {
      origin: value.counts.origin as number,
      stale: value.counts.stale as number,
      limited: value.counts.limited as number,
      blocked: value.counts.blocked as number,
      error: value.counts.error as number,
    },
  };
}

function projectEvent(value: unknown): LabObserverEvent | null {
  if (
    !record(value) ||
    !integer(value.id) ||
    value.id < 1 ||
    !timestamp(value.at) ||
    !nonnegative(value.latencyMs) ||
    !outcome(value.outcome) ||
    !integer(value.status) ||
    value.status < 100 ||
    value.status > 599 ||
    !circuit(value.circuit) ||
    typeof value.originAttempted !== 'boolean'
  )
    return null;
  return {
    id: value.id,
    at: value.at,
    latencyMs: value.latencyMs,
    outcome: value.outcome,
    status: value.status,
    circuit: value.circuit,
    originAttempted: value.originAttempted,
  };
}

/** Parse bounded transport data into a new allowlisted value; never retain raw payloads or messages. */
export function parseLabObserverFrame(value: unknown): LabObserverFrame | null {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > MAX_LAB_OBSERVER_FRAME_BYTES) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!record(value) || value.schemaVersion !== 1 || !timestamp(value.now)) return null;
  if (value.kind === 'expired' || value.kind === 'unavailable') {
    const reason = value.kind === 'expired' ? 'idle-expired' : 'lab-unavailable';
    if (value.reason !== reason) return null;
    return { schemaVersion: 1, kind: value.kind, reason, now: value.now };
  }
  if (
    (value.kind !== 'snapshot' && value.kind !== 'update') ||
    typeof value.runId !== 'string' ||
    !uuidV4.test(value.runId) ||
    !integer(value.revision) ||
    (value.committedAt !== null && !timestamp(value.committedAt)) ||
    (typeof value.committedAt === 'number' && value.committedAt > value.now) ||
    (value.revision === 0
      ? value.kind !== 'snapshot' || value.committedAt !== null
      : value.committedAt === null) ||
    !timestamp(value.expiresAt) ||
    value.expiresAt <= value.now ||
    !Array.isArray(value.events) ||
    value.events.length > (value.kind === 'snapshot' ? LAB_OBSERVER_SNAPSHOT_EVENTS : 1)
  )
    return null;
  const state = projectState(value.state);
  const events = value.events.map(projectEvent);
  const now = value.now;
  if (
    !state ||
    events.some((event) => event === null || event.at > now) ||
    new Set(events.map((event) => event?.id)).size !== events.length
  )
    return null;
  return {
    schemaVersion: 1,
    kind: value.kind,
    runId: value.runId,
    revision: value.revision,
    committedAt: value.committedAt as number | null,
    now: value.now,
    expiresAt: value.expiresAt,
    state,
    events: events as LabObserverEvent[],
  };
}

/** Source projection is captured once per commit, even with no observers. No per-client storage work. */
export function captureLabObserverFrame(
  s: LabState,
  kind: LabObserverDataFrame['kind'],
  events: LabEvent[],
  now: number,
  expiresAt: number,
): LabObserverDataFrame {
  // Legacy metadata is unknown until an owner actually commits a new state write.
  const legacy = s.revision === undefined && s.committedAt === undefined;
  const revision = legacy ? 0 : s.revision;
  const committedAt = legacy ? null : s.committedAt;
  const frame = parseLabObserverFrame({
    schemaVersion: 1,
    kind,
    runId: s.runId,
    revision,
    committedAt,
    now,
    expiresAt,
    state: s,
    events,
  });
  if (!frame || (frame.kind !== 'snapshot' && frame.kind !== 'update'))
    throw new Error('Lab observer projection unavailable');
  return frame;
}

export function serializeLabObserverFrame(frame: LabObserverFrame): string {
  const encoded = JSON.stringify(frame);
  if (new TextEncoder().encode(encoded).byteLength > MAX_LAB_OBSERVER_FRAME_BYTES)
    throw new Error('Lab observer frame exceeds its bound');
  return encoded;
}
