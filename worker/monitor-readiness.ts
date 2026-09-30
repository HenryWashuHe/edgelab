import { MINUTE } from './monitor-domain';

/** One minute is one current observation opportunity; delayed cron events cannot recreate history. */
export const MONITOR_CADENCE_MS = MINUTE;
/** Three cadence intervals tolerate ordinary scheduling/probe delay without hiding a stopped monitor. */
export const MONITOR_FRESHNESS_MS = 3 * MONITOR_CADENCE_MS;

export type TickClassification = {
  accepted: boolean;
  status: 'accepted' | 'skipped-late' | 'invalid';
  reason: string;
};

export function classifyTick(slot: number, now: number): TickClassification {
  if (!Number.isFinite(now) || now < 0 || !Number.isInteger(slot) || slot < 0)
    return {
      accepted: false,
      status: 'invalid',
      reason: 'A nonnegative integer slot and a valid current time are required.',
    };
  const currentSlot = Math.floor(now / MONITOR_CADENCE_MS);
  if (slot > currentSlot)
    return {
      accepted: false,
      status: 'invalid',
      reason: 'Future scheduled minutes cannot be observed.',
    };
  if (slot < currentSlot)
    return {
      accepted: false,
      status: 'skipped-late',
      reason: 'The scheduled minute has passed; a current probe cannot fill its historical gap.',
    };
  return { accepted: true, status: 'accepted', reason: 'The scheduled minute is current.' };
}

export type MonitoringReadinessInput = {
  now: number;
  services: { paused: boolean; lastObservedAt: number | null }[];
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSlot: number | null;
};
export type MonitoringReadiness = {
  status: 'starting' | 'healthy' | 'partial' | 'stalled';
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastSlot: number | null;
  ageMs: number | null;
  reason: string;
};

const validTimestamp = (value: number, now: number) =>
  Number.isFinite(value) && value >= 0 && value <= now;

/** Pure reads only age persisted evidence; they never renew scheduler or service heartbeats. */
export function monitoringReadiness(input: MonitoringReadinessInput): MonitoringReadiness {
  const { now, services, lastStartedAt, lastCompletedAt, lastSlot } = input;
  const ageMs =
    Number.isFinite(now) &&
    now >= 0 &&
    lastCompletedAt !== null &&
    validTimestamp(lastCompletedAt, now)
      ? now - lastCompletedAt
      : null;
  const summary = (status: MonitoringReadiness['status'], reason: string): MonitoringReadiness => ({
    status,
    lastStartedAt,
    lastCompletedAt,
    lastSlot,
    ageMs,
    reason,
  });

  if (!Number.isFinite(now) || now < 0)
    return summary(
      'stalled',
      'Current time is invalid; monitoring freshness cannot be established.',
    );
  if (
    (lastStartedAt !== null && !validTimestamp(lastStartedAt, now)) ||
    (lastCompletedAt !== null && !validTimestamp(lastCompletedAt, now)) ||
    (lastSlot !== null &&
      (!Number.isInteger(lastSlot) ||
        lastSlot < 0 ||
        lastSlot > Math.floor(now / MONITOR_CADENCE_MS)))
  )
    return summary(
      'stalled',
      'Scheduler evidence contains an invalid or future timestamp or slot.',
    );
  if (lastCompletedAt === null)
    return summary('starting', 'No scheduled monitoring run has completed yet.');
  if (lastStartedAt === null || lastSlot === null)
    return summary('stalled', 'Completed scheduler evidence is missing its start time or slot.');
  if (ageMs === null || ageMs > MONITOR_FRESHNESS_MS)
    return summary('stalled', 'The last completed scheduled run is older than three minutes.');

  const active = services.filter((service) => !service.paused);
  if (
    active.some(
      ({ lastObservedAt }) =>
        lastObservedAt === null ||
        !validTimestamp(lastObservedAt, now) ||
        now - lastObservedAt > MONITOR_FRESHNESS_MS,
    )
  )
    return summary(
      'partial',
      'The scheduler is fresh, but active service observations are missing or stale.',
    );
  if (active.length === 0)
    return summary(
      'healthy',
      services.length > 0
        ? 'The scheduler is fresh; all services are paused and no probes are expected.'
        : 'The scheduler is fresh; no services are configured.',
    );
  return summary('healthy', 'The scheduler and all active service observations are fresh.');
}
