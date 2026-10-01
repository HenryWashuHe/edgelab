import { describe, expect, it } from 'vitest';
import { importLabRecording, inspectLabRecording } from '../src/lab-recording';
import example from '../src/data/lab-recording-example.json';
import manifest from '../docs/evidence/releases/3.6.0-recording-runtime.json';

describe('pinned actual-runtime observer recording', () => {
  it('keeps the separately recorded content identity and coordination evidence', async () => {
    const recording = await importLabRecording(JSON.stringify(example));
    expect(recording.contentHash).toBe(manifest.recording.contentHash);
    expect(recording.entries).toHaveLength(manifest.recording.entries);
    expect(recording.end.reason).toBe('stopped');
    const steps = recording.entries.map((_, index) => inspectLabRecording(recording, index));
    expect(
      steps.some(
        ({ latestData: { state } }) =>
          state.total - Object.values(state.counts).reduce((sum, value) => sum + value, 0) === 2,
      ),
    ).toBe(true);
    const reset = steps.find((step) => step.runChanged);
    expect(reset?.events).toEqual([]);
    expect(reset?.latestData.state.total).toBe(0);
    expect(steps.some((step) => step.latestData.state.circuit === 'open')).toBe(true);
    expect(steps.some((step) => step.latestData.state.circuit === 'half-open')).toBe(true);
    expect(steps.at(-1)?.latestData.state.circuit).toBe('closed');
    expect(steps.every((step) => !step.hasEarlierGap)).toBe(true);
  });
});
