import { Architecture, Notes } from './Guide';
import { RequestInspector } from './RequestInspector';
import { asCsv, report, saveFile, percentile95 } from './reports';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Cloud,
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
  let id: string | null = null;
  try {
    id = localStorage.getItem('edgelab-session');
  } catch {
    /* Private browsers can deny storage. */
  }
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem('edgelab-session', id);
    } catch {
      /* In-memory session still works. */
    }
  }
  return id;
}
const labId = getLabId();
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Stopped', 'AbortError'));
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
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
  const [selectedEvent, setSelectedEvent] = useState<LabEvent | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const configLock = useRef(false);
  const [step, setStep] = useState(-1);
  const [sent, setSent] = useState(0);
  const [tick, setTick] = useState(Date.now());
  const receivedAt = useRef(Date.now());
  const refreshSeq = useRef(0);
  const stopController = useRef<AbortController | null>(null);
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
    const seq = ++refreshSeq.current;
    const result = await api<Omit<Snapshot, 'colo'>>('state');
    if (seq !== refreshSeq.current) return;
    receivedAt.current = Date.now();
    setSnapshot({ ...result.data, colo: result.colo });
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => setTick(Date.now()), 250);
    return () => {
      streamRef.current = false;
      stopController.current?.abort();
      clearInterval(timer);
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
      if ((e as Error).name === 'AbortError')
        setNotice('Experiment stopped. Completed requests are kept in the log.');
      else setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy('');
      stopController.current = null;
    }
  }
  const update = async (patch: Partial<Config>) => {
    await api('config', patch);
    await refresh();
  };
  async function configure(patch: Partial<Config>) {
    if (configLock.current || (lock.current && !streamRef.current)) return;
    configLock.current = true;
    setConfigBusy(true);
    setError('');
    try {
      await update(patch);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      configLock.current = false;
      setConfigBusy(false);
    }
  }
  function stop() {
    streamRef.current = false;
    stopController.current?.abort();
  }
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
      const controller = new AbortController();
      stopController.current = controller;
      const check = () => controller.signal.throwIfAborted();
      const wait = (ms: number) => pause(ms, controller.signal);
      setStep(0);
      setSent(0);
      setSelectedEvent(null);
      await api('reset', {});
      check();
      await update({ capacity: 30, refillPerSecond: 10 });
      setNotice(
        'Warm the cache: healthy requests create a real catalog response in the origin Worker.',
      );
      for (let i = 0; i < 3; i++) {
        check();
        await send();
        setSent(i + 1);
        await refresh();
        await wait(250);
      }
      check();
      setStep(1);
      await update({ originMode: 'failing' });
      setNotice('Inject an outage: the circuit opens and replays the last good response.');
      for (let i = 0; i < 7; i++) {
        check();
        await send();
        setSent(i + 4);
        await refresh();
        await wait(200);
      }
      check();
      setStep(2);
      await update({ originMode: 'healthy' });
      setNotice('Restore health: waiting for cooldown before one recovery probe.');
      await wait(4200);
      check();
      await send();
      setSent(11);
      await refresh();
      check();
      await update({ capacity: 12, refillPerSecond: 4 });
      setStep(3);
      setNotice(
        'Demo complete. Inspect a cached request to compare its payload revision with an origin response.',
      );
    });
  }
  async function startStream() {
    if (streamRef.current) {
      stop();
      return;
    }
    streamRef.current = true;
    setStreaming(true);
    setSent(0);
    setStep(-1);
    await run('stream', async () => {
      const controller = new AbortController();
      stopController.current = controller;
      setNotice(
        'Steady traffic is running. Change origin health or the timeout budget to test a failure live.',
      );
      for (let i = 0; i < 60 && streamRef.current; i++) {
        controller.signal.throwIfAborted();
        await send();
        setSent(i + 1);
        await refresh();
        await pause(1000, controller.signal);
      }
      setNotice('Traffic complete. Inspect the log or export the experiment.');
    });
    streamRef.current = false;
    setStreaming(false);
  }
  function download(format: 'json' | 'csv') {
    if (!snapshot) return;
    saveFile(
      format === 'csv' ? asCsv(snapshot.events) : JSON.stringify(report(snapshot), null, 2),
      format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
      `edgelab-${Date.now()}.${format}`,
    );
  }
  const s = snapshot?.state;
  const events = snapshot?.events ?? [];
  const settled = s ? Object.values(s.counts).reduce((a, b) => a + b, 0) : 0;
  const success = s ? s.counts.origin + s.counts.stale : 0;
  const p95 = percentile95(events);
  const disabled = !!busy || configBusy || !s;
  const configDisabled = !s || configBusy || (!!busy && !streaming);
  const serverNow = (snapshot?.now ?? tick) + Math.max(0, tick - receivedAt.current);
  const tokens = s
    ? Math.min(
        s.config.capacity,
        s.tokens + (Math.max(0, serverNow - s.updatedAt) / 1000) * s.config.refillPerSecond,
      )
    : 0;
  const cacheAge =
    s?.cachedAt === null || s?.cachedAt === undefined ? null : Math.max(0, serverNow - s.cachedAt);
  const cooldown =
    s?.circuit === 'open'
      ? Math.max(0, Math.ceil((s.config.cooldownMs - (serverNow - s.openedAt)) / 1000))
      : 0;
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
            <span className="tiny-dot" /> EdgeLab v2.0 <span>TS</span>
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
              <button
                className="button primary"
                disabled={busy !== 'demo' && disabled}
                onClick={busy === 'demo' ? stop : demo}
              >
                {busy === 'demo' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Play size={15} fill="currentColor" />
                )}{' '}
                {busy === 'demo' ? 'Stop demo' : 'Run guided demo'}
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
              <div className="lab-intro">
                <span className="intro-label">
                  <ShieldCheck size={15} /> TWO WORKERS. ONE RESILIENT PATH.
                </span>
                <p>
                  Protect a live service binding from bursts, failures, and slow responses. Every
                  decision leaves a trace.
                </p>
                <a href="https://github.com/HenryWashuHe/edgelab" target="_blank" rel="noreferrer">
                  Explore the source <ArrowUpRight size={14} />
                </a>
              </div>
              {(step >= 0 || streaming) && (
                <section className="experiment-progress" aria-label="Experiment progress">
                  <div>
                    <span className={`tiny-dot ${busy ? '' : 'muted-dot'}`} />
                    <b>
                      {streaming
                        ? 'Steady traffic'
                        : busy === 'demo'
                          ? 'Guided experiment'
                          : step === 3
                            ? 'Experiment complete'
                            : 'Experiment stopped'}
                    </b>
                    <span>{sent} requests sent</span>
                  </div>
                  {streaming ? (
                    <p>Change a control while requests are running. Maximum 60 requests.</p>
                  ) : (
                    <ol>
                      {['Warm cache', 'Inject outage', 'Probe recovery'].map((label, i) => (
                        <li key={label} className={step > i ? 'done' : step === i ? 'current' : ''}>
                          <span>{step > i ? '✓' : i + 1}</span>
                          {label}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
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
                      <span className="badge neutral">LIVE SERVICE BINDING</span>
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
                        <b>Origin Worker</b>
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
                      <span>Two Workers · isolated state · controlled catalog data</span>
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
                      label="ORIGIN P95"
                      value={p95 === null ? '—' : String(p95)}
                      unit={p95 === null ? '' : 'ms'}
                      detail="Origin attempts · recent 180"
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
                                  <button
                                    className="inspect-button"
                                    aria-label={`Inspect request ${e.id}`}
                                    onClick={() => setSelectedEvent(e)}
                                  >
                                    {new Date(e.at).toLocaleTimeString('en-US', { hour12: false })}
                                    <span className="event-id">#{e.id}</span>
                                    <ChevronRight size={12} />
                                  </button>
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
                      <button onClick={() => download('json')} disabled={!events.length}>
                        <ArrowDownToLine size={14} /> JSON
                      </button>
                      <button onClick={() => download('csv')} disabled={!events.length}>
                        <ArrowDownToLine size={14} /> CSV
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
                            disabled={configDisabled}
                            className={s?.config.originMode === mode ? `selected ${mode}` : ''}
                            key={mode}
                            onClick={() => configure({ originMode: mode })}
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
                          {Math.floor(tokens)} / {s?.config.capacity ?? 12}
                        </span>
                      </div>
                      <div className="token-meter">
                        {Array.from({ length: 20 }, (_, i) => (
                          <i
                            key={i}
                            className={
                              i / 20 < (s ? tokens / s.config.capacity : 1) ? 'filled' : ''
                            }
                          />
                        ))}
                      </div>
                      <p className="control-help">
                        Live refill estimate · enforced by the coordinator.
                      </p>
                      <Range
                        label="Burst capacity"
                        value={s?.config.capacity ?? 12}
                        min={1}
                        max={50}
                        unit="tokens"
                        disabled={configDisabled}
                        onChange={(value) => configure({ capacity: value })}
                      />
                      <Range
                        label="Refill rate"
                        value={s?.config.refillPerSecond ?? 4}
                        min={1}
                        max={20}
                        unit="/ sec"
                        disabled={configDisabled}
                        onChange={(value) => configure({ refillPerSecond: value })}
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
                        {s?.circuit === 'open'
                          ? cooldown
                            ? `Probe available in ${cooldown}s.`
                            : 'Next request can probe recovery.'
                          : `Cooldown: ${(s?.config.cooldownMs ?? 4000) / 1000}s.`}
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
                          disabled={configDisabled}
                          onClick={() => configure({ staleFallback: !s?.config.staleFallback })}
                        >
                          <span />
                        </button>
                      </div>
                      <div
                        className={`cache-status ${cacheAge !== null && cacheAge <= 60000 ? 'warm' : ''}`}
                      >
                        <Database size={13} />
                        {cacheAge === null
                          ? 'Cache empty · send a healthy request'
                          : cacheAge > 60000
                            ? 'Cache expired · a healthy response will refresh it'
                            : `Cached response · ${Math.floor(cacheAge / 1000)}s old / 60s limit`}
                      </div>
                      <details className="advanced-controls">
                        <summary>Timing & recovery settings</summary>
                        <Range
                          label="Origin delay"
                          value={s?.config.originLatencyMs ?? 160}
                          min={20}
                          max={3000}
                          unit="ms"
                          disabled={configDisabled}
                          onChange={(value) => configure({ originLatencyMs: value })}
                        />
                        <Range
                          label="Timeout budget"
                          value={s?.config.originTimeoutMs ?? 1500}
                          min={100}
                          max={5000}
                          unit="ms"
                          disabled={configDisabled}
                          onChange={(value) => configure({ originTimeoutMs: value })}
                        />
                        <Range
                          label="Failure threshold"
                          value={s?.config.failureThreshold ?? 3}
                          min={1}
                          max={10}
                          unit="failures"
                          disabled={configDisabled}
                          onChange={(value) => configure({ failureThreshold: value })}
                        />
                        <Range
                          label="Recovery cooldown"
                          value={s?.config.cooldownMs ?? 4000}
                          min={1000}
                          max={15000}
                          unit="ms"
                          disabled={configDisabled}
                          onChange={(value) => configure({ cooldownMs: value })}
                        />
                        <p className="control-help">
                          Set delay above the timeout to create a slow-origin failure.
                        </p>
                      </details>
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
                            setStep(-1);
                            setSelectedEvent(null);
                            setFilter('all');
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
                    <span className="tiny-dot" /> Expires after 24h idle · session{' '}
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
      <RequestInspector event={selectedEvent} onClose={() => setSelectedEvent(null)} />
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
createRoot(document.getElementById('root')!).render(<App />);
