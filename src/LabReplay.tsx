import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Fingerprint, LoaderCircle, X } from 'lucide-react';
import {
  importLabRecording,
  inspectLabRecording,
  MAX_LAB_RECORDING_BYTES,
  MAX_LAB_RECORDING_ENTRIES,
  type LabRecordingArtifact,
  type LabRecordingEndReason,
} from './lab-recording';
import type { Circuit, Outcome } from '../worker/engine';
import './lab-replay.css';

const outcomes: Record<Outcome, string> = {
  origin: 'Origin success',
  stale: 'Cached fallback',
  limited: 'Rate limited',
  blocked: 'Circuit blocked',
  error: 'Origin error',
};
const circuits: Record<Circuit, string> = {
  closed: 'Closed',
  open: 'Open',
  'half-open': 'Half-open',
};
const captureEnds: Record<LabRecordingEndReason, string> = {
  stopped: 'Recorder stopped',
  disconnected: 'Observer disconnected',
  interrupted: 'Capture interrupted',
  expired: 'Lab expiry reported',
  unavailable: 'Observer unavailable',
  'invalid-frame': 'Invalid frame received',
  'frame-limit': 'Frame limit reached',
  'byte-limit': 'Byte limit reached',
};
const INVALID_RECORDING = `This recording could not be validated. Choose a supported lab recording JSON file no larger than ${MAX_LAB_RECORDING_BYTES / 1024} KiB.`;
type RecordingOrigin = 'local-file' | 'controlled-runtime';
const utc = (at: number) => new Date(at).toISOString().replace('T', ' ').replace('Z', ' UTC');

function Time({ at }: { at: number | null }) {
  return at === null ? (
    <>Unavailable</>
  ) : (
    <time dateTime={new Date(at).toISOString()}>{utc(at)}</time>
  );
}

