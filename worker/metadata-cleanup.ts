/** Only FIFO candidates are counted; eager expiry and account usage are excluded. */
export type CleanupBatch = {
  limit: 32;
  examined: number;
  deleted: number;
  protected: number;
  missing: number;
  /** A full batch may leave work; this is never a measured remaining-row count. */
  mayRemain: boolean;
};
export type PublicMetadataCleanup = {
  schemaVersion: 1;
  cutoff: number;
  versions: CleanupBatch;
};
export type MetadataCleanup = PublicMetadataCleanup & { orphanNotes: CleanupBatch };
export type PublicCleanupRecord = {
  at: number;
  slot: number;
  cleanup: PublicMetadataCleanup | null;
};
export type CleanupRecord = Omit<PublicCleanupRecord, 'cleanup'> & {
  cleanup: MetadataCleanup | null;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const maxTimestamp = 8_640_000_000_000_000;
const timestamp = (value: unknown): value is number => integer(value) && value <= maxTimestamp;
const slot = (value: unknown): value is number =>
  integer(value) && value <= Math.floor(maxTimestamp / 60_000);

/** Reconstruct allowlisted fields so malformed/legacy records never become zeros. */
export function readCleanupBatch(value: unknown): CleanupBatch | null {
  const row = object(value);
  if (!row || row.limit !== 32) return null;
  const { examined, deleted, protected: preserved, missing, mayRemain } = row;
  if (
    !integer(examined) ||
    !integer(deleted) ||
    !integer(preserved) ||
    !integer(missing) ||
    examined > 32 ||
    deleted + preserved + missing !== examined ||
    mayRemain !== (examined === 32)
  )
    return null;
  return { limit: 32, examined, deleted, protected: preserved, missing, mayRemain };
}

export function readPublicMetadataCleanup(value: unknown): PublicMetadataCleanup | null {
  const row = object(value);
  if (!row || row.schemaVersion !== 1 || !timestamp(row.cutoff)) return null;
  const versions = readCleanupBatch(row.versions);
  return versions ? { schemaVersion: 1, cutoff: row.cutoff, versions } : null;
}

export function readMetadataCleanup(value: unknown): MetadataCleanup | null {
  const row = object(value);
  const publicFields = readPublicMetadataCleanup(value);
  const orphanNotes = readCleanupBatch(row?.orphanNotes);
  return publicFields && orphanNotes ? { ...publicFields, orphanNotes } : null;
}

export function readPublicCleanupRecord(value: unknown): PublicCleanupRecord | null {
  const row = object(value);
  if (!row || !timestamp(row.at) || !slot(row.slot)) return null;
  const cleanup = readPublicMetadataCleanup(row.cleanup);
  return {
    at: row.at,
    slot: row.slot,
    cleanup: cleanup && cleanup.cutoff <= row.at ? cleanup : null,
  };
}

export function readCleanupRecord(value: unknown): CleanupRecord | null {
  const row = object(value);
  const record = readPublicCleanupRecord(value);
  if (!row || !record) return null;
  const cleanup = readMetadataCleanup(row.cleanup);
  return { ...record, cleanup: cleanup && cleanup.cutoff <= record.at ? cleanup : null };
}

type PublicSchedulerDetail = {
  reason?: string;
  results?: { service: string; result: string }[];
  cleanup?: PublicMetadataCleanup | null;
};
const results = new Set([
  'good',
  'http-error',
  'timeout',
  'network-error',
  'invalid-body',
  'slow',
  'maintenance',
  'window-closed',
  'duplicate-or-busy',
  'superseded',
  'policy-changed',
]);
const lateReason =
  'The scheduled minute has passed; a current probe cannot fill its historical gap.';

/** Public status and authenticated exports both use this projection. */
export function publicSchedulerDetail(
  status: string,
  value: unknown,
  completed: { at: number; slot: number },
): PublicSchedulerDetail {
  const row = object(value);
  if (!row) return {};
  if (status === 'skipped-late') return row.reason === lateReason ? { reason: lateReason } : {};
  if (status !== 'completed') return {};
  const detail: PublicSchedulerDetail = {};
  if (Array.isArray(row.results))
    detail.results = row.results.slice(0, 5).flatMap((value) => {
      const result = object(value);
      return result &&
        typeof result.service === 'string' &&
        /^[a-z0-9-]{1,40}$/.test(result.service) &&
        typeof result.result === 'string' &&
        results.has(result.result)
        ? [{ service: result.service, result: result.result }]
        : [];
    });
  if ('cleanup' in row)
    detail.cleanup =
      readPublicCleanupRecord({ ...completed, cleanup: row.cleanup })?.cleanup ?? null;
  return detail;
}

export function parseSchedulerDetail(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
