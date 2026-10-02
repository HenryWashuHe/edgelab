import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowLeft, Radio, RotateCcw, Square } from 'lucide-react';
import {
  LAB_OBSERVER_CAPABILITY_PREFIX,
  LAB_OBSERVER_PROTOCOL,
  LAB_OBSERVER_SNAPSHOT_EVENTS,
  MAX_LAB_OBSERVER_FRAME_BYTES,
  MAX_LAB_OBSERVERS,
  parseLabObserverFrame,
  type LabObserverDataFrame,
  type LabObserverEvent,
} from '../worker/lab-observer';
import type { Circuit, Outcome } from '../worker/engine';
import { LAB_SESSION_KEY, readExistingLabSession } from './lab-session';
import {
  MAX_LAB_RECORDING_ENTRIES,
  appendLabRecording,
  beginLabRecording,
  exportLabRecording,
  finalizeLabRecording,
  type LabRecording,
  type LabRecordingEndReason,
} from './lab-recording';
import { saveFile } from './reports';
import './lab-observer.css';

type Connection =
  | 'missing'
  | 'storage-unavailable'
  | 'connecting'
  | 'awaiting-snapshot'
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'unavailable'
  | 'session-changed'
  | 'invalid-frame';

const outcomeNames: Record<Outcome, string> = {
  origin: 'Origin success',
  stale: 'Cached fallback',
  limited: 'Rate limited',
  blocked: 'Circuit blocked',
  error: 'Origin error',
};
const circuitNames: Record<Circuit, string> = {
  closed: 'Closed',
  open: 'Open',
  'half-open': 'Half-open',
};
const connectionNames: Record<Connection, string> = {
  missing: 'No shared lab session',
  'storage-unavailable': 'Browser storage unavailable',
  connecting: 'Connecting observer',
  'awaiting-snapshot': 'Waiting for a committed snapshot',
  connected: 'Connected · waiting for committed changes',
  disconnected: 'Observer disconnected',
  expired: 'Lab session expired',
  unavailable: 'Observer connection unavailable',
  'session-changed': 'Shared lab session changed',
  'invalid-frame': 'Observer evidence unavailable',
};
const connectionHelp: Record<Connection, string> = {
  missing: 'Open the resilience lab in this browser first, then return here to connect.',
  'storage-unavailable':
    'This browser cannot read the shared session. The main lab can still run with an in-memory session.',
  connecting: 'Connecting to the existing lab. No experiment commands are sent.',
  'awaiting-snapshot': 'The connection is open; current lab state has not been confirmed yet.',
  connected:
    'Changes arrive after the lab commits them. A quiet connection does not mean the lab has failed.',
  disconnected: 'Reconnect to retrieve a new snapshot. Experiment commands are never replayed.',
  expired: 'Observing does not renew the lab lease. Open the main lab to start another run.',
  unavailable:
    'Current lab state cannot be confirmed. Reconnect when ready; the browser cannot identify an upgrade failure.',
  'session-changed':
    'The old connection has been closed. Reconnect deliberately to observe the session now shared by this browser.',
  'invalid-frame':
    'The connection returned evidence that could not be validated and has been closed. Reconnect to request a new snapshot.',
};

function utc(at: number) {
  return new Date(at).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function mergeEvents(previous: LabObserverEvent[], incoming: LabObserverEvent[]) {
  const events = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) => b.id - a.id).slice(0, LAB_OBSERVER_SNAPSHOT_EVENTS);
}