/** Local inspection only. This component never resumes or controls a lab. */
export function LabReplay({ exampleJson }: { exampleJson?: string } = {}) {
  const headingId = useId();
  const fileId = useId();
  const fileHelpId = useId();
  const rangeId = useId();
  const rangeHelpId = useId();
  const eventsId = useId();
  const [recording, setRecording] = useState<LabRecordingArtifact | null>(null);
  const [origin, setOrigin] = useState<RecordingOrigin | null>(null);
  const [selected, setSelected] = useState(0);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const importEpoch = useRef(0);
  const mounted = useRef(true);
  const selectedRef = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      importEpoch.current++;
    };
  }, []);

  async function loadRecording(nextOrigin: RecordingOrigin, readJson: () => Promise<string>) {
    const epoch = ++importEpoch.current;
    const current = () => mounted.current && importEpoch.current === epoch;
    setRecording(null);
    setOrigin(null);
    setSelected(0);
    selectedRef.current = 0;
    setError('');
    setAnnouncement('Validating the selected recording locally.');
    setReading(true);
    try {
      const json = await readJson();
      if (!current()) return;
      const imported = await importLabRecording(json);
      if (!current()) return;
      setRecording(imported);
      setOrigin(nextOrigin);
      setSelected(0);
      selectedRef.current = 0;
      const first = inspectLabRecording(imported, 0);
      setAnnouncement(
        `Recording loaded. Frame 1 of ${imported.entries.length}, recorded revision ${first.latestData.revision}.`,
      );
    } catch {
      if (!current()) return;
      setError(INVALID_RECORDING);
      setAnnouncement('The selected recording could not be validated.');
    } finally {
      if (current()) setReading(false);
    }
  }

  function importFile(file: File) {
    return loadRecording('local-file', async () => {
      if (file.size > MAX_LAB_RECORDING_BYTES) throw new Error('Recording exceeds file limit.');
      return file.text();
    });
  }

  function clear() {
    importEpoch.current++;
    setRecording(null);
    setOrigin(null);
    setSelected(0);
    selectedRef.current = 0;
    setReading(false);
    setError('');
    setAnnouncement('Local replay cleared.');
    if (fileInput.current) fileInput.current.value = '';
  }

  function selectFrame(index: number) {
    if (!recording || !Number.isInteger(index)) return;
    const next = Math.max(0, Math.min(recording.entries.length - 1, index));
    if (next === selectedRef.current) return;
    selectedRef.current = next;
    setSelected(next);
    const step = inspectLabRecording(recording, next);
    setAnnouncement(
      `Frame ${next + 1} of ${recording.entries.length}, ${step.entry.frame.kind}, recorded revision ${step.latestData.revision}${step.runChanged ? ', new run' : ''}.`,
    );
  }

  const step = useMemo(
    () => (recording ? inspectLabRecording(recording, selected) : null),
    [recording, selected],
  );
  const data = step?.latestData;
  const state = data?.state;
  const settled = state ? Object.values(state.counts).reduce((sum, value) => sum + value, 0) : 0;
  const terminal = !!step && !('state' in step.entry.frame);
  const rangeText = step
    ? `Frame ${selected + 1} of ${recording!.entries.length}, ${step.entry.frame.kind}, revision ${data!.revision}`
    : '';

  return (
    <section className="lab-replay" aria-labelledby={headingId}>
      <p className="replay-announcement" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="replay-heading">
        <span className="replay-label">
          <FileText size={15} /> LOCAL RECORDING / SYNTHETIC LAB
        </span>
        <h2 id={headingId}>Step through the observations.</h2>
        <p>
          Import a recording captured by the live observer. Each step displays recorded evidence; it
          does not run an experiment or connect to a lab.
        </p>
      </div>
      <div className="replay-import">
        <div>
          <label htmlFor={fileId}>Choose a lab recording JSON file</label>
          <input
            ref={fileInput}
            id={fileId}
            type="file"
            accept=".json,application/json"
            aria-describedby={fileHelpId}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void importFile(file);
              event.currentTarget.value = '';
            }}
          />
          <p id={fileHelpId}>
            Up to {MAX_LAB_RECORDING_BYTES / 1024} KiB and {MAX_LAB_RECORDING_ENTRIES} captured
            frames. The file is read locally into memory. Import another file to replace this
            replay.
          </p>
        </div>
        <div className="replay-import-actions">
          {exampleJson !== undefined && (
            <button
              className="button"
              onClick={() =>
                void loadRecording('controlled-runtime', () => Promise.resolve(exampleJson))
              }
            >
              <FileText size={14} /> Load controlled runtime recording
            </button>
          )}
          <button className="button" onClick={clear} disabled={!recording && !reading && !error}>
            <X size={14} /> Clear replay
          </button>
        </div>
      </div>
      {reading && (
        <p className="replay-reading">
          <LoaderCircle size={16} className="spin" /> Validating structure and checking the content
          hash locally.
        </p>
      )}
      {error && <p className="replay-error">{error}</p>}
      {recording && step && data && state ? (
        <>
          <p className="replay-notice">
            <strong>
              {origin === 'controlled-runtime'
                ? 'Controlled local workerd recording.'
                : 'Imported local file.'}
            </strong>{' '}
            {origin === 'controlled-runtime'
              ? 'This bundled capture comes from the controlled local runtime recipe and is validated again in your browser.'
              : 'This capture was supplied from your device; it is not the built-in runtime example.'}
          </p>
          <p className="replay-caution">
            <strong>Historical capture · source authenticity is not verified.</strong> The matching
            content hash detects changes to the recording content. Anyone can create a new file and
            hash; validation does not prove that Cloudflare produced these observations.
          </p>
          <p className="replay-capture-end">
            <strong>Recorded capture end: {captureEnds[recording.end.reason]}.</strong> Recorder end
            timestamp: <Time at={recording.end.at} />. Activity outside the capture is unknown.
          </p>
          <div className="replay-scrubber">
            <div className="replay-step-heading">
              <strong>
                Captured frame {selected + 1} of {recording.entries.length}
              </strong>
              <span>
                {step.entry.frame.kind} · run {data.runId.slice(0, 8)} · revision {data.revision}
              </span>
            </div>
            <label htmlFor={rangeId}>Select a captured frame</label>
            <input
              id={rangeId}
              type="range"
              min={0}
              max={recording.entries.length - 1}
              step={1}
              value={selected}
              disabled={recording.entries.length === 1}
              aria-valuetext={rangeText}
              aria-describedby={rangeHelpId}
              onChange={(event) => selectFrame(Number(event.currentTarget.value))}
            />
            <div className="replay-step-controls">
              <button
                className="button"
                onClick={() => selectFrame(selectedRef.current - 1)}
                disabled={selected === 0}
              >
                <ChevronLeft size={15} /> Previous frame
              </button>
              <button
                className="button"
                onClick={() => selectFrame(selectedRef.current + 1)}
                disabled={selected === recording.entries.length - 1}
              >
                Next frame <ChevronRight size={15} />
              </button>
            </div>
            <p id={rangeHelpId}>
              Use the arrow keys on the slider or step with the buttons. Only captured frames are
              shown; there is no timed playback or interpolation.
            </p>
          </div>
          {terminal && (
            <p className="replay-caution">
              <strong>Recorded channel event: {step.entry.frame.kind}.</strong> The figures below
              are the last observed state before this event, not a confirmed final outcome.
            </p>
          )}
          {step.runChanged && (
            <p className="replay-notice">
              A different run appears at this step. Its outcome list starts with evidence captured
              for that run.
            </p>
          )}
          {step.gapBefore ? (
            <p className="replay-gap">
              <strong>
                {step.gapBefore.count} unobserved{' '}
                {step.gapBefore.count === 1 ? 'revision' : 'revisions'} before this frame.
              </strong>{' '}
              Missing revisions: {step.gapBefore.fromRevision} to {step.gapBefore.toRevision}. No
              missing state or decisions are reconstructed.
            </p>
          ) : step.hasEarlierGap ? (
            <p className="replay-gap">
              This selected prefix contains earlier unobserved revisions. No intermediate states or
              decisions are reconstructed.
            </p>
          ) : null}
          <dl className="replay-times">
            <div>
              <dt>
                {terminal
                  ? 'Last observed state commit · server clock'
                  : 'Source state commit · server clock'}
              </dt>
              <dd>
                <Time at={data.committedAt} />
                {data.committedAt === null && (
                  <small>Legacy commit timestamp was not recorded.</small>
                )}
              </dd>
            </div>
            <div>
              <dt>Selected frame time · server clock</dt>
              <dd>
                <Time at={step.entry.frame.now} />
              </dd>
            </div>
            <div>
              <dt>Selected frame received · recorder clock</dt>
              <dd>
                <Time at={step.entry.receivedAt} />
              </dd>
            </div>
          </dl>
          <p className="replay-clock-note">
            Server and recorder clocks are separate. Receipt times may move backwards; frame order
            follows the recording sequence, not a calculated network delay.
          </p>
          <dl className="replay-metrics">
            <div>
              <dt>Recorded circuit</dt>
              <dd>{circuits[state.circuit]}</dd>
              <small>{state.failures} consecutive failures recorded</small>
            </div>
            <div>
              <dt>Recorded tokens</dt>
              <dd>
                {state.tokens.toFixed(1)} <span>/ {state.config.capacity}</span>
              </dd>
              <small>Recorded balance; no refill is simulated.</small>
            </div>
            <div>
              <dt>Settled / evaluated</dt>
              <dd>
                {settled} <span>/ {state.total}</span>
              </dd>
              <small>Totals in this recorded run snapshot</small>
            </div>
            <div>
              <dt>Recorded pending</dt>
              <dd>{Math.max(0, state.total - settled)}</dd>
              <small>Evaluated requests minus settled outcomes</small>
            </div>
          </dl>
          <dl className="replay-counts" aria-label="Recorded settled outcomes">
            {(Object.keys(outcomes) as Outcome[]).map((outcome) => (
              <div key={outcome}>
                <dt>{outcomes[outcome]}</dt>
                <dd>{state.counts[outcome]}</dd>
              </div>
            ))}
          </dl>
          <section className="replay-events" aria-labelledby={eventsId}>
            <div className="replay-events-heading">
              <h3 id={eventsId}>Outcomes through this frame</h3>
              <span>Latest {step.events.length} retained · newest first</span>
            </div>
            {step.events.length ? (
              <ol>
                {step.events.map((event) => (
                  <li key={`${data.runId}:${event.id}`}>
                    <div>
                      <strong className={`replay-outcome outcome-${event.outcome}`}>
                        {outcomes[event.outcome]}
                      </strong>
                      <span>
                        HTTP {event.status} · {event.latencyMs} ms
                      </span>
                    </div>
                    <div>
                      <Time at={event.at} />
                      <span>
                        Origin {event.originAttempted ? 'attempted' : 'bypassed'} · circuit{' '}
                        {circuits[event.circuit].toLowerCase()}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="replay-empty">
                No settled outcome rows are present in this captured prefix.
              </p>
            )}
            <p className="replay-events-note">
              The initial snapshot may include earlier outcomes. The list holds at most twelve rows
              for the selected run; recorded totals can cover more requests than this list.
            </p>
          </section>
          <details className="replay-provenance">
            <summary>
              <Fingerprint size={15} /> Recording provenance and limits
            </summary>
            <dl>
              <div>
                <dt>Producer / protocol</dt>
                <dd>
                  EdgeLab {recording.producerVersion} / {recording.protocol}
                </dd>
              </div>
              <div>
                <dt>Capture started · recorder clock</dt>
                <dd>
                  <Time at={recording.startedAt} />
                </dd>
              </div>
              <div>
                <dt>Last receipt · recorder clock</dt>
                <dd>
                  <Time at={recording.lastReceivedAt} />
                </dd>
              </div>
              <div>
                <dt>Capture ended</dt>
                <dd>
                  {captureEnds[recording.end.reason]} · <Time at={recording.end.at} />
                </dd>
              </div>
              <div className="replay-hash">
                <dt>Matching content fingerprint · SHA-256</dt>
                <dd>{recording.contentHash}</dd>
              </div>
            </dl>
            <p>
              This is a bounded capture, not complete run history. Unobserved activity before,
              between or after captured frames is unknown. Ending a capture does not prove that
              requests finished or the origin recovered.
            </p>
            <p>
              Only the validated observer projection is displayed. Import and hash verification do
              not authenticate the server, run an action, or prove a root cause.
            </p>
          </details>
        </>
      ) : !reading && !error ? (
        <div className="replay-empty">
          <FileText size={25} />
          <p>
            No recording is loaded. Choose an exported observer recording to inspect its captured
            frames.
          </p>
        </div>
      ) : null}
    </section>
  );
}
