import { describe, expect, it, vi } from 'vitest';
import {
  LAB_ADMISSION_LANE_KEY,
  LAB_ADMISSION_RETRY_AFTER_SECONDS,
  checkLabAdmission,
  type LabAdmissionBinding,
  admitLabRequest,
} from '../worker/lab-admission';

const privateCanary = 'private-binding-details-must-never-be-returned';

async function expectFailure(response: Response | null, status: 429 | 503) {
  expect(response).toBeInstanceOf(Response);
  if (!response) throw new Error('Expected admission rejection');
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Retry-After')).toBe(String(LAB_ADMISSION_RETRY_AFTER_SECONDS));
  expect(response.headers.get('Content-Type')).toContain('application/json');
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Expected an admission JSON object');
  expect(Object.keys(body).sort()).toEqual(['code', 'error', 'retryAfterSeconds']);
  expect(body).toEqual({
    code: status === 429 ? 'lab-admission-limited' : 'lab-admission-unavailable',
    error:
      status === 429
        ? 'Lab admission limit reached. Wait before trying again.'
        : 'Lab admission is temporarily unavailable. Wait before trying again.',
    retryAfterSeconds: 60,
  });
  expect(JSON.stringify(body)).not.toContain(privateCanary);
  for (const key of ['state', 'outcome', 'requestId', 'payload', 'retryAtUTC'])
    expect(body).not.toHaveProperty(key);
}

describe('gateway admission response contract', () => {
  it('calls the native-shaped binding once with the static aggregate lane and preserves this', async () => {
    const calls: { key: string }[] = [];
    const binding: LabAdmissionBinding = {
      async limit(options) {
        expect(this).toBe(binding);
        calls.push(options);
        return { success: true };
      },
    };
    expect(await checkLabAdmission(binding)).toBeNull();
    expect(calls).toEqual([{ key: LAB_ADMISSION_LANE_KEY }]);
    expect(Object.keys(calls[0])).toEqual(['key']);
  });

  it('repeated and concurrent calls share one key and never invent UUID/IP buckets', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const results = await Promise.all(
      Array.from({ length: 24 }, () => checkLabAdmission({ limit })),
    );
    expect(results.every((value) => value === null)).toBe(true);
    expect(limit).toHaveBeenCalledTimes(24);
    expect(limit.mock.calls).toEqual(
      Array.from({ length: 24 }, () => [{ key: LAB_ADMISSION_LANE_KEY }]),
    );
  });

  it('awaits the actual binding decision rather than allowing early dispatch', async () => {
    let resolve!: (value: unknown) => void;
    let finished = false;
    const decision = checkLabAdmission({ limit: () => new Promise((done) => (resolve = done)) });
    void decision.then(() => (finished = true));
    await Promise.resolve();
    expect(finished).toBe(false);
    resolve({ success: false });
    await expectFailure(await decision, 429);
  });

  it('returns a sanitized 429 without Lab evidence or untrusted result fields', async () => {
    const limit = vi.fn(async () => ({
      success: false,
      detail: privateCanary,
      requestId: privateCanary,
    }));
    await expectFailure(await checkLabAdmission({ limit }), 429);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the optional feature is invoked with a missing or malformed binding', async () => {
    for (const binding of [
      undefined,
      null,
      false,
      0,
      'binding',
      {},
      [],
      { limit: null },
      { limit: 1 },
    ])
      await expectFailure(await checkLabAdmission(binding), 503);
  });

  it('requires an own literal boolean success rather than truthy, empty or inherited evidence', async () => {
    const malformed = [
      undefined,
      null,
      true,
      false,
      '',
      [],
      { success: undefined },
      {},
      { success: 'true' },
      { success: 'false' },
      { success: 1 },
      { success: 0 },
      Object.create({ success: true }),
      Object.assign([], { success: true }),
    ];
    for (const value of malformed) {
      const limit = vi.fn(async () => value);
      await expectFailure(await checkLabAdmission({ limit }), 503);
      expect(limit).toHaveBeenCalledTimes(1);
    }
  });

  it('sanitizes sync throw, rejected promise and throwing binding/result getters without retry', async () => {
    for (const limit of [
      vi.fn(() => {
        throw new Error(privateCanary);
      }),
      vi.fn(async () => {
        throw new Error(privateCanary);
      }),
    ]) {
      await expectFailure(await checkLabAdmission({ limit }), 503);
      expect(limit).toHaveBeenCalledTimes(1);
    }
    await expectFailure(
      await checkLabAdmission({
        get limit() {
          throw new Error(privateCanary);
        },
      }),
      503,
    );
    await expectFailure(
      await checkLabAdmission({
        limit: async () => ({
          get success() {
            throw new Error(privateCanary);
          },
        }),
      }),
      503,
    );
  });

  it('reads success once and ignores private getters/fields rather than serializing provider data', async () => {
    let reads = 0;
    const result = {
      get success() {
        reads++;
        return true;
      },
      get detail() {
        throw new Error(privateCanary);
      },
    };
    expect(await checkLabAdmission({ limit: async () => result })).toBeNull();
    expect(reads).toBe(1);
  });

  it('returns fresh independent error Responses so body consumption cannot affect later decisions', async () => {
    const binding = { limit: vi.fn(async () => ({ success: false })) };
    const first = await checkLabAdmission(binding);
    const second = await checkLabAdmission(binding);
    expect(first).not.toBe(second);
    await expectFailure(first, 429);
    await expectFailure(second, 429);
    expect(binding.limit).toHaveBeenCalledTimes(2);
  });
});

