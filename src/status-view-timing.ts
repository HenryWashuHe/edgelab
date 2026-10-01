import { STATUS_VIEW_MAX_AGE_MS, type StatusViewRead } from '../worker/status-view-cache';

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;

/** Legacy or inconsistent provenance must not become a claimed storage read. */
export function readStatusViewTiming(value: unknown, snapshotNow: unknown): StatusViewRead | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.source !== 'storage' && candidate.source !== 'memory') ||
    !isTimestamp(candidate.materializedAt) ||
    !isTimestamp(candidate.servedAt) ||
    !isTimestamp(snapshotNow) ||
    candidate.servedAt !== snapshotNow ||
    candidate.materializedAt > candidate.servedAt ||
    candidate.maxAgeMs !== STATUS_VIEW_MAX_AGE_MS ||
    typeof candidate.ageMs !== 'number' ||
    !Number.isSafeInteger(candidate.ageMs) ||
    candidate.ageMs < 0 ||
    candidate.ageMs >= STATUS_VIEW_MAX_AGE_MS ||
    candidate.ageMs !== candidate.servedAt - candidate.materializedAt ||
    (candidate.source === 'storage' && candidate.ageMs !== 0)
  )
    return null;
  return {
    source: candidate.source,
    materializedAt: candidate.materializedAt,
    servedAt: candidate.servedAt,
    ageMs: candidate.ageMs,
    maxAgeMs: STATUS_VIEW_MAX_AGE_MS,
  };
}

/** Safe UTC fallback for snapshots that predate provenance metadata. */
export function statusViewTimestamp(value: unknown): string | null {
  return isTimestamp(value)
    ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC')
    : null;
}
