import { describe, expect, it } from 'vitest';
import { readStatusViewTiming, statusViewTimestamp } from '../src/status-view-timing';

const stored = {
  source: 'storage',
  materializedAt: 120000,
  servedAt: 120000,
  ageMs: 0,
  maxAgeMs: 10000,
};
const reused = { ...stored, source: 'memory', servedAt: 129999, ageMs: 9999 };

describe('dashboard view provenance', () => {
  it('distinguishes storage materialization from reuse at the serving clock', () => {
    expect(readStatusViewTiming(stored, stored.servedAt)).toEqual(stored);
    expect(readStatusViewTiming(reused, reused.servedAt)).toEqual(reused);
    expect(readStatusViewTiming({ ...stored, source: 'memory' }, stored.servedAt)).toEqual({
      ...stored,
      source: 'memory',
    });
  });

  it('does not give absent or malformed provenance an invented source or zero age', () => {
    for (const value of [
      undefined,
      null,
      [],
      {},
      { ...stored, source: 'cache' },
      { ...stored, source: { toString: () => 'storage' } },
      { ...stored, maxAgeMs: 60000 },
      { ...stored, ageMs: -1 },
      { ...stored, ageMs: 0.5 },
      { ...reused, ageMs: 10000, servedAt: 130000 },
      { ...reused, ageMs: 9998 },
      { ...reused, source: 'storage' },
      { ...stored, materializedAt: 120001 },
    ])
      expect(readStatusViewTiming(value, (value as typeof stored | null)?.servedAt)).toBeNull();
    expect(readStatusViewTiming(reused, reused.servedAt + 1)).toBeNull();
    expect(readStatusViewTiming(stored, '120000')).toBeNull();
  });

  it('rejects unrenderable timestamps and non-integer or impossible clock values', () => {
    for (const at of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 120000.5, '120000']) {
      expect(readStatusViewTiming({ ...stored, materializedAt: at, servedAt: at }, at)).toBeNull();
      expect(statusViewTimestamp(at)).toBeNull();
    }
    expect(readStatusViewTiming({ ...stored, servedAt: 119999 }, 119999)).toBeNull();
    expect(statusViewTimestamp(null)).toBeNull();
    expect(statusViewTimestamp(undefined)).toBeNull();
    expect(statusViewTimestamp(8_640_000_000_000_000)).not.toBeNull();
  });

  it('copies only public timing fields and preserves input timestamps', () => {
    const value = Object.freeze({ ...reused, note: 'PRIVATE-SENTINEL' });
    const parsed = readStatusViewTiming(value, reused.servedAt);
    expect(parsed).toEqual(reused);
    expect(parsed).not.toBe(value);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE-SENTINEL');
    expect(value.materializedAt).toBe(120000);
    expect(value.servedAt).toBe(129999);
    expect(statusViewTimestamp(stored.servedAt)).toBe('1970-01-01 00:02:00.000 UTC');
  });
});
