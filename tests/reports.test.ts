import { describe, it, expect } from 'vitest';
import { asCsv, percentile95 } from '../src/reports';
import type { LabEvent } from '../worker/engine';
const event = (patch: Partial<LabEvent> = {}): LabEvent => ({
  id: 1,
  at: 0,
  requestId: 'abc',
  outcome: 'origin',
  status: 200,
  message: 'Fresh catalog',
  latencyMs: 160,
  circuit: 'closed',
  originAttempted: true,
  ...patch,
});
describe('honest experiment reports', () => {
  it('excludes bypasses from origin p95 rather than letting cheap rejections lower it', () => {
    const events = [
      event({ latencyMs: 700 }),
      ...Array.from({ length: 100 }, () => event({ latencyMs: 0, originAttempted: false })),
    ];
    expect(percentile95(events)).toBe(700);
    expect(percentile95([])).toBeNull();
  });
  it('escapes quotes, newlines, and spreadsheet formulas in exported event messages', () => {
    const csv = asCsv([event({ message: '=HYPERLINK("x")\nvalue' })]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")\nvalue"');
    expect(csv).toContain('1970-01-01T00:00:00.000Z');
  });
});
