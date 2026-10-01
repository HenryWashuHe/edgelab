import { isCatalogPayload } from './origin';
import { fetchBoundedJson } from './bounded-json';
import type { MonitorPolicy, MonitorTarget, ProbeResult } from './monitor-domain';
export async function probe(
  target: MonitorTarget,
  policy: MonitorPolicy,
  origin: Pick<Fetcher, 'fetch'>,
): Promise<ProbeResult> {
  const started = Date.now();
  const result = (outcome: ProbeResult['outcome'], status: number | null = null): ProbeResult => ({
    outcome,
    status,
    latencyMs: Date.now() - started,
  });
  const response = await fetchBoundedJson(
    async (signal) => {
      const request = new Request(target.url, {
        redirect: 'manual',
        signal,
        headers: { Accept: 'application/json', 'User-Agent': 'EdgeLab-Monitor/3.0' },
      });
      return target.transport === 'origin' ? origin.fetch(request) : fetch(request);
    },
    { timeoutMs: policy.timeoutMs, acceptResponse: (response) => response.status === 200 },
  );
  if (response.kind !== 'json') return result(response.kind, response.status);
  const body = response.value;
  const valid =
    target.assertion === 'catalog-json'
      ? isCatalogPayload(body)
      : !!body && typeof body === 'object' && 'ok' in body && body.ok === true;
  return result(
    !valid ? 'invalid-body' : Date.now() - started > policy.latencyObjectiveMs ? 'slow' : 'good',
    response.status,
  );
}
