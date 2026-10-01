export const MAX_UPSTREAM_JSON_BYTES = 16_384;

export type BoundedJsonResult =
  | { kind: 'json'; status: number; value: unknown }
  | { kind: 'http-error' | 'invalid-body'; status: number }
  | { kind: 'timeout' | 'network-error'; status: null };

type Options = {
  timeoutMs: number;
  acceptResponse: (response: Response) => boolean;
};

/** Cancellation is a request for cleanup, never an additional awaited operation. */
function cancelBody(body: ReadableStream<Uint8Array> | null) {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    // A late upstream can return an already locked/errored body.
  }
}

/**
 * Own one result across fetch and bounded JSON consumption. A timed-out fetch
 * may still run upstream; any response it later returns is discarded/canceled.
 */
export function fetchBoundedJson(
  fetchResponse: (signal: AbortSignal) => Promise<Response>,
  { timeoutMs, acceptResponse }: Options,
): Promise<BoundedJsonResult> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let body: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyFinished = false;

    function cleanup() {
      if (reader) {
        if (!bodyFinished) {
          try {
            void reader.cancel().catch(() => {});
          } catch {
            // Cancellation failure cannot replace the already settled result.
          }
        }
        try {
          reader.releaseLock();
        } catch {
          // Best effort: the helper never waits for upstream cleanup.
        }
        reader = undefined;
      } else if (!bodyFinished) cancelBody(body);
      body = null;
    }
    function finish(result: BoundedJsonResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      cleanup();
    }
    function expire() {
      finish({ kind: 'timeout', status: null });
      controller.abort();
    }
    function active() {
      if (!settled && Date.now() >= deadlineAt) expire();
      return !settled;
    }

    timer = setTimeout(expire, timeoutMs);
    void (async () => {
      try {
        if (!active()) return;
        const response = await fetchResponse(controller.signal);
        if (!active()) {
          cancelBody(response.body);
          return;
        }
        body = response.body;
        if (!acceptResponse(response)) {
          finish({ kind: 'http-error', status: response.status });
          return;
        }
        if (!body) {
          finish({ kind: 'invalid-body', status: response.status });
          return;
        }
        reader = body.getReader();
        // Retain one fixed buffer rather than arbitrarily many small chunks.
        const buffer = new Uint8Array(MAX_UPSTREAM_JSON_BYTES);
        let size = 0;
        let readsSinceYield = 0;
        while (active()) {
          const { value, done } = await reader.read();
          if (!active()) return;
          if (done) {
            bodyFinished = true;
            break;
          }
          if (value.byteLength > MAX_UPSTREAM_JSON_BYTES - size) {
            finish({ kind: 'invalid-body', status: response.status });
            return;
          }
          buffer.set(value, size);
          size += value.byteLength;
          // Immediately resolved reads, including empty chunks, must not starve
          // the deadline timer. Yield without imposing a chunk-count restriction.
          if (++readsSinceYield === 64) {
            readsSinceYield = 0;
            await new Promise<void>((resume) => setTimeout(resume, 0));
          }
        }
        if (!active()) return;
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder().decode(buffer.subarray(0, size)));
        } catch {
          finish({ kind: 'invalid-body', status: response.status });
          return;
        }
        if (active()) finish({ kind: 'json', status: response.status, value });
      } catch {
        if (active()) finish({ kind: 'network-error', status: null });
      }
    })();
  });
}
