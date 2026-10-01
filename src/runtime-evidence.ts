import data from './data/status-reuse-evidence.json';

export type ReadonlyRuntimeData<T> = T extends readonly (infer Item)[]
  ? readonly ReadonlyRuntimeData<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: ReadonlyRuntimeData<T[Key]> }
    : T;

function freeze<T>(value: T): ReadonlyRuntimeData<T> {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((child) => freeze(child));
    Object.freeze(value);
  }
  // Every nested value is frozen; the cast describes the recursive readonly shape.
  return value as ReadonlyRuntimeData<T>;
}

/** Bundled allowlisted projection only; the full backend archive is never imported. */
export const runtimeEvidence = freeze(data);
export type RuntimeEvidenceData = typeof runtimeEvidence;
export type RuntimeEvidenceProfile = RuntimeEvidenceData['profiles'][number];
export type RuntimeEvidenceWindow = RuntimeEvidenceProfile['windows'][number];
export type RuntimeEvidenceMeasurement = RuntimeEvidenceWindow['measurements'][number];

/** Unsupported selections remain unavailable rather than silently changing the workload. */
export function statusReuseMeasurements(targetCount: number, window: string) {
  const profile = runtimeEvidence.profiles.find((entry) => entry.targetCount === targetCount);
  const selected = profile?.windows.find((entry) => entry.window === window);
  return profile && selected ? { profile, selected } : null;
}
