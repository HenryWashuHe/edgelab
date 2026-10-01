import { isCatalogPayload, type CatalogPayload } from './origin';
import { fetchBoundedJson } from './bounded-json';
export type OriginResult =
  { ok: true; payload: CatalogPayload } | { ok: false; reason: 'timeout' | 'error' | 'invalid' };
/** Own the timeout and consume the response within it; never accept arbitrary target URLs. */
export async function callOrigin(
  origin: Pick<Fetcher, 'fetch'>,
  delay: number,
  fails: boolean,
  timeoutMs: number,
): Promise<OriginResult> {
  const response = await fetchBoundedJson(
    (signal) =>
      origin.fetch('https://origin.internal/catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delay, fails }),
        signal,
      }),
    { timeoutMs, acceptResponse: (response) => response.ok },
  );
  if (response.kind === 'timeout') return { ok: false, reason: 'timeout' };
  if (response.kind === 'invalid-body') return { ok: false, reason: 'invalid' };
  if (response.kind !== 'json') return { ok: false, reason: 'error' };
  return isCatalogPayload(response.value)
    ? { ok: true, payload: response.value }
    : { ok: false, reason: 'invalid' };
}
