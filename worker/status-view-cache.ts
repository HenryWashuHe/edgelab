import {
  projectBudgetSignal,
  type BudgetAgeSource,
  type BudgetSignalSnapshot,
} from './budget-signals';
import { MINUTE, type MonitorPolicy, type MonitorState, type ProbeResult } from './monitor-domain';
import { monitoringReadiness, type MonitoringReadiness } from './monitor-readiness';

export const STATUS_VIEW_MAX_AGE_MS = 10000;
export const STATUS_VIEW_MAX_BYTES = 1024 * 1024;
export type StatusWindow = '24h' | '7d';
export type StatusViewRead = {
  source: 'storage' | 'memory';
  materializedAt: number;
  servedAt: number;
  ageMs: number;
  maxAgeMs: 10000;
};
type StatusService = {
  revision: number;
  policy: Pick<MonitorPolicy, 'paused'>;
  state: Pick<MonitorState, 'incidentId'>;
  latest: { observedAt: number | null; revision: number; outcome: ProbeResult['outcome'] } | null;
  status: string;
  budget: BudgetSignalSnapshot;
};
export type CacheableStatusView = {
  now: number;
  services: StatusService[];
  monitoring: MonitoringReadiness;
};
type Envelope<T> = { snapshot: T; budgetSources: BudgetAgeSource[] };
type Entry = {
  encoded: Uint8Array;
  fingerprint: string;
  generation: number;
  materializedAt: number;
};
export const validStatusClock = (at: number) =>
  Number.isSafeInteger(at) && at >= 0 && at <= 8640000000000000;

export function statusServiceAt(service: Omit<StatusService, 'budget' | 'status'>, now: number) {
  return service.policy.paused
    ? 'maintenance'
    : !validStatusClock(now) ||
        !service.latest ||
        service.latest.observedAt === null ||
        service.latest.revision !== service.revision ||
        now - service.latest.observedAt > 180000 ||
        service.latest.observedAt > now
      ? 'unknown'
      : service.state.incidentId
        ? 'incident'
        : service.latest.outcome === 'good'
          ? 'healthy'
          : 'degraded';
}

/** Project only delivery-clock fields. All measurements and evidence retain their source times. */
export function projectStatusView<T extends CacheableStatusView>(
  snapshot: T,
  budgetSources: BudgetAgeSource[],
  servedAt: number,
  source: StatusViewRead['source'],
): T & { read: StatusViewRead } {
  if (budgetSources.length !== snapshot.services.length)
    throw new Error('Budget source metadata must match the captured service rows');
  const view = structuredClone(snapshot);
  view.now = servedAt;
  view.services = view.services.map((service, index) => ({
    ...service,
    status: statusServiceAt(service, servedAt),
    budget: projectBudgetSignal(service.budget, budgetSources[index], service.revision, servedAt),
  }));
  view.monitoring = monitoringReadiness({
    now: servedAt,
    lastStartedAt: snapshot.monitoring.lastStartedAt,
    lastCompletedAt: snapshot.monitoring.lastCompletedAt,
    lastSlot: snapshot.monitoring.lastSlot,
    services: view.services.map((service) => ({
      paused: service.policy.paused,
      lastObservedAt:
        service.latest?.revision === service.revision ? service.latest.observedAt : null,
    })),
  });
  return {
    ...view,
    read: {
      source,
      materializedAt: snapshot.now,
      servedAt,
      ageMs: servedAt - snapshot.now,
      maxAgeMs: STATUS_VIEW_MAX_AGE_MS,
    },
  };
}

/** Two instance-local byte buffers; no persistent cache, timer, storage lookup or shared state. */
export class StatusViewCache<T extends CacheableStatusView> {
  private readonly entries = new Map<StatusWindow, Entry>();
  private generation = 0;
  private lastClock: number | null = null;
  private fingerprint: string | null = null;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  get retainedBytes() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.encoded.byteLength, 0);
  }
  get entryCount() {
    return this.entries.size;
  }
  invalidate() {
    this.entries.clear();
    this.generation++;
  }
  private context(fingerprint: string, now: number) {
    if (
      !validStatusClock(now) ||
      (this.lastClock !== null && now < this.lastClock) ||
      (this.fingerprint !== null && fingerprint !== this.fingerprint)
    ) {
      this.invalidate();
      this.lastClock = validStatusClock(now) ? now : null;
      this.fingerprint = fingerprint;
      return false;
    }
    this.lastClock = now;
    this.fingerprint = fingerprint;
    return true;
  }
  read(
    window: StatusWindow,
    fingerprint: string,
    now: number,
  ): (T & { read: StatusViewRead }) | null {
    if (!this.context(fingerprint, now)) return null;
    if (window !== '24h' && window !== '7d') return null;
    const entry = this.entries.get(window);
    if (!entry) return null;
    const age = now - entry.materializedAt;
    if (
      entry.generation !== this.generation ||
      entry.fingerprint !== fingerprint ||
      age < 0 ||
      age >= STATUS_VIEW_MAX_AGE_MS ||
      Math.floor(now / MINUTE) !== Math.floor(entry.materializedAt / MINUTE)
    ) {
      this.entries.delete(window);
      return null;
    }
    const captured = JSON.parse(this.decoder.decode(entry.encoded)) as Envelope<T>;
    return projectStatusView(captured.snapshot, captured.budgetSources, now, 'memory');
  }
  materialize(
    window: StatusWindow,
    fingerprint: string,
    snapshot: T,
    budgetSources: BudgetAgeSource[],
  ): T & { read: StatusViewRead } {
    const cacheableContext = this.context(fingerprint, snapshot.now);
    const view = projectStatusView(snapshot, budgetSources, snapshot.now, 'storage');
    // Invalid SQL metadata must not be normalized by JSON serialization into a fresh signal.
    const cacheableSources =
      budgetSources.length === snapshot.services.length &&
      budgetSources.every(
        (source) =>
          source === null ||
          (Number.isSafeInteger(source.revision) &&
            source.revision >= 1 &&
            validStatusClock(source.computedAt)),
      );
    this.entries.delete(window);
    if (!cacheableContext || !cacheableSources || (window !== '24h' && window !== '7d'))
      return view;
    const encoded = this.encoder.encode(JSON.stringify({ snapshot, budgetSources }));
    if (encoded.byteLength > STATUS_VIEW_MAX_BYTES) return view;
    // Keep at most both canonical windows, evicting the older insertion to honor the combined cap.
    while (this.retainedBytes + encoded.byteLength > STATUS_VIEW_MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(window, {
      encoded,
      fingerprint,
      generation: this.generation,
      materializedAt: snapshot.now,
    });
    return view;
  }
}