describe('deployment admission switch and independent lanes', () => {
  it('bypasses only unset or exact false without touching either provider', async () => {
    const config = {
      get LAB_OWNER_LIMITER(): unknown {
        throw new Error(privateCanary);
      },
      get LAB_OBSERVER_LIMITER(): unknown {
        throw new Error(privateCanary);
      },
    };
    for (const LAB_ADMISSION_ENABLED of [undefined, 'false'])
      for (const lane of ['owner', 'observer'] as const)
        expect(
          await admitLabRequest(
            Object.create(config, { LAB_ADMISSION_ENABLED: { value: LAB_ADMISSION_ENABLED } }),
            lane,
          ),
        ).toBeNull();
  });
  it('routes each eligible call to its selected native binding exactly once', async () => {
    const owner = vi.fn(async () => ({ success: false }));
    const observer = vi.fn(async () => ({ success: true }));
    const config = {
      LAB_ADMISSION_ENABLED: 'true',
      LAB_OWNER_LIMITER: { limit: owner },
      LAB_OBSERVER_LIMITER: { limit: observer },
    };
    await expectFailure(await admitLabRequest(config, 'owner'), 429);
    expect(observer).not.toHaveBeenCalled();
    expect(await admitLabRequest(config, 'observer')).toBeNull();
    expect(owner).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(owner.mock.calls).toEqual([[{ key: LAB_ADMISSION_LANE_KEY }]]);
    expect(observer.mock.calls).toEqual([[{ key: LAB_ADMISSION_LANE_KEY }]]);
  });
  it('fails closed for invalid switches or selected binding without touching other lanes', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    for (const LAB_ADMISSION_ENABLED of ['', 'TRUE', 'true ', '0']) {
      await expectFailure(
        await admitLabRequest(
          { LAB_ADMISSION_ENABLED, LAB_OWNER_LIMITER: { limit }, LAB_OBSERVER_LIMITER: { limit } },
          'owner',
        ),
        503,
      );
    }
    expect(limit).not.toHaveBeenCalled();
    await expectFailure(
      await admitLabRequest(
        { LAB_ADMISSION_ENABLED: 'true', LAB_OBSERVER_LIMITER: { limit } },
        'owner',
      ),
      503,
    );
    expect(limit).not.toHaveBeenCalled();
    await expectFailure(
      await admitLabRequest(
        {
          get LAB_ADMISSION_ENABLED(): string {
            throw new Error(privateCanary);
          },
        },
        'owner',
      ),
      503,
    );
  });
});
