export type MonitorUnavailableReason =
  'daily-read-limit' | 'daily-write-limit' | 'storage-unavailable';

export function monitorFailureReason(error: unknown): MonitorUnavailableReason {
  const message = error instanceof Error ? error.message : '';
  if (/Exceeded allowed rows read in Durable Objects free tier/i.test(message))
    return 'daily-read-limit';
  if (/Exceeded allowed rows written in Durable Objects free tier/i.test(message))
    return 'daily-write-limit';
  return 'storage-unavailable';
}

/** Failure responses contain no provider exception, target, or private operator data. */
export function monitorUnavailable(reason: MonitorUnavailableReason, now: number) {
  const quota = reason !== 'storage-unavailable';
  return Response.json(
    {
      error:
        'Monitoring storage is temporarily unavailable. Current monitoring cannot be confirmed.',
      code: 'monitor-storage-unavailable',
      reason,
      retryAtUTC: quota
        ? new Date((Math.floor(now / 86400000) + 1) * 86400000).toISOString()
        : null,
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Retry-After': '60',
        Date: new Date(now).toUTCString(),
      },
    },
  );
}

/** A short isolate-local cooldown avoids repeatedly opening a quota-exhausted object.
 * It neither caches successful evidence nor guarantees a shared account limit.
 */
export function createMonitorForwarder(clock: () => number = () => Date.now()) {
  let cooldown: { reason: MonitorUnavailableReason; until: number } | null = null;
  return async (stub: Pick<Fetcher, 'fetch'>, request: Request): Promise<Response> => {
    const now = clock();
    if (cooldown && now < cooldown.until) return monitorUnavailable(cooldown.reason, now);
    cooldown = null;
    try {
      const response = await stub.fetch(request);
      // Preserve explicit JSON application failures, including sanitized AI errors.
      if (
        response.status >= 500 &&
        !response.headers.get('Content-Type')?.includes('application/json')
      )
        return monitorUnavailable('storage-unavailable', clock());
      return response;
    } catch (error) {
      const reason = monitorFailureReason(error);
      const failedAt = clock();
      if (reason !== 'storage-unavailable') cooldown = { reason, until: failedAt + 60000 };
      return monitorUnavailable(reason, failedAt);
    }
  };
}
