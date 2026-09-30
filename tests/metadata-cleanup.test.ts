import { describe, expect, it } from 'vitest';
import {
  parseSchedulerDetail,
  publicSchedulerDetail,
  readCleanupBatch,
  readCleanupRecord,
  readMetadataCleanup,
  readPublicCleanupRecord,
  readPublicMetadataCleanup,
} from '../worker/metadata-cleanup';

const batch = {
  limit: 32,
  examined: 3,
  deleted: 1,
  protected: 1,
  missing: 1,
  mayRemain: false,
};
const cleanup = { schemaVersion: 1, cutoff: 1000, versions: batch, orphanNotes: batch };
const completed = { at: 2000, slot: 0 };
describe('metadata cleanup records and public projection', () => {
  it('counts direct source outcomes and treats a full batch conservatively', () => {
    expect(readCleanupBatch(batch)).toEqual(batch);
    expect(readCleanupBatch({ ...batch, examined: 32, deleted: 30, mayRemain: true })).toEqual({
      ...batch,
      examined: 32,
      deleted: 30,
      mayRemain: true,
    });
    for (const value of [
      null,
      [],
      {},
      { ...batch, limit: 64 },
      { ...batch, examined: 33, deleted: 31, mayRemain: true },
      { ...batch, missing: -1 },
      { ...batch, deleted: 0.5 },
      { ...batch, protected: 0 },
      { ...batch, mayRemain: true },
      { ...batch, examined: 32, deleted: 30, mayRemain: false },
    ])
      expect(readCleanupBatch(value)).toBeNull();
  });

  it('reconstructs public fields without note activity or unknown nested properties', () => {
    const value = {
      ...cleanup,
      privateNote: 'PRIVATE-SENTINEL',
      versions: { ...batch, sourceKey: 'PRIVATE-SENTINEL' },
    };
    expect(readPublicMetadataCleanup(value)).toEqual({
      schemaVersion: 1,
      cutoff: 1000,
      versions: batch,
    });
    expect(JSON.stringify(readPublicMetadataCleanup(value))).not.toContain('PRIVATE-SENTINEL');
    expect(readMetadataCleanup(value)).toEqual(cleanup);
    expect(readMetadataCleanup({ ...cleanup, orphanNotes: undefined })).toBeNull();
    expect(readPublicMetadataCleanup({ ...cleanup, schemaVersion: 2 })).toBeNull();
  });

  it('preserves legacy record timestamps and reports unavailable diagnostics', () => {
    expect(readPublicCleanupRecord({ at: 2000, slot: 0 })).toEqual({
      at: 2000,
      slot: 0,
      cleanup: null,
    });
    expect(readCleanupRecord({ at: 2000, slot: 0, cleanup })).toEqual({
      at: 2000,
      slot: 0,
      cleanup,
    });
    expect(readCleanupRecord({ at: 500, slot: 0, cleanup })?.cleanup).toBeNull();
    expect(readPublicCleanupRecord({ at: -1, slot: 0, cleanup })).toBeNull();
  });

  it('rejects unrenderable timestamps and slots rather than throwing in a UTC view', () => {
    expect(readPublicCleanupRecord({ at: Number.MAX_SAFE_INTEGER, slot: 0, cleanup })).toBeNull();
    expect(
      readPublicCleanupRecord({ at: 2000, slot: Number.MAX_SAFE_INTEGER, cleanup }),
    ).toBeNull();
    expect(readPublicMetadataCleanup({ ...cleanup, cutoff: Number.MAX_SAFE_INTEGER })).toBeNull();
  });

  it('whitelists completed public details even with injected private fields', () => {
    const projected = publicSchedulerDetail(
      'completed',
      {
        cleanup,
        results: [
          { service: 'catalog', result: 'good', note: 'PRIVATE-SENTINEL' },
          { service: 'https://private.example', result: 'good' },
          { service: 'catalog', result: 'PRIVATE-SENTINEL' },
        ],
        note: 'PRIVATE-SENTINEL',
      },
      completed,
    );
    expect(projected).toEqual({
      results: [{ service: 'catalog', result: 'good' }],
      cleanup: { schemaVersion: 1, cutoff: 1000, versions: batch },
    });
    expect(JSON.stringify(projected)).not.toContain('orphanNotes');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-SENTINEL');
  });

  it('rejects invalid completed context and future cutoff consistently with audit records', () => {
    for (const record of [
      { at: 500, slot: 0 },
      { at: Number.MAX_SAFE_INTEGER, slot: 0 },
      { at: 2000, slot: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(publicSchedulerDetail('completed', { cleanup }, record).cleanup).toBeNull();
      expect(readCleanupRecord({ ...record, cleanup })?.cleanup ?? null).toBeNull();
    }
  });

  it('keeps known late reasons while omitting unsupported details and malformed JSON', () => {
    const reason =
      'The scheduled minute has passed; a current probe cannot fill its historical gap.';
    expect(
      publicSchedulerDetail('skipped-late', { reason, note: 'PRIVATE-SENTINEL' }, completed),
    ).toEqual({
      reason,
    });
    expect(publicSchedulerDetail('started', { note: 'PRIVATE-SENTINEL' }, completed)).toEqual({});
    expect(
      publicSchedulerDetail('skipped-late', { reason: 'PRIVATE-SENTINEL' }, completed),
    ).toEqual({});
    expect(parseSchedulerDetail('{invalid')).toBeNull();
    expect(publicSchedulerDetail('completed', parseSchedulerDetail('{invalid'), completed)).toEqual(
      {},
    );
  });
});
