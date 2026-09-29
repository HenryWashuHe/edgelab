import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Database,
  FlaskConical,
  Globe2,
  Layers,
  LoaderCircle,
  Play,
  Radio,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  Waves,
  Zap,
} from 'lucide-react';
import type { Config, LabEvent, Outcome, Snapshot } from '../worker/engine';
import './style.css';

const colors: Record<Outcome, string> = {
  origin: '#25a67b',
  stale: '#6690df',
  limited: '#e6a336',
  blocked: '#a08bad',
  error: '#e46d65',
};
const names: Record<Outcome, string> = {
  origin: 'Origin success',
  stale: 'Cached fallback',
  limited: 'Rate limited',
  blocked: 'Circuit blocked',
  error: 'Origin error',
};
function getLabId() {
  let id = localStorage.getItem('edgelab-session');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    id = crypto.randomUUID();
    localStorage.setItem('edgelab-session', id);
  }
  return id;
}
const labId = getLabId();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function api<T = Record<string, unknown>>(path: string, body?: unknown) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Lab-ID': labId, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as T & { error?: string; outcome?: string };
  if (!response.ok && !data.outcome)
    throw new Error(data.error || `Request failed (${response.status})`);
  return { data, colo: response.headers.get('X-Edge-Colo') ?? 'LOCAL' };
}
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState('playground');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(
    'Your lab is ready. Start with a healthy request, or run the guided demo.',
  );
  const [filter, setFilter] = useState('all');
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef(false);
  const lock = useRef(false);
  async function refresh() {
    const result = await api<Omit<Snapshot, 'colo'>>('state');
    setSnapshot({ ...result.data, colo: result.colo });
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    return () => {
      streamRef.current = false;
    };
  }, []);
  async function run(label: string, fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  const update = async (patch: Partial<Config>) => {
    await api('config', patch);
    await refresh();
  };
  async function send() {
    await api('request', {});
  }
  function burst() {
    return run('burst', async () => {
      setNotice(
        'Sending 24 concurrent requests. Watch the shared token bucket enforce one budget.',
      );
      await Promise.all(Array.from({ length: 24 }, send));
      setNotice('Burst complete. Rejected requests return HTTP 429 with a Retry-After header.');
    });
  }
  function demo() {
    return run('demo', async () => {
      await api('reset', {});
      await update({ capacity: 30, refillPerSecond: 10 });
      setNotice('01 / Warm the cache — three healthy origin requests.');
      for (let i = 0; i < 3; i++) {
        await send();
        await refresh();
        await pause(250);
      }
      await update({ originMode: 'failing' });
      setNotice('02 / Inject an outage — errors open the circuit; cached responses keep working.');
      for (let i = 0; i < 7; i++) {
        await send();
        await refresh();
        await pause(200);
      }
      await update({ originMode: 'healthy' });
      setNotice('03 / Recover — wait for the cooldown, then admit one recovery probe.');
      await pause(4200);
      await send();
      await refresh();
      await update({ capacity: 12, refillPerSecond: 4 });
      setNotice(
        'Demo complete. The origin recovered and the circuit closed. Export this run or try a traffic burst.',
      );
    });
  }
  async function startStream() {
    if (streamRef.current) {
      streamRef.current = false;
      setStreaming(false);
      return;
    }
    streamRef.current = true;
    setStreaming(true);
    await run('stream', async () => {
      setNotice('Sending one request per second. Traffic stops automatically after 60 requests.');
      for (let i = 0; i < 60 && streamRef.current; i++) {
        await send();
        await refresh();
        await pause(1000);
      }
    });
    streamRef.current = false;
    setStreaming(false);
  }
  function download() {
    if (!snapshot) return;
    const report = {
      project: 'EdgeLab',
      exportedAt: new Date().toISOString(),
      environment: snapshot.colo === 'LOCAL' ? 'local' : 'cloudflare',
      note: 'Controlled synthetic origin; measured server elapsed latency. Latest 180 events; counters cover the full run.',
      ...snapshot,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `edgelab-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  const s = snapshot?.state;
  const events = snapshot?.events ?? [];
  const settled = s ? Object.values(s.counts).reduce((a, b) => a + b, 0) : 0;
  const success = s ? s.counts.origin + s.counts.stale : 0;
  const latency = [...events].map((e) => e.latencyMs).sort((a, b) => a - b);
  const p95 = latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null;
  const disabled = !!busy || !s;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            setPage('playground');
          }}
        >
          <span className="brand-mark">
            <Zap size={22} fill="currentColor" />
          </span>
          edge<span className="brand-light">lab</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <FlaskConical size={18} />
          </span>
          <div>
            Personal workspace<small>Developer lab</small>
          </div>
          <span className="workspace-version">01</span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {[
            ['playground', FlaskConical, 'Playground'],
            ['architecture', Layers, 'Architecture'],
            ['notes', BookOpen, 'Field notes'],
          ].map(([id, Icon, label]) => (
            <button
              key={String(id)}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => setPage(String(id))}
            >
              <Icon size={18} />
              {String(label)}
              {page === id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="built-card">
            <Cloud size={24} />
            <p>
              Small lab.
              <br />
              <strong>Real edge infrastructure.</strong>
            </p>
            <span>
              Built on Cloudflare Workers
              <br />
              and Durable Objects.
            </span>
            <a
              href="https://developers.cloudflare.com/durable-objects/"
              target="_blank"
              rel="noreferrer"
            >
              Explore the platform <ArrowUpRight size={14} />
            </a>
          </div>
          <div className="sidebar-footer">
            <span className="tiny-dot" /> EdgeLab v1.0 <span>TS</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace <ChevronRight size={13} />
            <span>
              {page === 'playground'
                ? 'Reliability playground'
                : page === 'architecture'
                  ? 'Architecture'
                  : 'Field notes'}
            </span>
          </div>
          <div className="topbar-right">
            <span className="runtime-pill">
              <span className={`tiny-dot ${snapshot ? '' : 'muted-dot'}`} />
              {snapshot
                ? snapshot.colo === 'LOCAL'
                  ? 'Local runtime'
                  : `${snapshot.colo} · Edge connected`
                : 'Connecting'}
            </span>
            <a
              href="https://developers.cloudflare.com/workers/"
              target="_blank"
              rel="noreferrer"
              aria-label="Cloudflare documentation"
            >
              <CircleHelp size={18} />
            </a>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span /> THE INTERNET, UNDER PRESSURE
              </div>
              <h1>
                {page === 'playground'
                  ? 'Break things. Build resilience.'
                  : page === 'architecture'
                    ? 'Under the hood.'
                    : 'Make the work count.'}
              </h1>
              <p>
                {page === 'playground'
                  ? 'A hands-on lab for the systems that keep the Internet running.'
                  : page === 'architecture'
                    ? 'One edge entry point. One consistent coordinator per lab. Every decision visible.'
                    : 'A demo is the beginning. Understanding the tradeoffs is what makes it yours.'}
              </p>
            </div>
            {page === 'playground' && (
              <button className="button primary" disabled={disabled} onClick={demo}>
                {busy === 'demo' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Play size={15} fill="currentColor" />
                )}{' '}
                Run guided demo
              </button>
            )}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => run('retry', refresh)}>Reconnect</button>
            </div>
          )}
          {page === 'playground' ? (
            <>
              <div className="experiment-label">
                <span>CHOOSE YOUR EXPERIMENT</span>
                <span>Controlled traffic. Real protection logic.</span>
              </div>
              <div className="scenarios">
                <button className="scenario" disabled={disabled} onClick={burst}>
                  <span className="scenario-icon amber">
                    <Waves size={21} />
                  </span>
                  <span>
                    <b>Survive a traffic spike</b>
                    <small>24 requests. One shared token bucket.</small>
                  </span>
                  <ArrowUpRight size={17} />
                  <span className="scenario-number">01</span>
                </button>
                <button
                  className="scenario"
                  disabled={disabled}
                  onClick={() =>
                    run('outage', async () => {
                      await update({ originMode: 'failing' });
                      setNotice(
                        'Origin is failing. Send requests to trip the circuit. Warm the cache first to see fallback.',
                      );
                    })
                  }
                >
                  <span className="scenario-icon red">
                    <Zap size={20} />
                  </span>
                  <span>
                    <b>Take the origin offline</b>
                    <small>Trip the circuit. Keep cached data flowing.</small>
                  </span>
                  <ArrowUpRight size={17} />
                  <span className="scenario-number">02</span>
                </button>
                <button
                  className="scenario"
                  disabled={disabled}
                  onClick={() =>
                    run('recover', async () => {
                      await update({ originMode: 'healthy' });
                      setNotice(
                        'Origin is healthy. After cooldown, the next request becomes a recovery probe.',
                      );
                    })
                  }
                >
                  <span className="scenario-icon green">
                    <ShieldCheck size={21} />
                  </span>
                  <span>
                    <b>Watch it recover</b>
                    <small>One probe safely reopens the path.</small>
                  </span>
                  <ArrowUpRight size={17} />
                  <span className="scenario-number">03</span>
                </button>
              </div>
              <div className="lab-grid">
                <div className="lab-main">
                  <section className="panel topology">
                    <div className="panel-heading">
                      <h2>
                        <Globe2 size={17} /> Request journey
                      </h2>
                      <span className="badge neutral">SYNTHETIC ORIGIN</span>
                    </div>
                    <div className="flow">
                      <div className="flow-node">
                        <span className="node-icon">
                          <Globe2 size={23} />
                        </span>
                        <b>Client</b>
                        <small>Browser / API</small>
                      </div>
                      <div className={`connector ${busy ? 'flowing' : ''}`}>
                        <span>HTTPS</span>
                        <ArrowRight size={13} />
                      </div>
                      <div className="flow-node edge-node">
                        <span className="node-icon">
                          <ShieldCheck size={23} />
                        </span>
                        <b>Edge guard</b>
                        <small>Cloudflare Worker</small>
                      </div>
                      <div className={`connector ${busy ? 'flowing' : ''}`}>
                        <span>COORDINATE</span>
                        <ArrowRight size={13} />
                      </div>
                      <div className="flow-node">
                        <span className="node-icon storage">
                          <Database size={23} />
                        </span>
                        <b>Durable Object</b>
                        <small>State + SQLite</small>
                      </div>
                      <div className={`connector ${s?.circuit === 'open' ? 'broken' : ''}`}>
                        <span>{s?.circuit === 'open' ? 'BYPASSED' : 'PROTECT'}</span>
                        <ArrowRight size={13} />
                      </div>
                      <div className="flow-node">
                        <span
                          className={`node-icon ${s?.config.originMode === 'failing' ? 'offline' : ''}`}
                        >
                          <Server size={23} />
                        </span>
                        <b>Demo origin</b>
                        <small>
                          {s?.config.originMode === 'failing'
                            ? 'Failure injected'
                            : s?.config.originMode === 'flaky'
                              ? 'Every third call fails'
                              : 'Healthy service'}
                        </small>
                      </div>
                    </div>
                    <div className="flow-caption">
                      <span className="tiny-dot" />
                      <span>Real Worker requests · isolated lab state · no external targets</span>
                      <span className="mono">{snapshot?.colo ?? '…'}</span>
                    </div>
                  </section>
                  <div className="metrics">
                    <Metric
                      label="TOTAL REQUESTS"
                      value={String(s?.total ?? 0)}
                      detail="Since the last reset"
                      icon={<Activity size={15} />}
                    />
                    <Metric
                      label="SUCCESS RATE"
                      value={settled ? `${Math.round((success / settled) * 100)}%` : '—'}
                      detail="Origin + cached responses"
                      icon={<ShieldCheck size={15} />}
                      accent
                    />
                    <Metric
                      label="ORIGIN BYPASSED"
                      value={String(s ? s.total - s.originCalls : 0)}
                      detail="Limited or circuit-blocked"
                      icon={<Layers size={15} />}
                    />
                    <Metric
                      label="P95 LATENCY"
                      value={p95 === null ? '—' : String(p95)}
                      unit={p95 === null ? '' : 'ms'}
                      detail="Server elapsed · recent 180"
                      icon={<Zap size={15} />}
                    />
                  </div>
                  <section className="panel chart-panel">
                    <div className="panel-heading">
                      <h2>Traffic, decoded</h2>
                      <span className="subtle">Last {Math.min(events.length, 60)} requests</span>
                    </div>
                    <TrafficChart events={events} />
                    <div className="legend">
                      {Object.entries(names).map(([key, label]) => (
                        <span key={key}>
                          <i style={{ background: colors[key as Outcome] }} />
                          {label}
                        </span>
                      ))}
                    </div>
                  </section>
                  <section className="panel log-panel">
                    <div className="panel-heading">
                      <h2>
                        <Terminal size={16} /> Request log{' '}
                        <span className="count-badge">{events.length}</span>
                      </h2>
                      <select
                        aria-label="Filter request log"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">All outcomes</option>
                        {Object.entries(names).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>TIME</th>
                            <th>STATUS</th>
                            <th>OUTCOME</th>
                            <th>LATENCY</th>
                            <th>CIRCUIT</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events
                            .filter((e) => filter === 'all' || e.outcome === filter)
                            .slice(0, 30)
                            .map((e) => (
                              <tr key={e.id}>
                                <td className="mono">
                                  {new Date(e.at).toLocaleTimeString('en-US', { hour12: false })}
                                  <span className="event-id">#{e.id}</span>
                                </td>
                                <td>
                                  <span
                                    className={`status-code ${e.status === 200 ? 'status-ok' : e.status === 429 ? 'status-limit' : 'status-error'}`}
                                  >
                                    {e.status}
                                  </span>
                                </td>
                                <td title={e.message}>
                                  <span
                                    className="outcome-dot"
                                    style={{ background: colors[e.outcome] }}
                                  />
                                  {names[e.outcome]}
                                </td>
                                <td className="mono">
                                  {e.latencyMs} <span className="subtle">ms</span>
                                </td>
                                <td>
                                  <span className="circuit-cell">{e.circuit}</span>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      {!events.filter((e) => filter === 'all' || e.outcome === filter).length && (
                        <div className="empty-log">
                          <Radio size={23} />
                          <b>
                            {events.length
                              ? 'No matching requests'
                              : 'Waiting for your first request'}
                          </b>
                          <span>
                            {events.length
                              ? 'Choose another outcome to inspect.'
                              : 'Send some traffic and see every decision appear here.'}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="log-footer">
                      Latest 30 matching events shown · 180 retained per lab
                      <button onClick={download} disabled={!events.length}>
                        <ArrowDownToLine size={14} /> Export JSON
                      </button>
                    </div>
                  </section>
                </div>
                <aside className="controls">
                  <section className="panel control-panel">
                    <div className="panel-heading">
                      <h2>Lab controls</h2>
                      <span className="badge orange">INTERACTIVE</span>
                    </div>
                    <div className="control-content">
                      <label className="control-label">ORIGIN HEALTH</label>
                      <div className="segmented">
                        {(['healthy', 'flaky', 'failing'] as const).map((mode) => (
                          <button
                            disabled={disabled}
                            className={s?.config.originMode === mode ? `selected ${mode}` : ''}
                            key={mode}
                            onClick={() => run('config', () => update({ originMode: mode }))}
                          >
                            {mode === 'healthy'
                              ? 'Healthy'
                              : mode === 'flaky'
                                ? 'Unstable'
                                : 'Offline'}
                          </button>
                        ))}
                      </div>
                      <p className="control-help">
                        Inject failures into a controlled demo service.
                      </p>
                      <div className="divider" />
                      <div className="control-row">
                        <label className="control-label">TOKEN BUCKET</label>
                        <span className="mono">
                          {Math.floor(s?.tokens ?? 0)} / {s?.config.capacity ?? 12}
                        </span>
                      </div>
                      <div className="token-meter">
                        {Array.from({ length: 20 }, (_, i) => (
                          <i
                            key={i}
                            className={
                              i / 20 < (s ? s.tokens / s.config.capacity : 1) ? 'filled' : ''
                            }
                          />
                        ))}
                      </div>
                      <p className="control-help">Available at the last state refresh.</p>
                      <Range
                        label="Burst capacity"
                        value={s?.config.capacity ?? 12}
                        min={1}
                        max={50}
                        unit="tokens"
                        disabled={disabled}
                        onChange={(value) => run('config', () => update({ capacity: value }))}
                      />
                      <Range
                        label="Refill rate"
                        value={s?.config.refillPerSecond ?? 4}
                        min={1}
                        max={20}
                        unit="/ sec"
                        disabled={disabled}
                        onChange={(value) =>
                          run('config', () => update({ refillPerSecond: value }))
                        }
                      />
                      <div className="divider" />
                      <div className="control-row">
                        <label className="control-label">CIRCUIT BREAKER</label>
                        <span className={`circuit-tag ${s?.circuit ?? 'closed'}`}>
                          <span className="tiny-dot" />
                          {s?.circuit ?? 'closed'}
                        </span>
                      </div>
                      <p className="control-help">
                        Opens after {s?.config.failureThreshold ?? 3} consecutive origin failures.
                        Retries after {(s?.config.cooldownMs ?? 4000) / 1000}s.
                      </p>
                      <div className="circuit-steps">
                        <span className={s?.circuit === 'closed' ? 'current' : ''}>Closed</span>
                        <ChevronRight size={12} />
                        <span className={s?.circuit === 'open' ? 'current' : ''}>Open</span>
                        <ChevronRight size={12} />
                        <span className={s?.circuit === 'half-open' ? 'current' : ''}>Probe</span>
                      </div>
                      <div className="divider" />
                      <div className="control-row">
                        <label htmlFor="fallback" className="toggle-label">
                          Serve cached fallback<small>Keep the last good response for 60s</small>
                        </label>
                        <button
                          id="fallback"
                          role="switch"
                          aria-checked={s?.config.staleFallback ?? true}
                          aria-label="Serve cached fallback"
                          className={`toggle ${s?.config.staleFallback ? 'on' : ''}`}
                          disabled={disabled}
                          onClick={() =>
                            run('config', () => update({ staleFallback: !s?.config.staleFallback }))
                          }
                        >
                          <span />
                        </button>
                      </div>
                      <div className={`cache-status ${s?.cachedAt ? 'warm' : ''}`}>
                        <Database size={13} />
                        {s?.cachedAt
                          ? `Last cached at ${new Date(s.cachedAt).toLocaleTimeString()}`
                          : 'Cache empty · send a healthy request'}
                      </div>
                      <button
                        className="button dark full"
                        disabled={disabled}
                        onClick={() => run('send', send)}
                      >
                        {busy === 'send' ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <ArrowRight size={16} />
                        )}{' '}
                        Send a request
                      </button>
                      <button
                        className="button full"
                        disabled={(!!busy && !streaming) || !s}
                        onClick={startStream}
                      >
                        {streaming ? (
                          <Square size={13} fill="currentColor" />
                        ) : (
                          <Activity size={15} />
                        )}{' '}
                        {streaming ? 'Stop traffic' : 'Start steady traffic'}
                      </button>
                      <button
                        className="reset-button"
                        disabled={disabled}
                        onClick={() =>
                          run('reset', async () => {
                            await api('reset', {});
                            setNotice('Fresh lab. All settings and counters have been reset.');
                          })
                        }
                      >
                        <RotateCcw size={13} /> Reset lab
                      </button>
                    </div>
                  </section>
                  <div className="insight-card">
                    <span className="insight-label">
                      <FlaskConical size={15} /> LAB NOTE
                    </span>
                    <p aria-live="polite">{notice}</p>
                    <button onClick={() => setPage('architecture')}>
                      Understand the architecture <ArrowUpRight size={14} />
                    </button>
                  </div>
                  <div className="session-info">
                    <span className="tiny-dot" /> Your own isolated session{' '}
                    <span className="mono">{labId.slice(0, 8)}</span>
                  </div>
                </aside>
              </div>
            </>
          ) : page === 'architecture' ? (
            <Architecture />
          ) : (
            <Notes />
          )}
          <footer className="page-footer">
            <span>Built to explore a better Internet.</span>
            <span>
              Cloudflare Workers <span> / </span> Durable Objects <span> / </span> SQLite
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  unit,
  detail,
  icon,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <div className={`metric-value ${accent ? 'accent-value' : ''}`}>
        {value}
        <small>{unit}</small>
      </div>
      <span>{detail}</span>
    </div>
  );
}
function Range({
  label,
  value,
  min,
  max,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="range-control">
      <label>
        {label}
        <span className="mono">
          {draft} <span className="subtle">{unit}</span>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={() => draft !== value && onChange(draft)}
          onKeyUp={() => draft !== value && onChange(draft)}
          onBlur={() => draft !== value && onChange(draft)}
        />
      </label>
    </div>
  );
}
function TrafficChart({ events }: { events: LabEvent[] }) {
  const recent = events.slice(0, 60).reverse();
  const max = Math.max(200, ...recent.map((e) => e.latencyMs));
  return (
    <div className="chart-wrap">
      <div className="chart-axis">
        <span>{max} ms</span>
        <span>{Math.round(max / 2)} ms</span>
        <span>0 ms</span>
      </div>
      <div className="chart-area">
        <div className="grid-lines">
          <i />
          <i />
          <i />
        </div>
        {recent.length ? (
          <svg
            className="traffic-chart"
            viewBox="0 0 600 128"
            preserveAspectRatio="none"
            role="img"
            aria-label="Measured server latency of the last 60 requests, colored by outcome"
          >
            {recent.map((e, i) => {
              const width = 600 / Math.max(recent.length, 24);
              const h = Math.max(5, (e.latencyMs / max) * 115);
              return (
                <rect
                  key={e.id}
                  x={i * width + 2}
                  y={124 - h}
                  width={Math.max(2, width - 5)}
                  height={h}
                  rx="2"
                  fill={colors[e.outcome]}
                  opacity=".85"
                >
                  <title>
                    {names[e.outcome]}: {e.latencyMs} ms (HTTP {e.status})
                  </title>
                </rect>
              );
            })}
          </svg>
        ) : (
          <div className="chart-empty">
            <Activity size={22} />
            <span>
              Your traffic tells a story.
              <br />
              <b>Send a request to start recording.</b>
            </span>
          </div>
        )}
        <div className="chart-x">
          <span>Earlier</span>
          <span>Latest request</span>
        </div>
      </div>
    </div>
  );
}
function Architecture() {
  return (
    <div className="docs-layout">
      <section className="panel doc-panel">
        <div className="eyebrow">01 / THE REQUEST PATH</div>
        <h2>Stateless at the edge. Consistent at the coordinator.</h2>
        <p>
          The Worker validates the request and routes the lab's opaque session ID to one Durable
          Object. That object owns admission, circuit state, the last successful response timestamp,
          and a bounded SQLite event log.
        </p>
        <div className="architecture-strip">
          <span>
            <Globe2 />
            Browser
          </span>
          <ArrowRight />
          <span>
            <Cloud />
            Worker
          </span>
          <ArrowRight />
          <span>
            <Database />
            Durable Object
            <br />+ SQLite
          </span>
          <ArrowRight />
          <span>
            <Server />
            Synthetic origin
          </span>
        </div>
        <p>
          Origin work is a controlled asynchronous delay with injected failures. No external origin
          is contacted. The UI shows server elapsed time, not round-trip Internet latency or
          multi-region benchmarks.
        </p>
        <hr />
        <div className="eyebrow">02 / WHY A DURABLE OBJECT?</div>
        <h2>One budget, even under concurrent traffic.</h2>
        <p>
          A per-Worker in-memory bucket would split the budget across isolates. An eventually
          consistent store can admit too many concurrent requests. A Durable Object coordinates each
          lab's state; synchronous SQLite transactions persist each admission before the handler
          awaits origin work.
        </p>
        <pre>{`Client → validate session → Durable Object\n  1. Refill and reserve a token\n  2. Check circuit / reserve recovery probe\n  3. Persist admission synchronously\n  4. Await controlled origin work\n  5. Record result + circuit transition atomically`}</pre>
        <hr />
        <div className="eyebrow">03 / THE SUBTLE PART</div>
        <h2>Recovery is a concurrency problem.</h2>
        <p>
          Only one request enters half-open recovery. Other requests get a bounded-age cached
          response or HTTP 503. Each permit carries a circuit generation: a late success from an
          older generation cannot close a circuit that just tripped. A run ID prevents old in-flight
          requests from repopulating a reset lab.
        </p>
        <p>
          A persisted 10-second probe lease allows recovery if a probe is interrupted. Multiple
          calls admitted before a failure threshold may still reach the origin; a breaker cannot
          recall work already in flight.
        </p>
      </section>
      <aside className="doc-side">
        <div className="panel doc-panel">
          <h3>Deliberate boundaries</h3>
          <ul>
            <li>One coordinator per lab, not one global bottleneck.</li>
            <li>Latest 180 events retained; counters cover the full run.</li>
            <li>Cached payload is a constant demo response, valid for 60 seconds.</li>
            <li>
              Opaque session IDs isolate demos; this is not an authenticated multi-tenant gateway.
            </li>
            <li>A public deployment needs account-level abuse controls and quota monitoring.</li>
            <li>Idle lab data is retained until reset. No scheduled cleanup is implemented.</li>
          </ul>
        </div>
        <div className="insight-card">
          <span className="insight-label">THE TRADEOFF</span>
          <p>
            Strong coordination adds a network hop to the object location. Measure it before
            claiming global low latency.
          </p>
        </div>
      </aside>
    </div>
  );
}
function Notes() {
  return (
    <div className="docs-layout">
      <section className="panel doc-panel">
        <div className="eyebrow">A TWO-MINUTE WALKTHROUGH</div>
        <h2>Show the failure. Explain the fix.</h2>
        <ol className="walkthrough">
          <li>
            <b>Start with the problem.</b>
            <p>
              “Retries can turn a partial outage into an overload. I built a lab to make admission
              control and recovery visible.”
            </p>
          </li>
          <li>
            <b>Run a burst.</b>
            <p>
              Send 24 concurrent requests and show the shared token budget. Explain HTTP 429 and why
              rejected traffic gets Retry-After.
            </p>
          </li>
          <li>
            <b>Break the origin.</b>
            <p>
              Warm the cache, inject failures, and show the circuit opening after three failures.
              Cached responses preserve availability for up to 60 seconds.
            </p>
          </li>
          <li>
            <b>Recover deliberately.</b>
            <p>
              Restore health, wait for cooldown, and send a probe. Explain why only one recovery
              request may reach the origin.
            </p>
          </li>
          <li>
            <b>Make the tradeoff explicit.</b>
            <p>
              Strong consistency costs a coordinator hop. Cached data may be stale. This lab
              measures a synthetic origin, not production capacity.
            </p>
          </li>
        </ol>
        <hr />
        <div className="eyebrow">RESUME STARTER</div>
        <blockquote>
          Built an interactive API resilience lab using Cloudflare Workers, SQLite-backed Durable
          Objects, and TypeScript; implemented coordinated token-bucket rate limiting, circuit
          breaking with single-probe recovery, and bounded-age cached fallback.
        </blockquote>
        <p>
          Use this once you can explain and reproduce the behavior. Add measured numbers only after
          running and saving your own experiments.
        </p>
        <hr />
        <h2>Make the next improvement yours.</h2>
        <p>
          Add a fixed, owned origin through a service binding; compare protected and unprotected
          traffic using the same workload; or implement lab expiration with Durable Object alarms.
          Document the result and one thing your original design got wrong.
        </p>
      </section>
      <aside className="doc-side">
        <div className="panel doc-panel">
          <Code2 size={24} />
          <h3>Be ready for these questions</h3>
          <ul>
            <li>Why not use KV for the bucket?</li>
            <li>What happens when two recovery probes arrive at once?</li>
            <li>Can an old response close a newly opened circuit?</li>
            <li>What survives an object eviction?</li>
            <li>When is a stale response unacceptable?</li>
            <li>Where are the bottlenecks and trust boundaries?</li>
          </ul>
        </div>
        <div className="insight-card">
          <span className="insight-label">
            <Check size={15} /> WHAT COUNTS
          </span>
          <p>
            A working demo, reproducible tests, and a clear explanation of tradeoffs. No project
            guarantees an interview—but these give an interviewer something concrete to evaluate.
          </p>
        </div>
      </aside>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
