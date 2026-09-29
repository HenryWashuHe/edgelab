import type { LabEvent, Snapshot } from '../worker/engine';
export function percentile95(events: LabEvent[]): number | null {
  const values = events
    .filter((e) => e.originAttempted)
    .map((e) => e.latencyMs)
    .sort((a, b) => a - b);
  return values.length ? values[Math.ceil(values.length * 0.95) - 1] : null;
}
export function asCsv(events: LabEvent[]): string {
  const columns = [
    'request_id',
    'time_utc',
    'status',
    'outcome',
    'latency_ms',
    'circuit',
    'origin_attempted',
    'cache_age_ms',
    'retry_after_s',
    'message',
  ];
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    columns,
    ...[...events]
      .reverse()
      .map((e) => [
        e.requestId,
        new Date(e.at).toISOString(),
        e.status,
        e.outcome,
        e.latencyMs,
        e.circuit,
        e.originAttempted,
        e.cacheAgeMs,
        e.retryAfter,
        e.message,
      ]),
  ]
    .map((row) => row.map(cell).join(','))
    .join('\r\n');
}
export function report(snapshot: Snapshot) {
  return {
    schemaVersion: 2,
    project: 'EdgeLab',
    exportedAt: new Date().toISOString(),
    environment: snapshot.colo === 'LOCAL' ? 'local' : 'cloudflare',
    measurement:
      'Server elapsed latency. Controlled origin Worker reached through a service binding. Latest 180 events; counters cover the full run.',
    ...snapshot,
  };
}
export function saveFile(contents: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the object URL alive until the browser has consumed the download navigation.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