export function LabObserver() {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [view, setView] = useState<LabObserverDataFrame | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [recording, setRecording] = useState<LabRecording | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const recordingRef = useRef<LabRecording | null>(null);
  const exportingRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const epoch = useRef(0);
  const capability = useRef<string | null>(null);
  const latest = useRef<LabObserverDataFrame | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearDeadline() {
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
  }

  function finishRecording(reason: LabRecordingEndReason) {
    const previous = recordingRef.current;
    if (!previous || previous.end) return;
    const next = finalizeLabRecording(previous, reason, Date.now());
    recordingRef.current = next;
    setRecording(next);
  }

  function recordFrame(frame: Parameters<typeof beginLabRecording>[0]) {
    const previous = recordingRef.current;
    if (previous?.end) return;
    const next = previous
      ? appendLabRecording(previous, frame, Date.now())
      : beginLabRecording(frame, Date.now(), '3.12.4');
    recordingRef.current = next;
    setRecording(next);
    if (next.end?.reason === 'frame-limit' || next.end?.reason === 'byte-limit')
      setAnnouncement('Recording reached its limit. Live observation can continue.');
    else if (next.end?.reason === 'invalid-frame')
      setAnnouncement('Recording stopped at an invalid frame. Its valid prefix is preserved.');
  }

  async function downloadRecording() {
    const candidate = recordingRef.current;
    if (!candidate?.end || exportingRef.current) return;
    const currentEpoch = epoch.current;
    exportingRef.current = true;
    setExporting(true);
    setExportNotice('');
    try {
      const { json } = await exportLabRecording(candidate);
      if (epoch.current !== currentEpoch) return;
      saveFile(json, 'application/json', `edgelab-recording-${candidate.startedAt}.json`);
      setExportNotice('Recording download started. Inspect the file in the offline viewer.');
    } catch {
      if (epoch.current === currentEpoch)
        setExportNotice('This recording could not be exported. No file was downloaded.');
    } finally {
      if (epoch.current === currentEpoch) {
        exportingRef.current = false;
        setExporting(false);
      }
    }
  }

  function disconnect(next: Connection, notice = connectionNames[next]) {
    finishRecording(
      next === 'expired' || next === 'unavailable' || next === 'invalid-frame'
        ? next
        : next === 'session-changed'
          ? 'interrupted'
          : 'disconnected',
    );
    epoch.current++;
    const interruptedExport = exportingRef.current;
    exportingRef.current = false;
    setExporting(false);
    if (interruptedExport)
      setExportNotice('The connection changed before export finished. Download again.');
    clearDeadline();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Observer disconnected');
    setConnection(next);
    setAnnouncement(notice);
  }

  function connect() {
    disconnect('connecting');
    recordingRef.current = null;
    setRecording(null);
    setExporting(false);
    setExportNotice('');
    const existing = readExistingLabSession();
    if (existing.status !== 'available') {
      setConnection(existing.status);
      setAnnouncement(connectionNames[existing.status]);
      return;
    }
    if (capability.current && capability.current !== existing.id) {
      latest.current = null;
      setView(null);
    }
    capability.current = existing.id;
    const currentEpoch = epoch.current;
    let receivedSnapshot = false;
    const url = new URL('/api/observe', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, [
        LAB_OBSERVER_PROTOCOL,
        `${LAB_OBSERVER_CAPABILITY_PREFIX}${existing.id}`,
      ]);
    } catch {
      disconnect('unavailable');
      return;
    }
    socketRef.current = socket;
    const current = () => epoch.current === currentEpoch && socketRef.current === socket;
    deadline.current = setTimeout(() => {
      if (current()) disconnect('unavailable');
    }, 12000);
    socket.onopen = () => {
      if (current()) setConnection('awaiting-snapshot');
    };
    socket.onmessage = (message) => {
      if (!current()) return;
      const frame =
        typeof message.data === 'string' && message.data.length <= MAX_LAB_OBSERVER_FRAME_BYTES
          ? parseLabObserverFrame(message.data)
          : null;
      if (
        !frame ||
        (!receivedSnapshot && frame.kind === 'update') ||
        (receivedSnapshot && frame.kind === 'snapshot')
      ) {
        disconnect('invalid-frame');
        return;
      }
      if (!('state' in frame)) {
        if (recordingRef.current) recordFrame(message.data);
        disconnect(frame.kind);
        return;
      }
      const previous = latest.current;
      // Revisions continue across resets within one connection. An older update
      // cannot restore a previous run, while a reconnect snapshot is authoritative.
      if (
        receivedSnapshot &&
        previous &&
        frame.kind === 'update' &&
        frame.revision <= previous.revision
      )
        return;
      try {
        // Record the original text before live normalization can discard names.
        recordFrame(message.data);
      } catch {
        disconnect('invalid-frame');
        return;
      }
      const newRun = !!previous && previous.runId !== frame.runId;
      const next = {
        ...frame,
        events:
          frame.kind === 'snapshot' || newRun || !previous
            ? frame.events
            : mergeEvents(previous.events, frame.events),
      };
      latest.current = next;
      setView(next);
      setConnection('connected');
      clearDeadline();
      if (newRun)
        setAnnouncement(
          `New lab run loaded, revision ${frame.revision}. Showing its recorded outcomes.`,
        );
      else if (!receivedSnapshot)
        setAnnouncement('Observer connected. Committed lab state loaded.');
      receivedSnapshot = true;
    };
    socket.onerror = () => {
      if (current()) disconnect('unavailable');
    };
    socket.onclose = (event) => {
      if (!current()) return;
      disconnect(event.code === 4001 ? 'expired' : 'unavailable');
    };
  }

  useEffect(() => {
    connect();
    const changed = (event: StorageEvent) => {
      if (event.key !== LAB_SESSION_KEY && event.key !== null) return;
      const existing = readExistingLabSession();
      if (
        capability.current &&
        (existing.status !== 'available' || existing.id !== capability.current)
      )
        disconnect('session-changed');
    };
    window.addEventListener('storage', changed);
    return () => {
      const previous = recordingRef.current;
      if (previous && !previous.end)
        recordingRef.current = finalizeLabRecording(previous, 'interrupted', Date.now());
      epoch.current++;
      exportingRef.current = false;
      clearDeadline();
      socketRef.current?.close(1000, 'Observer view closed');
      socketRef.current = null;
      window.removeEventListener('storage', changed);
    };
  }, []);

  const live = connection === 'connected';
  const connecting = connection === 'connecting' || connection === 'awaiting-snapshot';
  const state = view?.state;
  const settled = state ? Object.values(state.counts).reduce((sum, value) => sum + value, 0) : 0;

  return (
    <section className="lab-observer" aria-label="Live lab observer">
      <p className="observer-announcement" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="observer-intro">
        <span className="observer-label">
          <Radio size={15} /> SYNTHETIC RESILIENCE LAB
        </span>
        <p>Watch committed changes from another tab. Experiment commands remain in the main lab.</p>
        <a href="#playground">
          <ArrowLeft size={14} /> Open the main lab
        </a>
      </div>
      <div className={`observer-connection ${live ? 'is-connected' : ''}`}>
        <div>
          <strong>
            <span className="tiny-dot" /> {connectionNames[connection]}
          </strong>
          <p>{connectionHelp[connection]}</p>
        </div>
        <div className="observer-actions">
          <button className="button" onClick={connect} disabled={connecting || live}>
            <RotateCcw size={14} /> {view ? 'Reconnect observer' : 'Connect observer'}
          </button>
          <button
            className="button"
            onClick={() => disconnect('disconnected')}
            disabled={!live && !connecting}
          >
            <Square size={12} /> Disconnect
          </button>
        </div>
      </div>
      <section className="observer-recording" aria-labelledby="observer-recording-title">
        <div>
          <h2 id="observer-recording-title">Record this observed interval</h2>
          <p>
            {recording
              ? `${recording.entries.length} / ${MAX_LAB_RECORDING_ENTRIES} entries · ${recording.end ? `Stopped: ${recording.end.reason}` : 'Recording in memory'}`
              : 'Recording begins with a validated snapshot.'}
          </p>
          <small>
            At most 192 KiB. Download before reconnecting, leaving or reloading. Gaps stay unknown;
            the file is recorded evidence, not a complete backup.
          </small>
        </div>
        <div className="observer-actions">
          <button
            className="button"
            disabled={!recording || !!recording.end}
            onClick={() => {
              finishRecording('stopped');
              setAnnouncement('Recording stopped. Live observation can continue.');
            }}
          >
            <Square size={12} /> Stop recording
          </button>
          <button
            className="button"
            disabled={!recording?.end || exporting}
            onClick={downloadRecording}
          >
            <ArrowDownToLine size={14} /> {exporting ? 'Preparing file…' : 'Download recording'}
          </button>
          <a href="#replay">Inspect a recording</a>
        </div>
        <p className="observer-recording-notice" role="status" aria-live="polite">
          {exportNotice}
        </p>
      </section>
      {view && state ? (
        <>
          <div className="observer-provenance">
            <strong>
              {live ? 'Committed evidence' : 'Cached evidence · current state unconfirmed'}
            </strong>
            <span>
              Run {view.runId.slice(0, 8)} · revision {view.revision}
            </span>
            <span>
              {view.committedAt === null ? (
                'Commit timestamp unavailable for this legacy run.'
              ) : (
                <>
                  Committed{' '}
                  <time dateTime={new Date(view.committedAt).toISOString()}>
                    {utc(view.committedAt)}
                  </time>
                </>
              )}
            </span>
            <span>
              Frame time · server clock{' '}
              <time dateTime={new Date(view.now).toISOString()}>{utc(view.now)}</time>
            </span>
          </div>
          <dl className="observer-summary">
            <div>
              <dt>Circuit</dt>
              <dd>{circuitNames[state.circuit]}</dd>
              <small>{state.failures} consecutive failures</small>
            </div>
            <div>
              <dt>Committed tokens</dt>
              <dd>
                {state.tokens.toFixed(1)} <span>/ {state.config.capacity}</span>
              </dd>
              <small>Balance at commit; refill is not simulated.</small>
            </div>
            <div>
              <dt>Recorded outcomes</dt>
              <dd>
                {settled} <span>/ {state.total}</span>
              </dd>
              <small>{state.total} requests evaluated in this run</small>
            </div>
            <div>
              <dt>Unsettled outcomes</dt>
              <dd>{Math.max(0, state.total - settled)}</dd>
              <small>Evaluated requests without a recorded outcome; some may have finished.</small>
              <small>{state.originCalls} origin attempts in this run</small>
            </div>
          </dl>
          <dl className="observer-counts" aria-label="Recorded outcomes in this run">
            {(Object.keys(outcomeNames) as Outcome[]).map((outcome) => (
              <div key={outcome}>
                <dt>{outcomeNames[outcome]}</dt>
                <dd>{state.counts[outcome]}</dd>
              </div>
            ))}
          </dl>
          <section className="observer-events" aria-labelledby="observer-events-title">
            <div className="observer-events-heading">
              <h2 id="observer-events-title">
                <Activity size={16} /> Outcome rows in this view
              </h2>
              <span>Up to {LAB_OBSERVER_SNAPSHOT_EVENTS} · newest first</span>
            </div>
            {view.events.length ? (
              <ol>
                {view.events.map((event) => (
                  <li key={`${view.runId}:${event.id}`}>
                    <div>
                      <strong className={`observer-outcome outcome-${event.outcome}`}>
                        {outcomeNames[event.outcome]}
                      </strong>
                      <span>
                        HTTP {event.status} · {event.latencyMs} ms
                      </span>
                    </div>
                    <div>
                      <time dateTime={new Date(event.at).toISOString()}>{utc(event.at)}</time>
                      <span>
                        Origin {event.originAttempted ? 'attempted' : 'bypassed'} · circuit{' '}
                        {circuitNames[event.circuit].toLowerCase()}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="observer-empty">
                No outcome rows are present in this view. Send traffic from the main lab.
              </p>
            )}
          </section>
          <details className="observer-config">
            <summary>Observed configuration and owner lease</summary>
            <dl>
              <div>
                <dt>Injected origin</dt>
                <dd>{state.config.originMode}</dd>
              </div>
              <div>
                <dt>Origin delay / timeout</dt>
                <dd>
                  {state.config.originLatencyMs} / {state.config.originTimeoutMs} ms
                </dd>
              </div>
              <div>
                <dt>Cached fallback</dt>
                <dd>{state.config.staleFallback ? 'Enabled' : 'Disabled'}</dd>
              </div>
              <div>
                <dt>Recovery cooldown</dt>
                <dd>{state.config.cooldownMs} ms</dd>
              </div>
              <div>
                <dt>Captured lease expiry</dt>
                <dd>
                  <time dateTime={new Date(view.expiresAt).toISOString()}>
                    {utc(view.expiresAt)}
                  </time>
                </dd>
              </div>
            </dl>
            <p>
              Only main-lab HTTP activity renews this lease. The displayed expiry comes from the
              last received frame.
            </p>
          </details>
        </>
      ) : (
        <div className="observer-empty">
          <Radio size={24} />
          <p>No committed lab evidence has loaded.</p>
        </div>
      )}
      <p className="observer-footnote">
        Up to {MAX_LAB_OBSERVERS} observers can connect to one lab. This view sends no experiment
        commands. The shared session identifier still grants access to the existing HTTP controls.
      </p>
    </section>
  );
}
