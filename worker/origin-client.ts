import { isCatalogPayload, type CatalogPayload } from './origin';
export type OriginResult =
  { ok: true; payload: CatalogPayload } | { ok: false; reason: 'timeout' | 'error' | 'invalid' };
/** Own the timeout and consume the response within it; never accept arbitrary target URLs. */
export async function callOrigin(
  origin: Pick<Fetcher, 'fetch'>,
  delay: number,
  fails: boolean,
  timeoutMs: number,
): Promise<OriginResult> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<OriginResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
  });
  const work = (async (): Promise<OriginResult> => {
    try {
      const response = await origin.fetch('https://origin.internal/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delay, fails }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, reason: 'error' };
      }
      const payload = await response.json();
      return isCatalogPayload(payload) ? { ok: true, payload } : { ok: false, reason: 'invalid' };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'error' };
    }
  })();
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timeout);
  }
}
