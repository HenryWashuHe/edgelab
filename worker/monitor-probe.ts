import { isCatalogPayload } from './origin';
import type { MonitorPolicy, MonitorTarget, ProbeResult } from './monitor-domain';
export async function probe(
  target: MonitorTarget,
  policy: MonitorPolicy,
  origin: Pick<Fetcher, 'fetch'>,
): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = (outcome: ProbeResult['outcome'], status: number | null = null): ProbeResult => ({
    outcome,
    status,
    latencyMs: Date.now() - started,
  });
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(result('timeout'));
    }, policy.timeoutMs);
  });
  const work = (async () => {
    try {
      const request = new Request(target.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'EdgeLab-Monitor/3.0' },
      });
      const response = await (target.transport === 'origin'
        ? origin.fetch(request)
        : fetch(request));
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        return result('http-error', response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) return result('invalid-body', response.status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) {
            void reader.cancel().catch(() => {});
            return result('invalid-body', 200);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return result('invalid-body', 200);
      }
      const valid =
        target.assertion === 'catalog-json'
          ? isCatalogPayload(body)
          : !!body && typeof body === 'object' && 'ok' in body && body.ok === true;
      return result(
        !valid
          ? 'invalid-body'
          : Date.now() - started > policy.latencyObjectiveMs
            ? 'slow'
            : 'good',
        200,
      );
    } catch {
      return result(controller.signal.aborted ? 'timeout' : 'network-error');
    }
  })();
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
