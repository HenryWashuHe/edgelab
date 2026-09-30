import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, FileSearch, LockKeyhole, RefreshCw, X } from 'lucide-react';
import type {
  IncidentCheck,
  IncidentDetail,
  IncidentNote,
  IncidentPolicyVersion,
} from '../worker/incident-evidence';
import './incident-workspace.css';

const when = (at: number | null) => (at === null ? 'Unavailable' : new Date(at).toLocaleString());
const lifecycleLabels = {
  'incident.opened': 'Failure threshold reached',
  'incident.acknowledged': 'Operator acknowledged',
  'incident.recovered': 'Recovery threshold reached',
};
function duration(from: number, to: number) {
  const minutes = Math.max(0, Math.floor((to - from) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/ops/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}
/** Evidence is scoped to the current credential so locking never leaves private notes visible. */
export function IncidentWorkspace({
  incidentId,
  serviceName,
  token,
  close,
}: {
  incidentId: string;
  serviceName: string;
  token: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<{ access: string; detail: IncidentDetail } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');
  const [submission, setSubmission] = useState<{ requestId: string; note: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const data = snapshot?.access === token ? snapshot.detail : null;

  async function load(before?: number) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const sequence = ++current.current;
    setBusy(true);
    setError('');
    try {
      const next = await api<IncidentDetail>(
        `incidents/${incidentId}${before === undefined ? '' : `?before=${before}`}`,
        token,
        { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) },
      );
      if (sequence !== current.current) return;
      setSnapshot((previous) => {
        if (before === undefined || previous?.access !== token)
          return { access: token, detail: next };
        const checks = new Map(previous.detail.checks.map((check) => [check.slot, check]));
        next.checks.forEach((check) => checks.set(check.slot, check));
        const versions = new Map(
          previous.detail.versions.map((version) => [version.revision, version]),
        );
        next.versions.forEach((version) => versions.set(version.revision, version));
        return {
          access: token,
          detail: {
            ...next,
            checks: [...checks.values()].sort((a, b) => b.slot - a.slot),
            versions: [...versions.values()].sort((a, b) => a.revision - b.revision),
          },
        };
      });
    } catch (e) {
      if (sequence === current.current && !abort.signal.aborted) setError((e as Error).message);
    } finally {
      if (sequence === current.current) setBusy(false);
    }
  }
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      element?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    setSnapshot(null);
    setDraft('');
    setSubmission(null);
    setNotice('');
    setSaving(false);
    savingRef.current = false;
    load();
    return () => {
      current.current++;
      controller.current?.abort();
    };
  }, [incidentId, token]);

  async function saveNote() {
    if (!token || savingRef.current || !data) return;
    savingRef.current = true;
    setSaving(true);
    setNotice('');
    setError('');
    const pending = submission ?? { requestId: crypto.randomUUID(), note: draft };
    setSubmission(pending);
    const sequence = current.current;
    try {
      const result = await api<{ ok: true; note: IncidentNote; alreadyRecorded?: boolean }>(
        'incident-note',
        token,
        {
          method: 'POST',
          body: JSON.stringify({ incident: incidentId, ...pending }),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (sequence !== current.current) return;
      setSnapshot((previous) =>
        previous?.access === token
          ? {
              ...previous,
              detail: {
                ...previous.detail,
                notes: [
                  ...(previous.detail.notes ?? []).filter((note) => note.id !== result.note.id),
                  result.note,
                ].sort((a, b) => a.at - b.at),
              },
            }
          : previous,
      );
      setDraft('');
      setSubmission(null);
      setNotice(
        result.alreadyRecorded
          ? 'The earlier submission was already recorded.'
          : 'Investigation note recorded.',
      );
    } catch (e) {
      if (sequence === current.current)
        setError(`${(e as Error).message} Retry will use the same submission ID.`);
    } finally {
      if (sequence === current.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <dialog
      ref={dialog}
      className="incident-workspace"
      aria-labelledby="incident-workspace-title"
      aria-describedby="incident-workspace-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="investigation-header">
        <div>
          <span className="investigation-eyebrow">
            <FileSearch size={15} /> INCIDENT INVESTIGATION
          </span>
          <h2 id="incident-workspace-title">{serviceName}</h2>
          <p id="incident-workspace-description">
            Persisted observations and decisions for this incident.
          </p>
          <small className="mono">{incidentId}</small>
        </div>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close incident investigation"
          autoFocus
        >
          <X size={21} />
        </button>
      </header>
      <div className="investigation-body">
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="ops-notice" role="status">
            <Check size={16} />
            {notice}
          </div>
        )}
        {!data ? (
          <div className="investigation-loading" role="status">
            {busy ? 'Loading incident evidence…' : 'Incident evidence could not be loaded.'}
            {!busy && (
              <button className="button" onClick={() => load()}>
                Retry loading evidence
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="investigation-summary">
              <div>
                <span>STATE</span>
                <strong>
                  {data.incident.resolved
                    ? 'Recovered'
                    : data.incident.acknowledged
                      ? 'Acknowledged'
                      : 'Investigating'}
                </strong>
              </div>
              <div>
                <span>DETECTED</span>
                <strong>{when(data.incident.opened)}</strong>
              </div>
              <div>
                <span>{data.incident.resolved ? 'OBSERVED DURATION' : 'OPEN FOR'}</span>
                <strong>
                  {duration(data.incident.opened, data.incident.resolved ?? Date.now())}
                </strong>
                <small>Between detection and recovery observations</small>
              </div>
            </div>
            <section className="investigation-section">
              <h3>Lifecycle</h3>
              <ol className="investigation-timeline">
                {data.lifecycle.map((event) => (
                  <li key={event.action}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{lifecycleLabels[event.action]}</strong>
                      <time dateTime={new Date(event.at).toISOString()}>{when(event.at)}</time>
                    </div>
                  </li>
                ))}
              </ol>
              <p className="investigation-help">
                Detection and recovery follow scheduled checks. These timestamps do not establish
                the exact start or end of an outage.
              </p>
            </section>
            <section className="investigation-section">
              <div className="investigation-section-heading">
                <h3>Observation evidence</h3>
                <button className="button" disabled={busy || saving} onClick={() => load()}>
                  <RefreshCw size={14} /> Refresh evidence
                </button>
              </div>
              <p className="investigation-help">
                Includes up to ten minutes before detection and observations around recovery.
                Scheduled minutes and actual observation times are shown separately; gaps have no
                fabricated check.
              </p>
              {data.range.limitedByRetention && (
                <p className="investigation-retention" role="status">
                  Earlier evidence has passed the 30-day retention boundary. Retained observations
                  start {when(data.range.retentionStart)}.
                </p>
              )}
              <div
                className="investigation-checks"
                role="region"
                aria-label="Incident observation table"
                tabIndex={0}
              >
                <table>
                  <caption>
                    {data.checks.length} retained observations loaded · newest first · your local
                    timezone
                  </caption>
                  <thead>
                    <tr>
                      <th>Scheduled minute</th>
                      <th>Observed at</th>
                      <th>Outcome / HTTP</th>
                      <th>Elapsed</th>
                      <th>Policy at observation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.checks.map((check) => (
                      <EvidenceRow
                        key={check.slot}
                        check={check}
                        version={data.versions.find(
                          (version) => version.revision === check.revision,
                        )}
                      />
                    ))}
                    {!data.checks.length && (
                      <tr>
                        <td colSpan={5}>
                          No retained observations in this incident’s evidence range.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {data.nextCursor !== null && (
                <button
                  className="button investigation-earlier"
                  disabled={busy || saving}
                  onClick={() => load(data.nextCursor!)}
                >
                  <ArrowDown size={14} />
                  {busy ? 'Loading earlier checks…' : 'Load earlier checks'}
                </button>
              )}
            </section>
            <section className="investigation-section investigation-notes">
              <h3>
                <LockKeyhole size={16} /> Private investigation notes
              </h3>
              {!token ? (
                <p className="investigation-help">
                  Unlock the Operator console to read and add private notes. Public incident
                  evidence remains available.
                </p>
              ) : (
                <>
                  {data.acknowledgementNote && (
                    <article className="investigation-note">
                      <div>
                        <strong>Acknowledgement</strong>
                        <time>{when(data.incident.acknowledged)}</time>
                      </div>
                      <p>{data.acknowledgementNote}</p>
                    </article>
                  )}
                  {data.notes?.map((note) => (
                    <article className="investigation-note" key={note.id}>
                      <div>
                        <strong>Investigation update</strong>
                        <time dateTime={new Date(note.at).toISOString()}>{when(note.at)}</time>
                      </div>
                      <p>{note.note}</p>
                    </article>
                  ))}
                  {!data.acknowledgementNote && !data.notes?.length && (
                    <p className="investigation-help">No private notes recorded yet.</p>
                  )}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveNote();
                    }}
                  >
                    <label htmlFor="investigation-note">Add an update or recovery analysis</label>
                    <textarea
                      id="investigation-note"
                      value={submission?.note ?? draft}
                      onChange={(event) => setDraft(event.target.value)}
                      readOnly={saving || submission !== null}
                      required
                      maxLength={500}
                      rows={4}
                      placeholder="Record evidence, decisions, or follow-up actions…"
                    />
                    <div className="investigation-note-actions">
                      <small>
                        {(submission?.note ?? draft).length}/500 · Notes are retained for 30 days.
                      </small>
                      <button
                        className="button primary"
                        disabled={saving || busy || !(submission?.note ?? draft).trim()}
                      >
                        {saving ? 'Recording…' : submission ? 'Retry same note' : 'Record note'}
                      </button>
                    </div>
                    {submission && !saving && (
                      <p className="investigation-help">
                        This pending note is preserved for a safe retry. A repeated submission
                        cannot create a second copy.
                      </p>
                    )}
                  </form>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </dialog>
  );
}
function EvidenceRow({
  check,
  version,
}: {
  check: IncidentCheck;
  version?: IncidentPolicyVersion;
}) {
  return (
    <tr>
      <td>
        <time dateTime={new Date(check.slot * 60000).toISOString()}>
          {when(check.slot * 60000)}
        </time>
      </td>
      <td>
        {check.observedAt === null ? (
          <span className="investigation-legacy">Legacy timing unavailable</span>
        ) : (
          <time dateTime={new Date(check.observedAt).toISOString()}>{when(check.observedAt)}</time>
        )}
      </td>
      <td>
        <span
          className={`check-label ${check.outcome === 'good' ? 'good' : check.outcome === 'maintenance' ? 'maintenance' : 'bad'}`}
        >
          {check.outcome}
        </span>
        <small className="investigation-http">HTTP {check.status ?? '—'}</small>
      </td>
      <td>{check.outcome === 'maintenance' ? '—' : `${check.latency} ms`}</td>
      <td>
        {version ? (
          <details className="investigation-policy">
            <summary>Revision {check.revision}</summary>
            <dl>
              <div>
                <dt>Latency objective</dt>
                <dd>{version.policy.latencyObjectiveMs} ms</dd>
              </div>
              <div>
                <dt>Timeout</dt>
                <dd>{version.policy.timeoutMs} ms</dd>
              </div>
              <div>
                <dt>Good-check target</dt>
                <dd>{version.policy.availabilityTarget}%</dd>
              </div>
              <div>
                <dt>Failure / recovery threshold</dt>
                <dd>
                  {version.policy.failureThreshold} / {version.policy.recoveryThreshold}
                </dd>
              </div>
              <div>
                <dt>Maintenance</dt>
                <dd>{version.policy.paused ? 'Paused' : 'Active'}</dd>
              </div>
              <div>
                <dt>Response contract</dt>
                <dd>{version.assertion}</dd>
              </div>
            </dl>
            {version.provenance !== 'recorded' && (
              <p className="investigation-help">
                Policy recovered during upgrade. Earlier unrecorded revisions cannot be
                reconstructed.
              </p>
            )}
          </details>
        ) : (
          <span className="investigation-legacy">
            Revision {check.revision}
            <br />
            Historical policy unavailable
          </span>
        )}
      </td>
    </tr>
  );
}
