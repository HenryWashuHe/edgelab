export const MAX_REQUEST_BODY_BYTES = 4096;
export const REQUEST_BODY_TIMEOUT_MS = 10000;

export type RequestBodyResult =
  { kind: 'body'; body: string } | { kind: 'too-large' | 'timeout' | 'unreadable' };

/**
 * Bound incoming body completion and retained bytes. Cancellation requests cleanup
 * without waiting for a constructed stream's cancellation hook to finish.
 */
export function readRequestBody(
  request: Pick<Request, 'body' | 'signal'>,
): Promise<RequestBodyResult> {
  const deadlineAt = Date.now() + REQUEST_BODY_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyFinished = false;
    let signal: AbortSignal | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!reader) return;
      if (!bodyFinished) {
        try {
          void reader.cancel().catch(() => {});
        } catch {
          // Cleanup failure cannot replace an already selected body result.
        }
      }
      try {
        reader.releaseLock();
      } catch {
        // A pending native read may prevent release; its late result is ignored.
      }
      reader = undefined;
    }
    function finish(result: RequestBodyResult) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }
    function onAbort() {
      finish({ kind: 'unreadable' });
    }
    function expire() {
      finish({ kind: 'timeout' });
    }
    function active() {
      if (!settled) {
        if (signal?.aborted) onAbort();
        else if (Date.now() >= deadlineAt) expire();
      }
      return !settled;
    }

    try {
      signal = request.signal;
      if (!active()) return;
      if (!request.body) {
        finish({ kind: 'body', body: '' });
        return;
      }
      reader = request.body.getReader();
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
    } catch {
      finish({ kind: 'unreadable' });
      return;
    }

    void (async () => {
      try {
        const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES);
        let size = 0;
        let readsSinceYield = 0;
        while (active()) {
          const { value, done } = await reader!.read();
          if (!active()) return;
          if (done) {
            bodyFinished = true;
            finish({ kind: 'body', body: new TextDecoder().decode(bytes.subarray(0, size)) });
            return;
          }
          if (!(value instanceof Uint8Array)) {
            finish({ kind: 'unreadable' });
            return;
          }
          if (value.byteLength > MAX_REQUEST_BODY_BYTES - size) {
            finish({ kind: 'too-large' });
            return;
          }
          bytes.set(value, size);
          size += value.byteLength;
          // Empty or immediately resolved reads must still give the timer a turn.
          if (++readsSinceYield === 64) {
            readsSinceYield = 0;
            await new Promise<void>((resume) => setTimeout(resume, 0));
          }
        }
      } catch {
        if (active()) finish({ kind: 'unreadable' });
      }
    })();
  });
}
