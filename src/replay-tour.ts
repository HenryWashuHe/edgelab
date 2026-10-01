import {
  inspectLabRecording,
  type LabRecordingArtifact,
  type LabRecordingStep,
} from './lab-recording';
import type { Circuit, Outcome } from '../worker/engine';

export const BUILTIN_TOUR_HASH = 'ee884cdcefaedcd23c22eed275ec5088852beec2b6dd8ed323381d2cc908a082';
export const BUILTIN_TOUR_PRODUCER_VERSION = '3.6.0';
export const BUILTIN_TOUR_SOURCE_COMMIT = '3b0851c3b2c3e8b4ad5892be9bfb933215de7dc0';
const sourceRoot = `https://github.com/HenryWashuHe/edgelab/blob/${BUILTIN_TOUR_SOURCE_COMMIT}`;
export const BUILTIN_TOUR_RECORDING_URL = `${sourceRoot}/src/data/lab-recording-example.json`;
export const BUILTIN_TOUR_MANIFEST_URL = `${sourceRoot}/docs/evidence/releases/3.6.0-recording-runtime.json`;
export type RecordingOrigin = 'local-file' | 'controlled-runtime';
export type ReplayTourMilestoneId = 'concurrent-work' | 'new-run' | 'recovery-attempt';

export interface ReplayTourFacts {
  evaluated: number;
  settled: number;
  pending: number;
  originCalls: number;
  circuit: Circuit;
  consecutiveFailures: number;
  counts: Readonly<Record<Outcome, number>>;
}
export interface ReplayTourObservation {
  /** Zero-based selection index consumed by existing selectFrame. */
  index: number;
  /** One-based label for people reading the existing replay. */
  frameNumber: number;
  revision: number;
  runId: string;
  committedAt: number | null;
  serverFrameAt: number;
  receivedAt: number;
  runChanged: boolean;
  retainedEvents: number;
  facts: ReplayTourFacts;
}
export interface ReplayTourMilestone {
  id: ReplayTourMilestoneId;
  label: string;
  observation: ReplayTourObservation;
  /** Comparison is another captured state, never an interpolated future state. */
  comparison: ReplayTourObservation;
  summary: string;
  comparisonSummary: string;
  boundary: string;
}
export interface ReplayTour {
  producerVersion: typeof BUILTIN_TOUR_PRODUCER_VERSION;
  contentHash: typeof BUILTIN_TOUR_HASH;
  label: 'Historical controlled local workerd recording';
  milestones: readonly ReplayTourMilestone[];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function facts(step: LabRecordingStep): ReplayTourFacts {
  const { state } = step.latestData;
  const settled = Object.values(state.counts).reduce((sum, count) => sum + count, 0);
  return {
    evaluated: state.total,
    settled,
    pending: state.total - settled,
    originCalls: state.originCalls,
    circuit: state.circuit,
    consecutiveFailures: state.failures,
    counts: { ...state.counts },
  };
}
function observation(step: LabRecordingStep, index: number): ReplayTourObservation {
  return {
    index,
    frameNumber: index + 1,
    revision: step.latestData.revision,
    runId: step.latestData.runId,
    committedAt: step.latestData.committedAt,
    serverFrameAt: step.entry.frame.now,
    receivedAt: step.entry.receivedAt,
    runChanged: step.runChanged,
    retainedEvents: step.events.length,
    facts: facts(step),
  };
}

/**
 * Call only after strict importLabRecording succeeds. The source-action tag is
 * supplied by the built-in load action, never read from JSON or inferred by hash.
 * These gates prevent unrelated/imported recordings inheriting the sample tour;
 * they are not signatures or a substitute for the recording codec's validation.
 */
export function buildBuiltinReplayTour(
  recording: LabRecordingArtifact,
  origin: RecordingOrigin | null,
): ReplayTour | null {
  if (
    origin !== 'controlled-runtime' ||
    recording.contentHash !== BUILTIN_TOUR_HASH ||
    recording.producerVersion !== BUILTIN_TOUR_PRODUCER_VERSION ||
    recording.entries.length !== 25 ||
    recording.end.reason !== 'stopped' ||
    !Object.isFrozen(recording) ||
    !Object.isFrozen(recording.entries)
  )
    return null;

  const steps = recording.entries.map((_, index) => inspectLabRecording(recording, index));
  if (steps.some((step) => step.hasEarlierGap || !('state' in step.entry.frame))) return null;
  const firstRun = steps[0].latestData.runId;
  const concurrent = steps.findIndex((step) => {
    const value = facts(step);
    return (
      step.latestData.runId === firstRun &&
      value.evaluated === 2 &&
      value.settled === 0 &&
      value.pending === 2 &&
      value.originCalls === 2 &&
      value.circuit === 'closed'
    );
  });
  const completed = steps.findIndex((step, index) => {
    const value = facts(step);
    return (
      index > concurrent &&
      step.latestData.runId === firstRun &&
      value.evaluated === 2 &&
      value.settled === 2 &&
      value.pending === 0 &&
      value.counts.origin === 2
    );
  });
  const newRun = steps.findIndex((step, index) => {
    const value = facts(step);
    return (
      index > completed &&
      index > 0 &&
      step.runChanged &&
      steps[index - 1].latestData.runId === firstRun &&
      facts(steps[index - 1]).pending === 1 &&
      value.evaluated === 0 &&
      value.settled === 0 &&
      value.originCalls === 0 &&
      step.events.length === 0
    );
  });
  const opened = steps.findIndex((step, index) => {
    const value = facts(step);
    return (
      newRun >= 0 &&
      index > newRun &&
      step.latestData.runId === steps[newRun].latestData.runId &&
      value.circuit === 'open' &&
      value.counts.error === 1
    );
  });
  const recovering = steps.findIndex((step, index) => {
    const value = facts(step);
    return (
      opened >= 0 &&
      index > opened &&
      step.latestData.runId === steps[opened].latestData.runId &&
      value.circuit === 'half-open' &&
      value.evaluated === 2 &&
      value.settled === 1 &&
      value.pending === 1 &&
      value.originCalls === 2 &&
      value.counts.error === 1
    );
  });
  const recovered = recovering + 1;
  if (
    concurrent < 0 ||
    completed < 0 ||
    newRun < 1 ||
    opened < 0 ||
    recovering < 0 ||
    recovered >= steps.length
  )
    return null;
  const last = facts(steps[recovered]);
  if (
    steps[recovered].latestData.runId !== steps[recovering].latestData.runId ||
    steps[recovered].latestData.revision !== steps[recovering].latestData.revision + 1 ||
    last.circuit !== 'closed' ||
    last.evaluated !== 2 ||
    last.settled !== 2 ||
    last.pending !== 0 ||
    last.counts.origin !== 1 ||
    last.counts.error !== 1
  )
    return null;

  const reserved = observation(steps[concurrent], concurrent);
  const settled = observation(steps[completed], completed);
  const reset = observation(steps[newRun], newRun);
  const preceding = observation(steps[newRun - 1], newRun - 1);
  const probe = observation(steps[recovering], recovering);
  const recovery = observation(steps[recovered], recovered);
  return freeze({
    producerVersion: BUILTIN_TOUR_PRODUCER_VERSION,
    contentHash: BUILTIN_TOUR_HASH,
    label: 'Historical controlled local workerd recording',
    milestones: [
      {
        id: 'concurrent-work',
        label: 'Two pending requests',
        observation: reserved,
        comparison: settled,
        summary: `This captured state records ${reserved.facts.evaluated} evaluated requests, ${reserved.facts.settled} settled outcomes and ${reserved.facts.pending} pending requests.`,
        comparisonSummary: `Both requests are recorded as settled origin successes, with ${settled.facts.pending} pending requests.`,
        boundary:
          'These are captured source counts, not a throughput benchmark or a measurement of other locations.',
      },
      {
        id: 'new-run',
        label: 'A new run',
        observation: reset,
        comparison: preceding,
        summary: `The run identity has changed. This captured state has ${reset.facts.evaluated} evaluated requests and no retained outcomes.`,
        comparisonSummary: `The preceding captured state belongs to the earlier run, with ${preceding.facts.pending} pending request.`,
        boundary:
          'The run change is visible here. The late completion HTTP 409 and forced hibernation are verified separately by the controlled runtime recipe; they cannot be established from an absent frame.',
      },
      {
        id: 'recovery-attempt',
        label: 'A half-open attempt',
        observation: probe,
        comparison: recovery,
        summary: `This captured state records a half-open circuit and ${probe.facts.pending} pending request, following a recorded origin error.`,
        comparisonSummary: `The next captured state records an origin success, a closed circuit and ${recovery.facts.pending} pending requests.`,
        boundary:
          'This captured attempt does not by itself prove that every competing probe was excluded or establish later origin health.',
      },
    ],
  });
}

/** Origin comes from the load action. A file never inherits curated provenance. */
export function replaySourceDetails(
  recording: LabRecordingArtifact,
  origin: RecordingOrigin | null,
): { tour: ReplayTour | null; label: string; description: string } {
  const tour = buildBuiltinReplayTour(recording, origin);
  if (tour)
    return {
      tour,
      label: `Controlled local workerd recording · producer ${tour.producerVersion}.`,
      description:
        'This historical bundled capture comes from the pinned local runtime recipe and is validated again in your browser.',
    };
  if (origin === 'local-file')
    return {
      tour: null,
      label: 'Imported local file.',
      description:
        'This capture was supplied from your device; it is not the built-in runtime example.',
    };
  if (origin === 'controlled-runtime')
    return {
      tour: null,
      label: 'Bundled recording.',
      description:
        'This bundled capture passed local validation. No curated milestones match this content.',
    };
  return {
    tour: null,
    label: 'Validated recording.',
    description: 'This capture passed local validation; its load source is unavailable.',
  };
}
