import { describe, expect, it } from 'vitest';
import {
  classifyLabFailure,
  isLabHttpFailure,
  labAdmissionFailureMessage,
  settleLabBatch,
} from '../src/lab-request-control';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function watch(promise: Promise<void>) {
  const result: { settled: boolean; rejected: boolean; failure: unknown } = {
    settled: false,
    rejected: false,
    failure: undefined,
  };
  const completion = promise.then(
    () => {
      result.settled = true;
    },
    (failure: unknown) => {
      result.settled = true;
      result.rejected = true;
      result.failure = failure;
    },
  );
  return { result, completion };
}

describe('settle every dispatched lab request before reporting a failure', () => {
  it.each(['resolve', 'reject'] as const)(
    'keeps a batch pending after early rejection until a held sibling %ss',
    async (settlement) => {
      const first = deferred();
      const held = deferred();
      const failure = new Error('gateway rejected this request');
      const observed = watch(settleLabBatch([first.promise, held.promise]));

      first.reject(failure);
      await flushMicrotasks();
      expect(observed.result.settled).toBe(false);

      if (settlement === 'resolve') held.resolve();
      else held.reject(new Error('later sibling failure'));
      await observed.completion;
      expect(observed.result).toEqual({ settled: true, rejected: true, failure });
    },
  );

  it('waits for held sibling rejection without replacing the first observed failure', async () => {
    const earlierInput = deferred();
    const laterInput = deferred();
    const heldSuccess = deferred();
    const firstFailure = { code: 'lab-admission-limited' };
    const observed = watch(
      settleLabBatch([earlierInput.promise, laterInput.promise, heldSuccess.promise]),
    );

    laterInput.reject(firstFailure);
    await flushMicrotasks();
    expect(observed.result.settled).toBe(false);

    earlierInput.reject(new Error('a later sibling rejection'));
    await flushMicrotasks();
    expect(observed.result.settled).toBe(false);

    heldSuccess.resolve();
    await observed.completion;
    expect(observed.result.failure).toBe(firstFailure);
    expect(observed.result.rejected).toBe(true);
  });

  it('does not release the caller action lock while a dispatched sibling is held', async () => {
    const failed = deferred();
    const held = deferred();
    let busy = true;
    let finalRefreshes = 0;
    const action = (async () => {
      try {
        await settleLabBatch([failed.promise, held.promise]);
        finalRefreshes++;
      } finally {
        busy = false;
      }
    })();
    const observed = watch(action);

    failed.reject(new Error('admission failure'));
    await flushMicrotasks();
    expect(busy).toBe(true);
    expect(finalRefreshes).toBe(0);

    held.resolve();
    await observed.completion;
    expect(busy).toBe(false);
    expect(finalRefreshes).toBe(0);
    expect(observed.result.rejected).toBe(true);
  });

  it('waits for every successful request and performs no second dispatch on failure', async () => {
    const first = deferred();
    const held = deferred();
    let dispatches = 0;
    const dispatch = (task: Promise<void>) => {
      dispatches++;
      return task;
    };
    const observed = watch(settleLabBatch([dispatch(first.promise), dispatch(held.promise)]));
    first.resolve();
    await flushMicrotasks();
    expect(observed.result.settled).toBe(false);
    expect(dispatches).toBe(2);
    held.resolve();
    await observed.completion;
    expect(observed.result.rejected).toBe(false);
    expect(dispatches).toBe(2);

    const failed = deferred();
    const sibling = deferred();
    const retryCheck = watch(settleLabBatch([dispatch(failed.promise), dispatch(sibling.promise)]));
    failed.reject(new Error('rejected'));
    sibling.resolve();
    await retryCheck.completion;
    expect(retryCheck.result.rejected).toBe(true);
    expect(dispatches).toBe(4);
  });

  it('handles an empty batch and preserves an undefined rejection reason', async () => {
    await expect(settleLabBatch([])).resolves.toBeUndefined();
    const failed = deferred();
    const observed = watch(settleLabBatch([failed.promise]));
    failed.reject(undefined);
    await observed.completion;
    expect(observed.result).toEqual({
      settled: true,
      rejected: true,
      failure: undefined,
    });
  });
});

const requestId = '11111111-1111-4111-8111-111111111111';
const decision = (outcome: string, status: number) => ({ outcome, status, requestId });

