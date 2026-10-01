import { performance } from 'node:perf_hooks';

const outcomes = ['origin', 'stale', 'limited', 'blocked', 'error'];
const statuses = { origin: [200], stale: [200], limited: [429], blocked: [503], error: [502, 504] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (message) => {
  throw new Error(
    `Benchmark stopped: ${message}. No completed benchmark report is produced; earlier or concurrent writes may have completed. Requests are not replayed.`,
  );
};

/** Plain Node counterpart to the UI failure boundary; no TS/runtime bundling needed. */
export async function readBenchmarkResponse(response, path) {
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`invalid JSON from the ${path} route`);
  }
  if (!object(body)) fail(`invalid response from the ${path} route`);
  // Codes take precedence even if a malformed response includes an engine-looking outcome.
  if (body.code === 'lab-admission-limited' || body.code === 'lab-admission-unavailable') {
    const expected = body.code === 'lab-admission-limited' ? 429 : 503;
    const confirmed =
      response.status === expected &&
      typeof body.error === 'string' &&
      body.error.length > 0 &&
      body.retryAfterSeconds === 60 &&
      Object.keys(body).sort().join(',') === 'code,error,retryAfterSeconds';
    fail(
      confirmed
        ? `gateway admission refused the ${path} call before reaching the Lab; its fixed 60-second backoff is advice, not an admission guarantee`
        : `unconfirmed gateway admission response from the ${path} route`,
    );
  }
  if (path === 'config') {
    if (response.status !== 200 || body.ok !== true) fail('configuration was not confirmed');
    return { ok: true };
  }
  if (path === 'request') {
    if (
      typeof body.outcome !== 'string' ||
      !Object.hasOwn(statuses, body.outcome) ||
      body.status !== response.status ||
      !statuses[body.outcome].includes(response.status) ||
      typeof body.requestId !== 'string' ||
      !uuid.test(body.requestId)
    )
      fail('response is not a valid engine outcome/status/request-ID combination');
    if (
      response.headers.get('X-Request-ID') !== body.requestId ||
      response.headers.get('X-Response-Source') !== body.outcome
    )
      fail('engine response headers do not agree with its decision');
    return { status: body.status, outcome: body.outcome, requestId: body.requestId };
  }
  if (path === 'state') {
    const state = body.state;
    if (
      response.status !== 200 ||
      !object(state) ||
      !object(state.counts) ||
      !Array.isArray(body.events) ||
      !integer(state.total) ||
      !integer(state.originCalls) ||
      state.originCalls > state.total ||
      !outcomes.every((outcome) => integer(state.counts[outcome]))
    )
      fail('state counters were not confirmed');
    const counts = Object.fromEntries(outcomes.map((outcome) => [outcome, state.counts[outcome]]));
    const settled = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(settled) || settled !== state.total)
      fail('state decisions have not fully settled');
    const events = body.events.map((event) => {
      if (
        !object(event) ||
        typeof event.outcome !== 'string' ||
        !Object.hasOwn(statuses, event.outcome) ||
        !statuses[event.outcome].includes(event.status) ||
        typeof event.requestId !== 'string' ||
        !uuid.test(event.requestId)
      )
        fail('stored history contains an unconfirmed decision');
      return { status: event.status, outcome: event.outcome, requestId: event.requestId };
    });
    return { total: state.total, originCalls: state.originCalls, counts, events };
  }
  fail('unsupported response route');
}

/** Wait for all already-dispatched requests and body parsing before surfacing failure. */
export async function settleBenchmarkRequests(tasks) {
  let failed = false;
  let firstFailure;
  const observed = tasks.map((task) =>
    Promise.resolve(task).catch((error) => {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
      throw error;
    }),
  );
  const results = await Promise.allSettled(observed);
  if (failed) throw firstFailure;
  return results.map((result) => result.value);
}

const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];

/** A sample exists only after every request and the authoritative state read agree. */
export async function measureBenchmarkTrial(call, concurrency, now = () => performance.now()) {
  await readBenchmarkResponse(
    await call('config', {
      capacity: 12,
      refillPerSecond: 1,
      originLatencyMs: 250,
      originTimeoutMs: 1000,
      originMode: 'healthy',
      staleFallback: false,
    }),
    'config',
  );
  const start = now();
  const requests = await settleBenchmarkRequests(
    Array.from({ length: concurrency }, async () => {
      const before = now();
      const decision = await readBenchmarkResponse(await call('request', {}), 'request');
      if (decision.outcome !== 'origin' && decision.outcome !== 'limited')
        fail('controlled healthy trial received an unexpected engine decision');
      const elapsedMs = now() - before;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) fail('invalid client elapsed time');
      return { ...decision, elapsedMs };
    }),
  );
  const elapsed = now() - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) fail('invalid trial elapsed time');
  const state = await readBenchmarkResponse(await call('state'), 'state');
  const accepted = requests.filter((request) => request.outcome === 'origin').length;
  const limited = requests.filter((request) => request.outcome === 'limited').length;
  if (
    accepted + limited !== concurrency ||
    state.total !== concurrency ||
    state.originCalls !== accepted ||
    state.counts.origin !== accepted ||
    state.counts.limited !== limited ||
    state.counts.stale !== 0 ||
    state.counts.blocked !== 0 ||
    state.counts.error !== 0
  )
    fail('stored counters do not reconcile with the completed trial');
  if (accepted > 12 + Math.floor(elapsed / 1000))
    fail('engine admission exceeded capacity plus maximum elapsed refill');
  const decisions = new Map(requests.map((request) => [request.requestId, request]));
  const history = new Set(state.events.map((event) => event.requestId));
  if (
    decisions.size !== concurrency ||
    history.size !== concurrency ||
    state.events.length !== concurrency ||
    !state.events.every((event) => {
      const decision = decisions.get(event.requestId);
      return decision && decision.status === event.status && decision.outcome === event.outcome;
    })
  )
    fail('stored history does not match every completed request exactly once');
  const times = requests.map((request) => request.elapsedMs);
  return {
    accepted,
    limited,
    wallMs: +elapsed.toFixed(2),
    clientP50Ms: +percentile(times, 0.5).toFixed(2),
    clientP95Ms: +percentile(times, 0.95).toFixed(2),
    originCalls: state.originCalls,
  };
}

/** No partial collection is returned if any trial fails; there is no retry loop. */
export async function collectBenchmarkSamples(rounds, createCall) {
  const samples = [];
  for (const concurrency of [1, 12, 24, 48])
    for (let round = 0; round < rounds; round++) {
      const sample = await measureBenchmarkTrial(createCall(), concurrency);
      samples.push({ concurrency, round: round + 1, ...sample });
    }
  return samples;
}
