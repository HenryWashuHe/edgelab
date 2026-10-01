import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBoundedJson, MAX_UPSTREAM_JSON_BYTES } from '../worker/bounded-json';

const options = { timeoutMs: 100, acceptResponse: (response: Response) => response.ok };
const encoder = new TextEncoder();
afterEach(() => vi.useRealTimers());

function jsonBytes(size: number) {
  const base = JSON.stringify({ value: 'é😄', padding: '' });
  return encoder.encode(
    JSON.stringify({ value: 'é😄', padding: 'x'.repeat(size - encoder.encode(base).length) }),
  );
}

function chunked(bytes: Uint8Array, splits: number[]) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const end of [...splits, bytes.length]) {
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
      controller.close();
    },
  });
}

describe('bounded upstream JSON lifetime', () => {
  it('accepts the exact UTF-8 byte cap across split multibyte characters and releases the reader', async () => {
    const bytes = jsonBytes(MAX_UPSTREAM_JSON_BYTES);
    const emoji = bytes.indexOf(0xf0);
    const body = chunked(bytes, [emoji + 1, emoji + 3, 1024]);
    const cancel = vi.spyOn(body, 'cancel');
    expect(bytes.length).toBe(MAX_UPSTREAM_JSON_BYTES);
    const result = await fetchBoundedJson(async () => new Response(body), options);
    expect(result).toMatchObject({ kind: 'json', status: 200, value: { value: 'é😄' } });
    expect(body.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rejects one excess UTF-8 byte without retaining or returning the body', async () => {
    const bytes = jsonBytes(MAX_UPSTREAM_JSON_BYTES + 1);
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, MAX_UPSTREAM_JSON_BYTES));
        controller.enqueue(bytes.subarray(MAX_UPSTREAM_JSON_BYTES));
      },
      cancel() {
        canceled++;
      },
    });
    expect(await fetchBoundedJson(async () => new Response(body), options)).toEqual({
      kind: 'invalid-body',
      status: 200,
    });
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });

  it.each(['pending', 'rejecting'] as const)(
    'settles a pending read at the deadline even when cancellation is %s',
    async (behavior) => {
      vi.useFakeTimers();
      let canceled = 0;
      let signal: AbortSignal | undefined;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled++;
          return behavior === 'pending'
            ? new Promise<void>(() => {})
            : Promise.reject(new Error('private cleanup failure'));
        },
      });
      const response = new Response(body);
      const getReader = vi.spyOn(body, 'getReader');
      const pending = fetchBoundedJson(async (inputSignal) => {
        signal = inputSignal;
        return response;
      }, options);
      await vi.advanceTimersByTimeAsync(0);
      expect(getReader).toHaveBeenCalledOnce();
      expect(body.locked).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toEqual({ kind: 'timeout', status: null });
      expect(signal?.aborted).toBe(true);
      expect(canceled).toBe(1);
      expect(body.locked).toBe(false);
    },
  );

  it('never acquires a reader for a response arriving after timeout, even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
        return new Promise<void>(() => {});
      },
    });
    const getReader = vi.spyOn(body, 'getReader');
    const pending = fetchBoundedJson(() => new Promise((resolve) => (deliver = resolve)), options);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result).toEqual({ kind: 'timeout', status: null });
    deliver(new Response(body));
    await vi.advanceTimersByTimeAsync(0);
    expect(canceled).toBe(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(await pending).toBe(result);
  });

  it.each(['pending', 'rejecting'] as const)(
    'preserves HTTP error classification when body cancellation is %s',
    async (behavior) => {
      let canceled = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled++;
          return behavior === 'pending'
            ? new Promise<void>(() => {})
            : Promise.reject(new Error('private body failure'));
        },
      });
      const getReader = vi.spyOn(body, 'getReader');
      expect(
        await fetchBoundedJson(async () => new Response(body, { status: 503 }), options),
      ).toEqual({ kind: 'http-error', status: 503 });
      expect(canceled).toBe(1);
      expect(getReader).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    },
  );

  it('does not let immediately resolved empty reads starve its deadline', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        canceled++;
      },
    });
    const pending = fetchBoundedJson(async () => new Response(body), options);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ kind: 'timeout', status: null });
    expect(reads).toBeGreaterThan(64);
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });

  it('accepts many empty chunks before valid JSON without a chunk-count rejection', async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads <= 130) controller.enqueue(new Uint8Array());
        else {
          controller.enqueue(encoder.encode('{"ok":true}'));
          controller.close();
        }
      },
    });
    expect(await fetchBoundedJson(async () => new Response(body), options)).toEqual({
      kind: 'json',
      status: 200,
      value: { ok: true },
    });
    expect(body.locked).toBe(false);
  });

  it('rejects invalid finished JSON and missing bodies, and sanitizes read/fetch errors', async () => {
    const invalid = new Response('{private malformed body');
    expect(await fetchBoundedJson(async () => invalid, options)).toEqual({
      kind: 'invalid-body',
      status: 200,
    });
    expect(invalid.body?.locked).toBe(false);
    expect(await fetchBoundedJson(async () => new Response(null), options)).toEqual({
      kind: 'invalid-body',
      status: 200,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('private stream failure'));
      },
    });
    expect(await fetchBoundedJson(async () => new Response(body), options)).toEqual({
      kind: 'network-error',
      status: null,
    });
    expect(body.locked).toBe(false);
    expect(
      await fetchBoundedJson(async () => {
        throw new Error('private provider failure');
      }, options),
    ).toEqual({ kind: 'network-error', status: null });
  });

  it('fences a body that finishes at the deadline rather than reporting late success', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const pending = fetchBoundedJson(async () => new Response(body), options);
    // Enqueue the body in the deadline tick. The result has one settlement owner.
    setTimeout(() => {
      try {
        controller.enqueue(encoder.encode('{"ok":true}'));
        controller.close();
      } catch {
        // The deadline has already canceled the stream.
      }
    }, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ kind: 'timeout', status: null });
    expect(body.locked).toBe(false);
  });
});