describe('gateway admission failures are not committed engine outcomes', () => {
  it.each([
    ['lab-admission-limited', 'admission-limited', 429],
    ['lab-admission-unavailable', 'admission-unavailable', 503],
  ] as const)('prioritizes %s over misleading outcome and HTTP success', (code, kind, status) => {
    const payload = { ...decision('limited', 429), code, retryAfterSeconds: 60 };
    expect(classifyLabFailure(status, payload)).toEqual({ kind: 'unconfirmed-admission' });
    expect(isLabHttpFailure('request', status, payload)).toBe(true);
    expect(isLabHttpFailure('request', 200, payload)).toBe(true);
    expect(isLabHttpFailure('state', status, payload)).toBe(true);
    expect(
      classifyLabFailure(status, {
        error: 'sanitized gateway message',
        code,
        retryAfterSeconds: 60,
      }),
    ).toEqual({ kind, retryAfterSeconds: 60 });
  });

  it.each([
    ['limited', 429],
    ['blocked', 503],
    ['error', 502],
    ['error', 504],
  ])('keeps real request engine %s/%s decisions readable', (outcome, status) => {
    expect(isLabHttpFailure('request', status, decision(String(outcome), Number(status)))).toBe(
      false,
    );
  });

  it('rejects truthy outcomes on other routes or with invalid engine metadata', () => {
    for (const path of ['state', 'config', 'reset', 'observe'])
      expect(isLabHttpFailure(path, 429, decision('limited', 429))).toBe(true);
    for (const payload of [
      null,
      [],
      { outcome: true },
      { outcome: 'limited' },
      decision('unknown', 429),
      decision('origin', 429),
      decision('limited', 503),
      { ...decision('limited', 429), status: '429' },
      { ...decision('limited', 429), requestId: 'not-a-uuid' },
      { ...decision('limited', 429), requestId: '11111111-1111-1111-8111-111111111111' },
    ])
      expect(isLabHttpFailure('request', 429, payload)).toBe(true);
  });

  it('keeps ordinary HTTP success behavior without claiming to validate snapshots', () => {
    for (const path of ['state', 'config', 'reset', 'request'])
      expect(isLabHttpFailure(path, 200, {})).toBe(false);
    expect(isLabHttpFailure('request', 502, { error: 'bad gateway' })).toBe(true);
    expect(classifyLabFailure(503, { code: 'lab-storage-unavailable' })).toBeNull();
    expect(classifyLabFailure(429, { code: 'lab-admission-limited-extra' })).toBeNull();
  });

  it.each([
    ['lab-admission-limited', 429],
    ['lab-admission-unavailable', 503],
  ] as const)(
    'requires the complete minimal %s payload/status before refusal copy',
    (code, status) => {
      const payload = { error: 'sanitized gateway message', code, retryAfterSeconds: 60 };
      for (const retryAfterSeconds of [undefined, '60', -1, 0, Infinity, 61]) {
        const malformed = { ...payload, retryAfterSeconds };
        expect(classifyLabFailure(status, malformed)).toEqual({ kind: 'unconfirmed-admission' });
        expect(isLabHttpFailure('request', status, malformed)).toBe(true);
      }
      for (const malformed of [
        { code, retryAfterSeconds: 60 },
        { ...payload, error: '' },
        { ...payload, error: 42 },
        { ...payload, outcome: 'limited' },
        { ...payload, requestId },
        { ...payload, state: {} },
        { ...payload, reason: 'not-in-the-admission-contract' },
      ]) {
        expect(classifyLabFailure(status, malformed)).toEqual({ kind: 'unconfirmed-admission' });
        expect(isLabHttpFailure('request', status, malformed)).toBe(true);
      }
      for (const contradictoryStatus of [200, status === 429 ? 503 : 429]) {
        expect(classifyLabFailure(contradictoryStatus, payload)).toEqual({
          kind: 'unconfirmed-admission',
        });
        expect(isLabHttpFailure('request', contradictoryStatus, payload)).toBe(true);
      }
    },
  );

  it.each(['admission-limited', 'admission-unavailable'] as const)(
    'explains %s while preserving uncertainty about other writes and read-only reconnect',
    (kind) => {
      for (const hasSnapshot of [false, true]) {
        const message = labAdmissionFailureMessage({ kind, retryAfterSeconds: 60 }, hasSnapshot);
        expect(message).toMatch(/before reaching the lab|was not forwarded to the lab/);
        expect(message).toContain('Earlier or concurrent writes may have completed.');
        expect(message).toContain('Current lab state cannot be confirmed.');
        expect(message).toContain('does not guarantee admission');
        expect(message).toContain('Reconnect reads state only');
        expect(message).toContain('does not repeat a request, reset, or configuration change');
        expect(message).toContain(
          hasSnapshot ? 'Cached results are shown.' : 'No lab snapshot has loaded.',
        );
        expect(message).not.toMatch(/storage|quota|committed outcome|requests were cancelled/i);
      }
    },
  );

  it('keeps malformed known-code results generic without claiming refusal or echoing text', () => {
    const payload = {
      error: 'This write was definitely refused; secret raw diagnostic',
      code: 'lab-admission-limited',
      retryAfterSeconds: 60,
      outcome: 'limited',
    };
    const failure = classifyLabFailure(429, payload);
    expect(failure).toEqual({ kind: 'unconfirmed-admission' });
    const message = labAdmissionFailureMessage(failure!, true);
    expect(message).toContain('The lab request did not produce a confirmed result.');
    expect(message).toContain('Earlier or concurrent writes may have completed.');
    expect(message).toContain('Reconnect reads state only');
    expect(message).not.toMatch(
      /not forwarded|rejected|refused|before reaching|60 seconds|secret/i,
    );
  });
});
