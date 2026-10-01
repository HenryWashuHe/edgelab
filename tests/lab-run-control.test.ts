import { describe, expect, it } from 'vitest';
import { checkDemoStop, LabDemoStopped, settleLabRun } from '../src/lab-run-control';
import { settleLabBatch } from '../src/lab-request-control';

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

describe('settled demo cancellation and state confirmation', () => {
  it.each(['reset', 'request'])(
    'waits for a held %s commit and final read before unlocking',
    async (kind) => {
      const write = deferred();
      const read = deferred();
      const controller = new AbortController();
      const events = [`${kind}:dispatched`];
      let confirmed = true;
      let busy = true;
      let reads = 0;
      const operation = (async () => {
        await write.promise;
        events.push(`${kind}:settled`);
        checkDemoStop(controller.signal);
      })();
      const run = settleLabRun(operation, {
        isCurrent: () => true,
        markUnconfirmed: () => {
          confirmed = false;
          events.push('unconfirmed');
        },
        confirmState: async () => {
          expect(confirmed).toBe(false);
          reads++;
          events.push('state:dispatched');
          await read.promise;
          confirmed = true;
          events.push('state:confirmed');
        },
      }).finally(() => {
        busy = false;
        events.push('unlocked');
      });
      controller.abort();
      await flushMicrotasks();
      expect(busy).toBe(true);
      expect(reads).toBe(0);
      expect(events).toEqual([`${kind}:dispatched`]);

      write.resolve();
      await flushMicrotasks();
      expect(busy).toBe(true);
      expect(confirmed).toBe(false);
      expect(reads).toBe(1);
      controller.abort();
      controller.abort();
      await flushMicrotasks();
      expect(busy).toBe(true);
      expect(reads).toBe(1);
      read.resolve();
      expect(await run).toBe('stopped');
      expect(confirmed).toBe(true);
      expect(busy).toBe(false);
      expect(reads).toBe(1);
      expect(events).toEqual([
        `${kind}:dispatched`,
        `${kind}:settled`,
        'unconfirmed',
        'state:dispatched',
        'state:confirmed',
        'unlocked',
      ]);
    },
  );

  it('leaves cached state unconfirmed when the final read fails, without replay', async () => {
    const failure = { status: 503, code: 'lab-storage-unavailable' };
    let confirmed = true;
    let reads = 0;
    const run = settleLabRun(Promise.reject(new LabDemoStopped()), {
      isCurrent: () => true,
      markUnconfirmed: () => {
        confirmed = false;
      },
      confirmState: async () => {
        reads++;
        throw failure;
      },
    });
    await expect(run).rejects.toBe(failure);
    expect(confirmed).toBe(false);
    expect(reads).toBe(1);
  });

  it.each([
    new Error('transport failed'),
    new DOMException('Unknown transport cancellation', 'AbortError'),
    { code: 'lab-admission-limited', status: 429 },
    { code: 'lab-admission-unavailable', status: 503 },
    undefined,
  ])('does not turn an unexpected rejected write into a final read', async (failure) => {
    const write = deferred();
    const controller = new AbortController();
    let marks = 0;
    let reads = 0;
    const operation = (async () => {
      await write.promise;
      checkDemoStop(controller.signal);
    })();
    const run = settleLabRun(operation, {
      isCurrent: () => true,
      markUnconfirmed: () => {
        marks++;
      },
      confirmState: async () => {
        reads++;
      },
    });
    const observed = run.then(
      () => ({ failed: false }),
      (error: unknown) => ({ failed: true, error }),
    );
    controller.abort();
    write.reject(failure);
    expect(await observed).toEqual({ failed: true, error: failure });
    expect(marks).toBe(0);
    expect(reads).toBe(0);
  });

  it('does not recognize a foreign error merely named LabDemoStopped', async () => {
    const error = new Error('foreign error');
    error.name = 'LabDemoStopped';
    let reads = 0;
    await expect(
      settleLabRun(Promise.reject(error), {
        isCurrent: () => true,
        markUnconfirmed: () => {},
        confirmState: async () => {
          reads++;
        },
      }),
    ).rejects.toBe(error);
    expect(reads).toBe(0);
  });

  it.each(['leave', 'leave and reenter'])(
    'performs no abandoned follow-up after %s',
    async (navigation) => {
      const write = deferred();
      const controller = new AbortController();
      const capturedEpoch = 1;
      let epoch = capturedEpoch;
      let active = true;
      let marks = 0;
      let reads = 0;
      const operation = (async () => {
        await write.promise;
        checkDemoStop(controller.signal);
      })();
      const run = settleLabRun(operation, {
        isCurrent: () => active && epoch === capturedEpoch,
        markUnconfirmed: () => {
          marks++;
        },
        confirmState: async () => {
          reads++;
        },
      });
      controller.abort();
      active = false;
      epoch++;
      if (navigation === 'leave and reenter') {
        active = true;
        epoch++;
      }
      write.resolve();
      expect(await run).toBe('abandoned');
      expect(marks).toBe(0);
      expect(reads).toBe(0);
    },
  );

  it('rechecks the page guard before initiating a final read', async () => {
    let active = true;
    let reads = 0;
    expect(
      await settleLabRun(Promise.reject(new LabDemoStopped()), {
        isCurrent: () => active,
        markUnconfirmed: () => {
          active = false;
        },
        confirmState: async () => {
          reads++;
        },
      }),
    ).toBe('abandoned');
    expect(reads).toBe(0);
  });

  it.each(['resolve', 'reject'])(
    'reports abandonment when a final read %ss after navigation',
    async (settlement) => {
      const read = deferred();
      let active = true;
      let reads = 0;
      const run = settleLabRun(Promise.reject(new LabDemoStopped()), {
        isCurrent: () => active,
        markUnconfirmed: () => {},
        confirmState: async () => {
          reads++;
          await read.promise;
        },
      });
      await flushMicrotasks();
      expect(reads).toBe(1);
      active = false;
      if (settlement === 'resolve') read.resolve();
      else read.reject(new Error('old read failed'));
      expect(await run).toBe('abandoned');
      expect(reads).toBe(1);
    },
  );

  it('preserves the existing successful final read without marking it stopped', async () => {
    let reads = 0;
    let marks = 0;
    expect(
      await settleLabRun(Promise.resolve(), {
        isCurrent: () => true,
        markUnconfirmed: () => {
          marks++;
        },
        confirmState: async () => {
          reads++;
        },
      }),
    ).toBe('completed');
    expect(marks).toBe(0);
    expect(reads).toBe(1);
  });

  it('starts no final read when a successful operation settles on an abandoned page', async () => {
    const operation = deferred();
    let active = true;
    let reads = 0;
    const run = settleLabRun(operation.promise, {
      isCurrent: () => active,
      markUnconfirmed: () => {},
      confirmState: async () => {
        reads++;
      },
    });
    active = false;
    operation.resolve();
    expect(await run).toBe('abandoned');
    expect(reads).toBe(0);
  });

  it('recognizes only an aborted demo signal at its own check', () => {
    const controller = new AbortController();
    expect(() => checkDemoStop(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => checkDemoStop(controller.signal)).toThrow(LabDemoStopped);
  });

  it('keeps a failed burst settled with no new confirmation read or dispatch', async () => {
    const rejected = deferred();
    const held = deferred();
    const failure = new Error('admission refused');
    let reads = 0;
    let settled = false;
    const run = settleLabRun(settleLabBatch([rejected.promise, held.promise]), {
      isCurrent: () => true,
      markUnconfirmed: () => {},
      confirmState: async () => {
        reads++;
      },
    });
    const observed = run.catch((error: unknown) => {
      settled = true;
      return error;
    });
    rejected.reject(failure);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(reads).toBe(0);
    held.resolve();
    expect(await observed).toBe(failure);
    expect(reads).toBe(0);
  });
});
