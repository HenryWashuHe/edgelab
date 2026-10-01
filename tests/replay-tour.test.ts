import { describe, expect, it } from 'vitest';
import example from '../src/data/lab-recording-example.json';
import manifest from '../docs/evidence/releases/3.6.0-recording-runtime.json';
import { exportLabRecording, importLabRecording } from '../src/lab-recording';
import type { LabObserverDataFrame } from '../worker/lab-observer';
import {
  BUILTIN_TOUR_HASH,
  BUILTIN_TOUR_PRODUCER_VERSION,
  BUILTIN_TOUR_SOURCE_COMMIT,
  BUILTIN_TOUR_RECORDING_URL,
  BUILTIN_TOUR_MANIFEST_URL,
  buildBuiltinReplayTour,
  replaySourceDetails,
} from '../src/replay-tour';

const load = () => importLabRecording(JSON.stringify(example));

describe('milestones for the validated historical built-in recording', () => {
  it('pins the existing source identity and derives three exact recorded stops', async () => {
    const recording = await load();
    const tour = buildBuiltinReplayTour(recording, 'controlled-runtime');
    expect(BUILTIN_TOUR_HASH).toBe(manifest.recording.contentHash);
    expect(BUILTIN_TOUR_PRODUCER_VERSION).toBe(manifest.recordingProducerVersion);
    expect(tour).toMatchObject({
      contentHash: manifest.recording.contentHash,
      producerVersion: '3.6.0',
      label: 'Historical controlled local workerd recording',
    });
    expect(tour?.milestones.map(({ label }) => label)).toEqual([
      'Two pending requests',
      'A new run',
      'A half-open attempt',
    ]);
    expect(
      tour?.milestones.map(({ id, observation, comparison }) => ({
        id,
        index: observation.index,
        frame: observation.frameNumber,
        revision: observation.revision,
        comparisonFrame: comparison.frameNumber,
      })),
    ).toEqual([
      { id: 'concurrent-work', index: 6, frame: 7, revision: 7, comparisonFrame: 9 },
      { id: 'new-run', index: 14, frame: 15, revision: 15, comparisonFrame: 14 },
      { id: 'recovery-attempt', index: 23, frame: 24, revision: 24, comparisonFrame: 25 },
    ]);
  });

  it('keeps imported files generic even when the content exactly matches the built-in sample', async () => {
    const recording = await load();
    expect(buildBuiltinReplayTour(recording, 'local-file')).toBeNull();
    expect(buildBuiltinReplayTour(recording, null)).toBeNull();
    expect(buildBuiltinReplayTour(recording, 'controlled-runtime')).not.toBeNull();
    expect(replaySourceDetails(recording, 'local-file')).toMatchObject({
      tour: null,
      label: 'Imported local file.',
    });
    expect(replaySourceDetails(recording, null)).toMatchObject({
      tour: null,
      label: 'Validated recording.',
    });
    expect(replaySourceDetails(recording, 'controlled-runtime').label).toBe(
      'Controlled local workerd recording · producer 3.6.0.',
    );
  });

  it('records pending and settled source counts without inventing unobserved outcomes', async () => {
    const tour = buildBuiltinReplayTour(await load(), 'controlled-runtime')!;
    const concurrent = tour.milestones[0];
    expect(concurrent.observation.facts).toMatchObject({
      evaluated: 2,
      settled: 0,
      pending: 2,
      originCalls: 2,
      circuit: 'closed',
      counts: { origin: 0, stale: 0, limited: 0, blocked: 0, error: 0 },
    });
    expect(concurrent.observation.retainedEvents).toBe(0);
    expect(concurrent.comparison.facts).toMatchObject({
      evaluated: 2,
      settled: 2,
      pending: 0,
      counts: { origin: 2 },
    });
    expect(concurrent.comparison.retainedEvents).toBe(2);
  });

  it('scopes the new-run bookmark to the codec reset, without treating missing completion as proof', async () => {
    const tour = buildBuiltinReplayTour(await load(), 'controlled-runtime')!;
    const change = tour.milestones[1];
    expect(change.observation.runChanged).toBe(true);
    expect(change.observation.runId).not.toBe(change.comparison.runId);
    expect(change.observation.facts).toMatchObject({ evaluated: 0, settled: 0, pending: 0 });
    expect(change.observation.retainedEvents).toBe(0);
    expect(change.comparison.facts.pending).toBe(1);
    expect(change.boundary).toContain('cannot be established from an absent frame');
    expect(change.summary).not.toMatch(/409|hibernation|rejected|fenced/);
  });

  it('shows the recorded half-open attempt and adjacent completion without promising exclusive probes', async () => {
    const tour = buildBuiltinReplayTour(await load(), 'controlled-runtime')!;
    const recovery = tour.milestones[2];
    expect(recovery.observation.facts).toMatchObject({
      circuit: 'half-open',
      evaluated: 2,
      settled: 1,
      pending: 1,
      counts: { error: 1, origin: 0 },
    });
    expect(recovery.comparison.runId).toBe(recovery.observation.runId);
    expect(recovery.comparison.revision).toBe(recovery.observation.revision + 1);
    expect(recovery.comparison.facts).toMatchObject({
      circuit: 'closed',
      evaluated: 2,
      settled: 2,
      pending: 0,
      counts: { error: 1, origin: 1 },
    });
    expect(recovery.boundary).toContain('does not by itself prove');
  });

  it('preserves separate original server and recorder timestamps, without deriving latency', async () => {
    const recording = await load();
    const tour = buildBuiltinReplayTour(recording, 'controlled-runtime')!;
    for (const { observation, comparison } of tour.milestones) {
      for (const selected of [observation, comparison]) {
        const entry = recording.entries[selected.index];
        const frame = entry.frame as LabObserverDataFrame;
        expect(selected.committedAt).toBe(frame.committedAt);
        expect(selected.serverFrameAt).toBe(frame.now);
        expect(selected.receivedAt).toBe(entry.receivedAt);
        expect(selected).not.toHaveProperty('networkLatencyMs');
      }
    }
  });

  it('rejects changed valid rehashed data rather than lending it the original sample story', async () => {
    const recording = await load();
    const { contentHash: _oldHash, ...altered } = structuredClone(recording);
    (altered.entries[0].frame as LabObserverDataFrame).state.tokens = 11;
    const changed = await importLabRecording((await exportLabRecording(altered)).json);
    expect(changed.contentHash).not.toBe(BUILTIN_TOUR_HASH);
    expect(buildBuiltinReplayTour(changed, 'controlled-runtime')).toBeNull();
    expect(replaySourceDetails(changed, 'controlled-runtime')).toMatchObject({
      tour: null,
      label: 'Bundled recording.',
    });
    expect(replaySourceDetails(changed, 'controlled-runtime').description).not.toMatch(
      /controlled local|pinned|runtime recipe/,
    );
    expect((recording.entries[0].frame as LabObserverDataFrame).state.tokens).toBe(12);
  });

  it('does not promote an unvalidated mutable clone merely carrying the right hash', async () => {
    const recording = await load();
    expect(buildBuiltinReplayTour(structuredClone(recording), 'controlled-runtime')).toBeNull();
  });

  it('requires the exact producer, stopped capture and full pinned frame count', async () => {
    const recording = await load();
    const mismatches = [
      Object.freeze({ ...recording, producerVersion: '3.9.0' }),
      Object.freeze({
        ...recording,
        end: { reason: 'disconnected' as const, at: recording.end.at },
      }),
      Object.freeze({ ...recording, entries: Object.freeze(recording.entries.slice(0, -1)) }),
    ];
    for (const changed of mismatches)
      expect(buildBuiltinReplayTour(changed, 'controlled-runtime')).toBeNull();
  });

  it('defensively rejects contradictory milestone facts even when a caller claims the pinned hash', async () => {
    const recording = await load();
    // These are not codec-validated artifacts: the helper's defensive facts gate
    // must not be mistaken for recomputing or authenticating their claimed hash.
    for (const index of [6, 14, 23, 24]) {
      const changed = structuredClone(recording);
      const frame = changed.entries[index].frame as LabObserverDataFrame;
      if (index === 6) {
        frame.state.total = 1;
        frame.state.originCalls = 1;
      } else if (index === 14)
        frame.runId = (recording.entries[0].frame as LabObserverDataFrame).runId;
      else if (index === 23) frame.state.circuit = 'open';
      else frame.state.circuit = 'half-open';
      Object.freeze(changed.entries);
      Object.freeze(changed);
      expect(buildBuiltinReplayTour(changed, 'controlled-runtime')).toBeNull();
    }
  });

  it('does not mutate input and returns immutable facts and bookmark positions', async () => {
    const recording = await load();
    const before = JSON.stringify(recording);
    const tour = buildBuiltinReplayTour(recording, 'controlled-runtime')!;
    expect(JSON.stringify(recording)).toBe(before);
    expect(Object.isFrozen(tour)).toBe(true);
    expect(Object.isFrozen(tour.milestones)).toBe(true);
    for (const milestone of tour.milestones) {
      expect(Object.isFrozen(milestone)).toBe(true);
      expect(Object.isFrozen(milestone.observation)).toBe(true);
      expect(Object.isFrozen(milestone.observation.facts.counts)).toBe(true);
    }
    expect(() => {
      tour.milestones[0].observation.index = 100;
    }).toThrow();
  });

  it('separates selected milestone facts from actual comparison-frame facts', async () => {
    const tour = buildBuiltinReplayTour(await load(), 'controlled-runtime')!;
    const [pending, newRun, recovery] = tour.milestones;
    expect(pending.summary).toContain('0 settled outcomes and 2 pending requests');
    expect(pending.comparisonSummary).toContain('settled origin successes');
    expect(newRun.summary).toContain('no retained outcomes');
    expect(newRun.comparisonSummary).toContain('earlier run');
    expect(recovery.summary).toContain('half-open circuit and 1 pending request');
    expect(recovery.comparisonSummary).toContain('closed circuit and 0 pending requests');
    for (const milestone of tour.milestones)
      expect(milestone.comparison.index).not.toBe(milestone.observation.index);
  });

  it('links the historical source and separate runtime manifest at the verified fixed commit', () => {
    expect(BUILTIN_TOUR_SOURCE_COMMIT).toBe('3b0851c3b2c3e8b4ad5892be9bfb933215de7dc0');
    const base = `https://github.com/HenryWashuHe/edgelab/blob/${BUILTIN_TOUR_SOURCE_COMMIT}/`;
    expect(BUILTIN_TOUR_RECORDING_URL).toBe(`${base}src/data/lab-recording-example.json`);
    expect(BUILTIN_TOUR_MANIFEST_URL).toBe(
      `${base}docs/evidence/releases/3.6.0-recording-runtime.json`,
    );
    expect(BUILTIN_TOUR_RECORDING_URL).not.toContain('/main/');
  });
});
