import type { CatalogPayload } from './origin';
import type { OriginResult } from './origin-client';
export type OriginMode = 'healthy' | 'failing' | 'flaky';
export type Circuit = 'closed' | 'open' | 'half-open';
export type Outcome = 'origin' | 'stale' | 'limited' | 'blocked' | 'error';
export interface Config {
  capacity: number;
  refillPerSecond: number;
  failureThreshold: number;
  cooldownMs: number;
  originLatencyMs: number;
  originTimeoutMs: number;
  staleFallback: boolean;
  originMode: OriginMode;
}
export const defaults: Config = {
  capacity: 12,
  refillPerSecond: 4,
  failureThreshold: 3,
  cooldownMs: 4000,
  originLatencyMs: 160,
  originTimeoutMs: 1500,
  staleFallback: true,
  originMode: 'healthy',
};
export interface LabState {
  runId: string;
  /** Observer metadata is absent on legacy runs; reads never invent a commit. */
  revision?: number;
  committedAt?: number | null;
  config: Config;
  tokens: number;
  updatedAt: number;
  circuit: Circuit;
  generation: number;
  failures: number;
  openedAt: number;
  probeDeadline: number;
  cachedAt: number | null;
  cachedPayload: CatalogPayload | null;
  originCalls: number;
  total: number;
  counts: Record<Outcome, number>;
}
export interface Decision {
  outcome: Outcome;
  status: number;
  message: string;
  retryAfter?: number;
  cacheAgeMs?: number;
  payload?: CatalogPayload;
}
export interface Permit {
  runId: string;
  generation: number;
  probe: boolean;
  fails: boolean;
  delay: number;
  timeoutMs: number;
}
export interface LabEvent extends Decision {
  id: number;
  at: number;
  latencyMs: number;
  circuit: Circuit;
  requestId: string;
  originAttempted: boolean;
}
export interface Snapshot {
  state: LabState;
  events: LabEvent[];
  now: number;
  colo: string;
  expiresAt: number;
}
export function initialState(now: number, runId: string): LabState {
  return {
    runId,
    config: { ...defaults },
    tokens: defaults.capacity,
    updatedAt: now,
    circuit: 'closed',
    generation: 0,
    failures: 0,
    openedAt: 0,
    probeDeadline: 0,
    cachedAt: null,
    cachedPayload: null,
    originCalls: 0,
    total: 0,
    counts: { origin: 0, stale: 0, limited: 0, blocked: 0, error: 0 },
  };
}
export function refill(s: LabState, now: number) {
  s.tokens = Math.min(
    s.config.capacity,
    s.tokens + (Math.max(0, now - s.updatedAt) / 1000) * s.config.refillPerSecond,
  );
  s.updatedAt = Math.max(now, s.updatedAt);
}
function record(s: LabState, decision: Decision): Decision {
  s.counts[decision.outcome]++;
  return decision;
}
function fallback(s: LabState, now: number, retryAfter: number, reason: string): Decision {
  if (
    s.config.staleFallback &&
    s.cachedAt !== null &&
    s.cachedPayload &&
    now - s.cachedAt <= 60_000
  ) {
    return record(s, {
      outcome: 'stale',
      status: 200,
      message: `Cached response · ${reason}`,
      cacheAgeMs: now - s.cachedAt,
      payload: s.cachedPayload,
    });
  }
  return record(s, { outcome: 'blocked', status: 503, message: reason, retryAfter });
}
/** Synchronous admission: reserve a token and the sole recovery probe before awaiting I/O. */
export function admit(s: LabState, now: number): Decision | Permit {
  refill(s, now);
  s.total++;
  if (s.tokens < 1)
    return record(s, {
      outcome: 'limited',
      status: 429,
      message: 'Token bucket empty',
      retryAfter: Math.max(1, Math.ceil((1 - s.tokens) / s.config.refillPerSecond)),
    });
  s.tokens--;
  if (s.circuit === 'half-open' && now >= s.probeDeadline) {
    s.circuit = 'open';
    s.openedAt = now - s.config.cooldownMs;
    s.generation++;
  }
  if (s.circuit === 'open') {
    const remaining = s.config.cooldownMs - (now - s.openedAt);
    if (remaining > 0)
      return fallback(s, now, Math.ceil(remaining / 1000), 'Circuit open; origin bypassed');
    s.circuit = 'half-open';
    s.probeDeadline = now + 10_000;
  } else if (s.circuit === 'half-open') {
    return fallback(s, now, 1, 'Recovery probe already in flight');
  }
  s.originCalls++;
  return {
    runId: s.runId,
    generation: s.generation,
    probe: s.circuit === 'half-open',
    fails:
      s.config.originMode === 'failing' ||
      (s.config.originMode === 'flaky' && s.originCalls % 3 === 0),
    delay: s.config.originLatencyMs,
    timeoutMs: s.config.originTimeoutMs,
  };
}
/** Ignore obsolete circuit results; an older in-flight success must not close a newer open circuit. */
export function complete(
  s: LabState,
  p: Permit,
  now: number,
  result: OriginResult,
): Decision | null {
  if (p.runId !== s.runId) return null;
  const current = p.generation === s.generation;
  if (current) {
    if (!result.ok) {
      s.failures++;
      if (p.probe || s.failures >= s.config.failureThreshold) {
        s.circuit = 'open';
        s.openedAt = now;
        s.generation++;
        s.probeDeadline = 0;
      }
    } else {
      s.failures = 0;
      s.cachedAt = now;
      s.cachedPayload = result.payload;
      if (p.probe) {
        s.circuit = 'closed';
        s.generation++;
        s.probeDeadline = 0;
      }
    }
  }
  if (result.ok)
    return record(s, {
      outcome: 'origin',
      status: 200,
      message: 'Fresh catalog from the origin Worker',
      payload: result.payload,
    });
  if (
    s.config.staleFallback &&
    s.cachedAt !== null &&
    s.cachedPayload &&
    now - s.cachedAt <= 60_000
  )
    return record(s, {
      outcome: 'stale',
      status: 200,
      message: `Origin ${result.reason}; cached response served`,
      cacheAgeMs: now - s.cachedAt,
      payload: s.cachedPayload,
    });
  return record(s, {
    outcome: 'error',
    status: result.reason === 'timeout' ? 504 : 502,
    message:
      result.reason === 'timeout'
        ? 'Origin exceeded its timeout budget'
        : 'Origin Worker failed or returned an invalid response',
  });
}
export function validateConfig(value: unknown, previous: Config): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a configuration object');
  const next = { ...previous };
  const bounds: Record<string, [number, number]> = {
    capacity: [1, 50],
    refillPerSecond: [1, 20],
    failureThreshold: [1, 10],
    cooldownMs: [1000, 15000],
    originLatencyMs: [20, 3000],
    originTimeoutMs: [100, 5000],
  };
  for (const [key, val] of Object.entries(value)) {
    if (Object.hasOwn(bounds, key)) {
      const [min, max] = bounds[key];
      if (typeof val !== 'number' || !Number.isInteger(val) || val < min || val > max)
        throw new Error(`${key} must be an integer between ${min} and ${max}`);
    } else if (key === 'staleFallback') {
      if (typeof val !== 'boolean') throw new Error('staleFallback must be boolean');
    } else if (key === 'originMode') {
      if (typeof val !== 'string' || !['healthy', 'failing', 'flaky'].includes(val))
        throw new Error('Invalid origin mode');
    } else throw new Error(`Unknown configuration field: ${key}`);
    Object.assign(next, { [key]: val });
  }
  return next;
}
