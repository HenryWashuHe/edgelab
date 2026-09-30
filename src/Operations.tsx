import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Clock3,
  LockKeyhole,
  RefreshCw,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { OperationsSnapshot } from '../worker/monitor';
import type { MonitorPolicy } from '../worker/monitor-domain';
import { IncidentWorkspace, type PendingIncidentNote } from './IncidentWorkspace';
import { BudgetSignalsPanel } from './BudgetSignalsPanel';
import { monitoringReadiness, MONITOR_FRESHNESS_MS } from '../worker/monitor-readiness';
import './operations.css';
type Service = OperationsSnapshot['services'][number];
type Incident = OperationsSnapshot['incidents'][number];
type Audit = {
  events: { id: number; at: number; action: string; service: string; detail: unknown }[];
  incidents: (Incident & { note: string })[];
};
const when = (time: number | null) => (time === null ? '—' : new Date(time).toLocaleString());
const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}%`);
const labels: Record<string, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  incident: 'Incident open',
  unknown: 'Awaiting checks',
  maintenance: 'Maintenance',
};
class OperationsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  token = '',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/ops/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new OperationsRequestError(
      data.error || `Request failed (${response.status})`,
      response.status,
    );
  return data;
}
export function Operations() {
  const [data, setData] = useState<OperationsSnapshot | null>(null);
  const [, setAgeNow] = useState(0);
  const receivedAt = useRef(0);
  const [windowSize, setWindowSize] = useState('24h');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [formErrorOwner, setFormErrorOwner] = useState<object | null>(null);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('services');
  const [selected, setSelected] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [credential, setCredential] = useState('');
  const [audit, setAudit] = useState<Audit | null>(null);
  const [auditWarning, setAuditWarning] = useState('');
  const [pendingNotes, setPendingNotes] = useState<Record<string, PendingIncidentNote>>({});
  const operatorSession = useRef({ token: '', generation: 0 });
  const privateReads = useRef(new Set<AbortController>());
  const actionSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const policyForm = useRef<Service | null>(null);
  const [acknowledging, setAcknowledging] = useState<Incident | null>(null);
  const [acknowledgementNotice, setAcknowledgementNotice] = useState('');
  const acknowledgementForm = useRef<Incident | null>(null);
  const [investigating, setInvestigating] = useState<Incident | null>(null);
  const [note, setNote] = useState('');
  const latest = useRef(0);
  const mounted = useRef(true);
  async function refresh() {
    const sequence = ++latest.current;
    const requestStartedAt = performance.now();
    try {
      const next = await request<OperationsSnapshot>(`status?window=${windowSize}`);
      if (mounted.current && sequence === latest.current) {
        receivedAt.current = requestStartedAt;
        setAgeNow(performance.now());
        setData(next);
        setError('');
      }
    } catch (e) {
      if (mounted.current && sequence === latest.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        setAgeNow(performance.now());
        refresh();
      }
    }, 15000);
    const visible = () => {
      if (document.visibilityState === 'visible') {
        setAgeNow(performance.now());
        refresh();
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false;
      latest.current++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [windowSize]);
  useEffect(
    () => () => {
      actionSequence.current++;
      abortPrivateReads();
      operatorSession.current = { token: '', generation: operatorSession.current.generation + 1 };
    },
    [],
  );
  async function action(
    fn: () => Promise<void | 'unchanged'>,
    options: {
      mutation?: 'policy' | 'acknowledgement';
      auditAfterSuccess?: boolean;
      dialog?: object;
      source?: string;
    } = {},
  ) {
    if (saving.current) return;
    const sequence = ++actionSequence.current;
    const active = () => mounted.current && sequence === actionSequence.current;
    saving.current = true;
    setFormError('');
    setFormErrorOwner(null);
    setAuditWarning('');
    setBusy(true);
    setNotice('');
    let succeeded = false;
    let changed = false;
    try {
      try {
        const result = await fn();
        succeeded = true;
        changed = result !== 'unchanged';
      } catch (e) {
        if (active()) {
          const message = (e as Error).message;
          const originalFormOpen =
            options.dialog !== undefined &&
            (policyForm.current === options.dialog ||
              acknowledgementForm.current === options.dialog);
          const preserved = originalFormOpen ? 'Your draft is preserved. ' : '';
          const failure =
            options.mutation && !(e instanceof OperationsRequestError)
              ? `The ${options.mutation} save could not be confirmed. ${message} ${preserved}Check the refreshed observations before retrying.`
              : e instanceof OperationsRequestError && e.status === 409
                ? `${message} ${preserved}Review the current ${options.mutation === 'acknowledgement' ? 'incident state' : 'revision'} before retrying.`
                : message;
          setFormError(`${options.source ? `${options.source}: ` : ''}${failure}`);
          setFormErrorOwner(options.dialog ?? null);
        }
      }
      if (active()) {
        // A write confirmation stands independently of these follow-up reads.
        // Even a rejected or ambiguous write refreshes the authoritative public revision.
        const reads: Promise<unknown>[] = [refresh()];
        if (succeeded && options.auditAfterSuccess) reads.push(loadAudit());
        const results = await Promise.allSettled(reads);
        if (active() && results[1]?.status === 'rejected')
          setAuditWarning(
            `${changed ? 'Saved; audit refresh unavailable.' : 'Audit refresh unavailable.'} Use Refresh audit to load the latest audit trail.`,
          );
      }
    } finally {
      if (active()) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  function abortPrivateReads() {
    privateReads.current.forEach((controller) => controller.abort());
    privateReads.current.clear();
  }
  async function readAudit(key: string) {
    const controller = new AbortController();
    privateReads.current.add(controller);
    try {
      return await request<Audit>('audit', key, undefined, controller.signal);
    } finally {
      privateReads.current.delete(controller);
    }
  }
  async function loadAudit() {
    const session = operatorSession.current;
    if (!session.token) return;
    const next = await readAudit(session.token);
    if (!mounted.current || operatorSession.current !== session) return;
    setAudit(next);
    setAuditWarning('');
  }
  function lockOperator() {
    abortPrivateReads();
    operatorSession.current = { token: '', generation: operatorSession.current.generation + 1 };
    actionSequence.current++;
    saving.current = false;
    setBusy(false);
    setToken('');
    setCredential('');
    setAudit(null);
    setAuditWarning('');
    setPendingNotes({});
    setNote('');
    setAcknowledgementNotice('');
    setEditing(null);
    policyForm.current = null;
    acknowledgementForm.current = null;
    setAcknowledging(null);
    setInvestigating(null);
    setFormError('');
    setFormErrorOwner(null);
    setNotice('Operator session locked.');
  }
  function openPolicy(value: Service) {
    // Each opening has its own identity, even when the snapshot has not changed.
    const form = { ...value };
    policyForm.current = form;
    setEditing(form);
  }
  function closePolicy() {
    policyForm.current = null;
    setEditing(null);
  }
  function openAcknowledgement(value: Incident) {
    const form = { ...value };
    acknowledgementForm.current = form;
    setAcknowledging(form);
    setNote('');
    setAcknowledgementNotice('');
  }
  function closeAcknowledgement() {
    acknowledgementForm.current = null;
    setAcknowledging(null);
  }
  // Age cached evidence even if a subsequent HTTP refresh fails. Use a monotonic
  // elapsed interval with the server snapshot time, avoiding browser clock skew.
  const snapshotAge = data ? Math.max(0, performance.now() - receivedAt.current) : 0;
  const displayNow = data ? data.now + snapshotAge : 0;
  const freshServerSnapshot = data !== null && snapshotAge <= MONITOR_FRESHNESS_MS;
  const renderedOperatorSession = operatorSession.current;
  const monitoring = data
    ? monitoringReadiness({
        now: displayNow,
        lastStartedAt: data.monitoring.lastStartedAt,
        lastCompletedAt: data.monitoring.lastCompletedAt,
        lastSlot: data.monitoring.lastSlot,
        services: data.services.map((s) => ({
          paused: s.policy.paused,
          lastObservedAt: s.latest?.revision === s.revision ? s.latest.observedAt : null,
        })),
      })
    : undefined;
  const observedStatus = (s: Service) =>
    s.policy.paused
      ? 'maintenance'
      : !s.latest ||
          s.latest.observedAt === null ||
          displayNow - s.latest.observedAt > MONITOR_FRESHNESS_MS
        ? 'unknown'
        : s.status;
  const open = data?.incidents.filter((i) => !i.resolved) ?? [];
  const service = data?.services.find((s) => s.id === selected) ?? data?.services[0];
  const currentAcknowledgement = acknowledging
    ? data?.incidents.find((incident) => incident.id === acknowledging.id)
    : undefined;
  const missing = data?.services.reduce((sum, s) => sum + s.metrics.missing, 0) ?? 0;
  const checks = data?.services.reduce((sum, s) => sum + s.metrics.observed, 0) ?? 0;
  return (
    <div className="ops">
      <div className="ops-command">
        <span className="ops-live">
          <span className="tiny-dot" /> AUTOMATED · EVERY MINUTE
        </span>
        <div className="ops-toolbar">
          <label className="sr-only" htmlFor="ops-window">
            Reporting window
          </label>
          <select
            id="ops-window"
            value={windowSize}
            onChange={(e) => setWindowSize(e.target.value)}
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
          </select>
          <button className="button" onClick={() => refresh()} aria-label="Refresh monitoring">
            <RefreshCw size={15} />
          </button>
          <a
            className="button"
            href={`/api/ops/export?window=${windowSize}`}
            download="edgelab-operations.json"
          >
            <ArrowDownToLine size={15} /> Export
          </a>
        </div>
      </div>
      {formError && (
        <div className="error-banner" role="alert">
          {formError}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          Status refresh unavailable: {error}. Cached observations are shown; current monitoring
          cannot be confirmed.
        </div>
      )}
      {auditWarning && (
        <div className="error-banner" role="alert">
          {auditWarning}
        </div>
      )}
      {notice && (
        <div className="ops-notice" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {monitoring && (
        <div className={`ops-monitoring ${monitoring.status}`} role="status">
          <div>
            <strong>
              {error
                ? monitoring.status === 'stalled'
                  ? 'Cached monitoring evidence has expired'
                  : 'Current monitoring cannot be confirmed'
                : monitoring.status === 'healthy'
                  ? 'Monitoring is current'
                  : monitoring.status === 'starting'
                    ? 'Waiting for the first scheduled run'
                    : monitoring.status === 'partial'
                      ? 'Some observations need attention'
                      : freshServerSnapshot && data?.monitoring.status === 'stalled'
                        ? 'Monitoring has stalled'
                        : 'Cached monitoring evidence has expired'}
            </strong>
            <p>
              {error || !freshServerSnapshot
                ? 'Showing evidence from the last successful status response. Reconnect or refresh to verify current monitoring.'
                : monitoring.reason}{' '}
              Dashboard refreshes do not renew monitoring evidence.
            </p>
          </div>
          {monitoring.lastCompletedAt !== null && (
            <time dateTime={new Date(monitoring.lastCompletedAt).toISOString()}>
              Last completed run {when(monitoring.lastCompletedAt)}
            </time>
          )}
        </div>
      )}
      <div className="ops-overview">
        <div>
          <span>MONITORED SERVICES</span>
          <strong>{data?.services.length ?? '—'}</strong>
          <small>Private bindings + HTTPS</small>
        </div>
        <div>
          <span>OPEN INCIDENTS</span>
          <strong className={open.length ? 'ops-red' : 'ops-green'}>
            {data ? open.length : '—'}
          </strong>
          <small>{open.length ? 'Investigation required' : 'No detected active incidents'}</small>
        </div>
        <div>
          <span>OBSERVED CHECKS</span>
          <strong>{data ? checks.toLocaleString() : '—'}</strong>
          <small>Verified finished minutes · {windowSize}</small>
        </div>
        <div>
          <span>MISSING CHECKS</span>
          <strong className={missing ? 'ops-amber' : ''}>
            {data ? missing.toLocaleString() : '—'}
          </strong>
          <small>Unknown, never counted as healthy</small>
        </div>
      </div>
      <div className="ops-tabs" role="tablist" aria-label="Operations views">
        {[
          ['services', 'Services'],
          ['incidents', `Incidents${open.length ? ` · ${open.length}` : ''}`],
          ['methodology', 'Methodology'],
          ['operator', 'Operator'],
        ].map(([id, label]) => (
          <button
            key={id}
            id={`ops-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onKeyDown={(e) => {
              const ids = ['services', 'incidents', 'methodology', 'operator'];
              const index = ids.indexOf(id);
              const next =
                e.key === 'ArrowRight'
                  ? ids[(index + 1) % 4]
                  : e.key === 'ArrowLeft'
                    ? ids[(index + 3) % 4]
                    : e.key === 'Home'
                      ? ids[0]
                      : e.key === 'End'
                        ? ids[3]
                        : null;
              if (next) {
                e.preventDefault();
                setTab(next);
                document.getElementById(`ops-tab-${next}`)?.focus();
              }
            }}
            aria-controls="ops-view"
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'operator' && <LockKeyhole size={13} />}
          </button>
        ))}
      </div>
      <div id="ops-view" role="tabpanel" aria-labelledby={`ops-tab-${tab}`}>
        {tab === 'services' && (
          <>
            {!data ? (
              <div className="ops-empty">Connecting to the monitoring coordinator…</div>
            ) : !data.services.length ? (
              <div className="ops-empty">
                No services configured. Add deployment-approved targets in wrangler.jsonc.
              </div>
            ) : (
              <>
                <div className="service-grid">
                  {data.services.map((s) => (
                    <button
                      className={`service-card ${service?.id === s.id ? 'selected' : ''}`}
                      key={s.id}
                      onClick={() => setSelected(s.id)}
                      aria-pressed={service?.id === s.id}
                    >
                      <div className="service-title">
                        <span className="service-icon">
                          <Activity size={20} />
                        </span>
                        <span>
                          <strong>{s.name}</strong>
                          <small>
                            {s.transport === 'origin'
                              ? 'Private service binding'
                              : 'Public HTTPS endpoint'}
                          </small>
                        </span>
                        <span className={`health-badge ${observedStatus(s)}`}>
                          {labels[observedStatus(s)]}
                        </span>
                      </div>
                      <div className="service-metrics">
                        <div>
                          <span>Good-check ratio</span>
                          <b>{percent(s.metrics.goodRatio)}</b>
                        </div>
                        <div>
                          <span>Coverage</span>
                          <b>{percent(s.metrics.coverage)}</b>
                        </div>
                        <div>
                          <span>P95 latency</span>
                          <b>{s.metrics.p95Ms === null ? '—' : `${s.metrics.p95Ms} ms`}</b>
                        </div>
                      </div>
                      <CheckStrip service={s} now={displayNow} />
                      <div className="service-foot">
                        <span>Last 60 minutes</span>
                        <span>
                          {s.latest
                            ? s.latest.observedAt === null
                              ? 'Legacy timing unverified'
                              : `Observed ${new Date(s.latest.observedAt).toLocaleTimeString()}`
                            : 'First check pending'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
                {service && (
                  <section className="panel service-detail">
                    <div className="panel-heading">
                      <h2>
                        {service.name} <span className="ops-muted">/ reliability record</span>
                      </h2>
                      {token && (
                        <button className="button" onClick={() => openPolicy(service)}>
                          <Settings2 size={15} /> Edit policy
                        </button>
                      )}
                    </div>
                    <div className="detail-grid">
                      <div>
                        <span>Good-check objective</span>
                        <strong>{service.policy.availabilityTarget}%</strong>
                        <small>
                          HTTP 200 + valid body within {service.policy.latencyObjectiveMs} ms
                        </small>
                      </div>
                      <div>
                        <span>Error budget consumed</span>
                        <strong
                          className={(service.metrics.budgetConsumed ?? 0) > 100 ? 'ops-red' : ''}
                        >
                          {percent(service.metrics.budgetConsumed)}
                        </strong>
                        <small>Bad observations / allowed bad observations</small>
                      </div>
                      <div>
                        <span>Coverage</span>
                        <strong>
                          {service.metrics.observed} /{' '}
                          {service.metrics.expected - service.metrics.maintenance}
                        </strong>
                        <small>
                          {service.metrics.maintenance} maintenance · {service.metrics.missing}{' '}
                          missing
                          {service.metrics.unverified > 0 &&
                            ` · ${service.metrics.unverified} unverified legacy checks`}
                        </small>
                      </div>
                    </div>
                    {!service.metrics.observed && (
                      <p className="ops-empty compact">
                        No verified completed-minute observations in this window yet. Reliability
                        values appear after scheduled checks arrive. Legacy checks with unverified
                        observation timing are excluded from the SLO.
                      </p>
                    )}
                    <BudgetSignalsPanel budget={service.budget} snapshotNow={displayNow} />
                    <div className="ops-chart-heading">
                      <h3>Observation history</h3>
                      <div className="ops-legend">
                        <span>
                          <i className="good" />
                          Good
                        </span>
                        <span>
                          <i className="bad" />
                          Bad
                        </span>
                        <span>
                          <i className="maintenance" />
                          Maintenance
                        </span>
                        <span>
                          <i />
                          Unknown / unverified
                        </span>
                      </div>
                    </div>
                    <HourlyChart service={service} />
                    <div className="ops-table-wrap">
                      <table>
                        <caption>
                          Latest scheduled checks · timestamps in your local timezone
                        </caption>
                        <thead>
                          <tr>
                            <th>Scheduled minute</th>
                            <th>Observed at</th>
                            <th>Result</th>
                            <th>HTTP</th>
                            <th>Elapsed</th>
                            <th>Policy</th>
                          </tr>
                        </thead>
                        <tbody>
                          {service.history.slice(0, 10).map((c) => (
                            <tr key={c.slot}>
                              <td>{when(c.slot * 60000)}</td>
                              <td>
                                {c.observedAt === null
                                  ? 'Legacy timing unavailable'
                                  : when(c.observedAt)}
                              </td>
                              <td>
                                <span
                                  className={`check-label ${c.outcome === 'good' ? 'good' : c.outcome === 'maintenance' ? 'maintenance' : 'bad'}`}
                                >
                                  {c.outcome}
                                </span>
                              </td>
                              <td>{c.status ?? '—'}</td>
                              <td>{c.outcome === 'maintenance' ? '—' : `${c.latency} ms`}</td>
                              <td>v{c.revision}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="ops-policy-summary">
                      <Clock3 size={15} /> Incident after {service.policy.failureThreshold}{' '}
                      consecutive bad checks · recovery after {service.policy.recoveryThreshold}{' '}
                      good checks · timeout {service.policy.timeoutMs} ms
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
        {tab === 'incidents' && (
          <section className="panel ops-section">
            <div className="panel-heading">
              <h2>Incident timeline</h2>
              <span className="badge">30-DAY RETENTION</span>
            </div>
            <p className="ops-intro">
              Incidents follow measured failures and recoveries. Acknowledging records ownership;
              recovery requires successful checks.
            </p>
            {!data?.incidents.length ? (
              <div className="ops-empty">
                <ShieldCheck size={30} />
                <h3>No recorded incidents</h3>
                <p>
                  There is no invented history. Incidents appear after a service crosses its failure
                  threshold.
                </p>
              </div>
            ) : (
              <div className="incident-list">
                {data.incidents.map((i) => (
                  <article key={i.id} className="incident">
                    <div className={`incident-marker ${i.resolved ? 'resolved' : ''}`} />
                    <div>
                      <div className="incident-title">
                        <h3>{data.services.find((s) => s.id === i.service)?.name ?? i.service}</h3>
                        <span className={`health-badge ${i.resolved ? 'healthy' : 'incident'}`}>
                          {i.resolved
                            ? 'Recovered'
                            : i.acknowledged
                              ? 'Acknowledged'
                              : 'Investigating'}
                        </span>
                      </div>
                      <p>
                        Detected {when(i.opened)}
                        {i.resolved ? ` · Recovered ${when(i.resolved)}` : ''}
                      </p>
                      <small className="mono">{i.id}</small>
                      {i.acknowledged && (
                        <p className="ops-muted">Acknowledged {when(i.acknowledged)}</p>
                      )}
                      <div className="incident-actions">
                        <button className="button" onClick={() => setInvestigating(i)}>
                          Inspect incident evidence
                        </button>
                        {!i.resolved &&
                          !i.acknowledged &&
                          (token ? (
                            <button className="button" onClick={() => openAcknowledgement(i)}>
                              Acknowledge incident
                            </button>
                          ) : (
                            <p className="ops-muted">
                              Operator authentication required to acknowledge.
                            </p>
                          ))}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
        {tab === 'methodology' && (
          <section className="panel ops-section methodology">
            <h2>Evidence before confidence.</h2>
            <p>
              EdgeLab runs a real check every minute from a Durable Object coordinator. The
              dashboard reads persisted observations; it does not generate monitoring traffic.
            </p>
            <div className="method-grid">
              <article>
                <h3>What counts as good?</h3>
                <p>
                  HTTP 200, a validated JSON contract, and completion within the service’s latency
                  objective. The timeout includes consuming the response body, capped at 16 KB.
                  Redirects fail the check.
                </p>
              </article>
              <article>
                <h3>What does the SLO measure?</h3>
                <p>
                  The fraction of observed, non-maintenance checks that met their policy. Error
                  budget consumed is bad checks divided by the number allowed at the current
                  objective. Historical checks keep their original policy evaluation. Checks whose
                  observation time predates verified timing are disclosed separately; delayed runs
                  do not fill old minutes.
                </p>
              </article>
              <article>
                <h3>What happens to gaps?</h3>
                <p>
                  Missing minutes are unknown. Coverage is observed checks divided by eligible
                  minutes since enrollment, excluding recorded maintenance. Incomplete current
                  minutes are excluded. No samples means no percentage.
                </p>
              </article>
              <article>
                <h3>When does an incident open?</h3>
                <p>
                  Consecutive bad checks cross the configured threshold. Consecutive good checks
                  recover it. A gap resets both streaks. Duplicate schedule deliveries cannot count
                  twice. Acknowledgement never marks a service healthy.
                </p>
              </article>
              <article>
                <h3>What persists?</h3>
                <p>
                  Checks, resolved incidents, and audit events are retained for 30 days. Open
                  incidents and service policies persist. Monitoring has no browser-session expiry
                  and runs while this page is closed.
                </p>
              </article>
              <article>
                <h3>What are the limits?</h3>
                <p>
                  This is one observation point, not a global uptime SLA. One-minute sampling can
                  miss short outages. The monitor and services share a Cloudflare dependency. Check
                  freshness is shown separately from the time this dashboard was refreshed.
                </p>
              </article>
            </div>
            <a
              className="ops-doc-link"
              href="https://github.com/HenryWashuHe/edgelab/blob/main/docs/OPERATIONS.md"
              target="_blank"
              rel="noreferrer"
            >
              Read the operator runbook <ArrowUpRight size={15} />
            </a>
          </section>
        )}
        {tab === 'operator' && (
          <section className="panel ops-section">
            <div className="panel-heading">
              <h2>
                <LockKeyhole size={19} /> Operator console
              </h2>
              {token && (
                <button className="button" onClick={lockOperator}>
                  Lock console
                </button>
              )}
            </div>
            {!token ? (
              <form
                className="operator-login"
                onSubmit={(e) => {
                  e.preventDefault();
                  const session = operatorSession.current;
                  const key = credential;
                  action(async () => {
                    const nextAudit = await readAudit(key);
                    if (!mounted.current || operatorSession.current !== session) return;
                    abortPrivateReads();
                    operatorSession.current = { token: key, generation: session.generation + 1 };
                    setPendingNotes({});
                    setAudit(nextAudit);
                    setAuditWarning('');
                    setToken(key);
                    setCredential('');
                    setNotice('Operator session unlocked in this browser tab.');
                  });
                }}
              >
                <p>
                  The public dashboard is read-only. Enter your deployment’s operator token to edit
                  policies, pause monitoring for maintenance, and acknowledge incidents.
                </p>
                <label htmlFor="operator-token">Operator token</label>
                <input
                  id="operator-token"
                  type="password"
                  autoComplete="off"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  required
                  minLength={32}
                  maxLength={256}
                />
                <button className="button primary" disabled={busy}>
                  Unlock console
                </button>
                <small>
                  The token and pending notes stay in this browser tab until Lock, leaving
                  Operations, or page reload. Provision or rotate the token with the repository’s
                  operator setup command.
                </small>
              </form>
            ) : (
              <>
                <div className="operator-services">
                  {data?.services.map((s) => (
                    <div key={s.id}>
                      <div>
                        <strong>{s.name}</strong>
                        <small>
                          Policy v{s.revision} ·{' '}
                          {s.policy.paused ? 'Maintenance paused' : 'Monitoring active'}
                        </small>
                      </div>
                      <button className="button" onClick={() => openPolicy(s)}>
                        Edit policy
                      </button>
                    </div>
                  ))}
                </div>
                <div className="ops-chart-heading">
                  <h3>Audit trail</h3>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => action(() => loadAudit())}
                  >
                    Refresh audit
                  </button>
                </div>
                <div className="ops-table-wrap">
                  <table>
                    <caption>
                      Latest 100 operator and lifecycle events. Notes are private to operators.
                    </caption>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Action</th>
                        <th>Service</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit?.events.map((event) => (
                        <tr key={event.id}>
                          <td>{when(event.at)}</td>
                          <td>{event.action}</td>
                          <td>{event.service}</td>
                          <td>
                            <details>
                              <summary>Inspect event #{event.id}</summary>
                              <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}
      </div>
      <footer className="ops-footer">
        <span>
          Snapshot {data ? new Date(data.now).toLocaleTimeString() : 'pending'} · refreshes every
          15s while visible
        </span>
        <a href="https://github.com/HenryWashuHe/edgelab" target="_blank" rel="noreferrer">
          Source & reproducible tests <ArrowUpRight size={14} />
        </a>
      </footer>
      {investigating && (
        <IncidentWorkspace
          incidentId={investigating.id}
          serviceName={
            data?.services.find((item) => item.id === investigating.service)?.name ??
            investigating.service
          }
          token={token}
          submission={token ? (pendingNotes[investigating.id] ?? null) : null}
          changeSubmission={(submission) => {
            if (
              !mounted.current ||
              !renderedOperatorSession.token ||
              operatorSession.current !== renderedOperatorSession
            )
              return;
            setPendingNotes((previous) => {
              if (operatorSession.current !== renderedOperatorSession) return previous;
              const next = { ...previous };
              if (submission) next[investigating.id] = submission;
              else delete next[investigating.id];
              return next;
            });
          }}
          close={() => setInvestigating(null)}
        />
      )}
      {editing && (
        <PolicyEditor
          key={editing.id}
          service={editing}
          currentService={data?.services.find((item) => item.id === editing.id)}
          reviewCurrent={(currentService) => {
            policyForm.current = currentService;
            setEditing(currentService);
            setFormError('');
            setFormErrorOwner(null);
          }}
          busy={busy}
          error={formErrorOwner === editing ? formError : ''}
          close={closePolicy}
          save={(policy) =>
            action(
              async () => {
                const session = operatorSession.current;
                const result = await request<{ revision: number }>('policy', session.token, {
                  service: editing.id,
                  revision: editing.revision,
                  policy,
                });
                if (!mounted.current || operatorSession.current !== session) return;
                setEditing((previous) => (previous === editing ? null : previous));
                if (policyForm.current === editing) policyForm.current = null;
                setNotice(
                  `${editing.name}: policy saved as revision ${result.revision}. Scheduled checks will use this revision.`,
                );
              },
              {
                mutation: 'policy',
                auditAfterSuccess: true,
                dialog: editing,
                source: editing.name,
              },
            )
          }
        />
      )}
      {acknowledging && (
        <Modal title="Acknowledge incident" close={closeAcknowledgement}>
          {formError && formErrorOwner === acknowledging && (
            <p role="alert" className="ops-red">
              {formError}
            </p>
          )}
          {acknowledgementNotice && (
            <p role="status" className="ops-muted">
              {acknowledgementNotice}
            </p>
          )}
          {(currentAcknowledgement?.acknowledged || currentAcknowledgement?.resolved) && (
            <p role="status" className="ops-muted">
              {currentAcknowledgement.acknowledged
                ? `The refreshed incident is already acknowledged at ${when(currentAcknowledgement.acknowledged)}.`
                : `The refreshed incident recovered at ${when(currentAcknowledgement.resolved)}.`}{' '}
              Your draft remains below for review. Close this dialog and inspect the incident’s
              private notes before deciding whether to add an investigation update.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(
                async () => {
                  const session = operatorSession.current;
                  const result = await request<{ ok: true; alreadyAcknowledged?: boolean }>(
                    'acknowledge',
                    session.token,
                    { incident: acknowledging.id, note },
                  );
                  if (!mounted.current || operatorSession.current !== session) return;
                  if (result.alreadyAcknowledged) {
                    const message =
                      'This incident was already acknowledged. Your draft note was not recorded. Inspect the incident’s private notes before adding an investigation update.';
                    if (acknowledgementForm.current === acknowledging)
                      setAcknowledgementNotice(message);
                    setNotice(
                      `Incident ${acknowledging.id} was already acknowledged; the submitted note was not recorded.`,
                    );
                    return 'unchanged';
                  }
                  setAcknowledging((previous) => (previous === acknowledging ? null : previous));
                  if (acknowledgementForm.current === acknowledging) {
                    acknowledgementForm.current = null;
                    setNote('');
                    setAcknowledgementNotice('');
                  }
                  setNotice(
                    `Incident ${acknowledging.id} acknowledged. Recovery still requires successful checks.`,
                  );
                },
                {
                  mutation: 'acknowledgement',
                  auditAfterSuccess: true,
                  dialog: acknowledging,
                  source: `Incident ${acknowledging.id}`,
                },
              );
            }}
          >
            <label htmlFor="incident-note">Investigation note (operator-only)</label>
            <textarea
              id="incident-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              maxLength={500}
              rows={4}
            />
            <button
              className="button primary"
              disabled={
                busy ||
                Boolean(currentAcknowledgement?.acknowledged || currentAcknowledgement?.resolved)
              }
            >
              Record acknowledgement
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function CheckStrip({ service, now }: { service: Service; now: number }) {
  const checks = new Map(service.history.map((c) => [c.slot, c]));
  const latest = Math.floor(now / 60000);
  return (
    <div className="check-strip" aria-label="Last 60 scheduled minutes">
      {Array.from({ length: 60 }, (_, i) => {
        const slot = latest - 59 + i;
        const c = checks.get(slot);
        return (
          <span
            key={slot}
            className={
              !c || c.observedAt === null
                ? 'unknown'
                : c.outcome === 'good'
                  ? 'good'
                  : c.outcome === 'maintenance'
                    ? 'maintenance'
                    : 'bad'
            }
            title={`${new Date(slot * 60000).toLocaleTimeString()}: ${!c ? 'no observation' : c.observedAt === null ? `${c.outcome} · legacy timing unverified` : c.outcome}`}
          />
        );
      })}
    </div>
  );
}
function HourlyChart({ service }: { service: Service }) {
  const start = Math.floor(service.metrics.windowStart / 3600000) * 3600000;
  const end = service.metrics.windowEnd;
  const buckets = new Map(service.hourly.map((h) => [Number(h.at), h]));
  const count = Math.max(0, Math.min(168, Math.ceil((end - start) / 3600000)));
  return (
    <div
      className="hourly-chart"
      role="img"
      aria-label="Hourly verified good, bad, maintenance, and unknown or unverified observations"
    >
      {Array.from({ length: count }, (_, i) => {
        const at = start + i * 3600000;
        const h = buckets.get(at);
        const good = Number(h?.good ?? 0),
          total = Number(h?.total ?? 0),
          maintenance = Number(h?.maintenance ?? 0),
          unverified = Number(h?.unverified ?? 0),
          bad = Math.max(0, total - good - maintenance - unverified);
        const expected = Math.max(
          1,
          (Math.min(at + 3600000, end) - Math.max(at, service.metrics.windowStart)) / 60000,
        );
        return (
          <div
            className="hour-column"
            key={at}
            title={`${when(at)}: ${good} good, ${bad} bad, ${maintenance} maintenance, ${unverified} unverified, ${Math.max(0, expected - total)} missing`}
          >
            <span className="good" style={{ height: `${(100 * good) / expected}%` }} />
            <span className="bad" style={{ height: `${(100 * bad) / expected}%` }} />
            <span
              className="maintenance"
              style={{ height: `${(100 * maintenance) / expected}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="ops-dialog"
      aria-labelledby="ops-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <div className="dialog-heading">
        <h2 id="ops-dialog-title">{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={close}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function PolicyEditor({
  service,
  currentService,
  reviewCurrent,
  busy,
  error,
  close,
  save,
}: {
  service: Service;
  currentService?: Service;
  reviewCurrent: (currentService: Service) => void;
  busy: boolean;
  error: string;
  close: () => void;
  save: (policy: MonitorPolicy) => void;
}) {
  const [policy, setPolicy] = useState(service.policy);
  const fields: [keyof Omit<MonitorPolicy, 'paused'>, string, number, number, number][] = [
    ['availabilityTarget', 'Good-check objective (%)', 90, 99.99, 0.01],
    ['latencyObjectiveMs', 'Latency objective (ms)', 50, 10000, 1],
    ['timeoutMs', 'Probe timeout (ms)', 100, 10000, 1],
    ['failureThreshold', 'Failures to open incident', 1, 10, 1],
    ['recoveryThreshold', 'Successes to recover', 1, 10, 1],
  ];
  const revisionChanged =
    currentService !== undefined && currentService.revision !== service.revision;
  const matchesCurrent =
    currentService !== undefined &&
    (Object.keys(policy) as (keyof MonitorPolicy)[]).every(
      (key) => policy[key] === currentService.policy[key],
    );
  return (
    <Modal title={`${service.name} policy`} close={close}>
      {error && (
        <p role="alert" className="ops-red">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(policy);
        }}
      >
        <p className="ops-muted">
          Editing revision {service.revision}. Changes reset failure and recovery streaks; existing
          incidents stay open until measured recovery.
        </p>
        {revisionChanged && currentService && (
          <div>
            <p role="status" className="ops-muted">
              Current saved revision: {currentService.revision}. Your draft remains unchanged.
              {matchesCurrent
                ? ' Its values already match the saved policy; another save is unnecessary.'
                : ' Review the current values before submitting against the new revision.'}
            </p>
            <details>
              <summary>Compare current policy with your draft</summary>
              <div className="ops-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Setting</th>
                      <th>Current</th>
                      <th>Your draft</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map(([key, label]) => (
                      <tr key={key}>
                        <td>{label}</td>
                        <td>{currentService.policy[key]}</td>
                        <td>{policy[key]}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>Maintenance</td>
                      <td>{currentService.policy.paused ? 'Paused' : 'Active'}</td>
                      <td>{policy.paused ? 'Paused' : 'Active'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
            {!matchesCurrent && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => reviewCurrent(currentService)}
              >
                Keep draft and use revision {currentService.revision}
              </button>
            )}
          </div>
        )}
        {fields.map(([key, label, min, max, step]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              required
              value={policy[key]}
              onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
        <label className="ops-checkbox">
          <input
            type="checkbox"
            checked={policy.paused}
            onChange={(e) => setPolicy({ ...policy, paused: e.target.checked })}
          />{' '}
          Pause probes for maintenance
        </label>
        <p className="ops-muted">
          Maintenance is recorded separately and excluded from the SLO. Public visitors cannot
          change this policy.
        </p>
        <button className="button primary" disabled={busy || revisionChanged || matchesCurrent}>
          Save policy
        </button>
      </form>
    </Modal>
  );
}
