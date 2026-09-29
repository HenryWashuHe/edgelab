export const MINUTE = 60_000;
export const RETENTION = 30 * 24 * 60 * MINUTE;
export interface MonitorPolicy {
  paused: boolean;
  timeoutMs: number;
  latencyObjectiveMs: number;
  availabilityTarget: number;
  failureThreshold: number;
  recoveryThreshold: number;
}
export const defaultPolicy: MonitorPolicy = {
  paused: false,
  timeoutMs: 3000,
  latencyObjectiveMs: 1500,
  availabilityTarget: 99.9,
  failureThreshold: 3,
  recoveryThreshold: 2,
};
export type MonitorTarget = {
  id: string;
  name: string;
  url: string;
  transport: 'https' | 'origin';
  assertion: 'ok-json' | 'catalog-json';
};
export type ProbeResult = {
  outcome:
    'good' | 'http-error' | 'timeout' | 'network-error' | 'invalid-body' | 'slow' | 'maintenance';
  status: number | null;
  latencyMs: number;
};
export interface MonitorState {
  failures: number;
  successes: number;
  lastSlot: number | null;
  incidentId: string | null;
}
export const initialMonitorState = (): MonitorState => ({
  failures: 0,
  successes: 0,
  lastSlot: null,
  incidentId: null,
});
export function transition(
  previous: MonitorState,
  good: boolean,
  slot: number,
  policy: MonitorPolicy,
) {
  const state = { ...previous };
  if (state.lastSlot !== null && slot <= state.lastSlot) return { state, change: 'none' as const };
  if (state.lastSlot === null || slot !== state.lastSlot + 1) state.failures = state.successes = 0;
  state.lastSlot = slot;
  state.failures = good ? 0 : state.failures + 1;
  state.successes = good ? state.successes + 1 : 0;
  const change =
    !state.incidentId && state.failures >= policy.failureThreshold
      ? 'open'
      : state.incidentId && state.successes >= policy.recoveryThreshold
        ? 'resolve'
        : 'none';
  return { state, change };
}
export function validatePolicy(value: unknown, current: MonitorPolicy): MonitorPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Policy must be an object');
  const patch = value as Record<string, unknown>;
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in defaultPolicy)) throw new Error(`Unknown policy field: ${key}`);
    if (key === 'paused') {
      if (typeof value !== 'boolean') throw new Error('paused must be boolean');
      next.paused = value;
    } else {
      const limits: Record<string, [number, number]> = {
        timeoutMs: [100, 10000],
        latencyObjectiveMs: [50, 10000],
        availabilityTarget: [90, 99.99],
        failureThreshold: [1, 10],
        recoveryThreshold: [1, 10],
      };
      const [min, max] = limits[key];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (key !== 'availabilityTarget' && !Number.isInteger(value))
      )
        throw new Error(
          `${key} must be ${min}–${max}${key === 'availabilityTarget' ? '' : ' (integer)'}`,
        );
      Object.assign(next, { [key]: value });
    }
  }
  if (next.latencyObjectiveMs > next.timeoutMs)
    throw new Error('Latency objective cannot exceed timeout');
  return next;
}
/** Targets are trusted deployment configuration, never a request parameter. */
export function parseTargets(raw?: string): MonitorTarget[] {
  const values: unknown = JSON.parse(raw || '[]');
  if (!Array.isArray(values) || values.length > 5)
    throw new Error('Configure at most five monitor targets');
  const ids = new Set<string>();
  return values.map((t) => {
    if (
      !t ||
      typeof t !== 'object' ||
      !/^[a-z0-9-]{1,40}$/.test(t.id) ||
      ids.has(t.id) ||
      typeof t.name !== 'string' ||
      t.name.length < 1 ||
      t.name.length > 80
    )
      throw new Error('Invalid or duplicate monitor identity');
    const url = new URL(t.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.port && url.port !== '443')
    )
      throw new Error('Targets require HTTPS without credentials, query, fragment, or custom port');
    if (
      !['https', 'origin'].includes(t.transport) ||
      !['ok-json', 'catalog-json'].includes(t.assertion)
    )
      throw new Error('Invalid monitor transport or assertion');
    if (
      t.transport === 'https' &&
      (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ||
        /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname))
    )
      throw new Error('Public DNS target required');
    if (t.transport === 'origin' && url.hostname !== 'origin.internal')
      throw new Error('Origin binding must use origin.internal');
    ids.add(t.id);
    return {
      id: t.id,
      name: t.name,
      url: url.toString(),
      transport: t.transport,
      assertion: t.assertion,
    };
  });
}
export function windowBounds(createdAt: number, now: number, minutes: number) {
  const end = Math.floor(now / MINUTE) - 1; // Only finished minutes belong to SLO reports.
  const start = Math.max(end - minutes + 1, Math.ceil(createdAt / MINUTE));
  return { start, end, expected: Math.max(0, end - start + 1) };
}
