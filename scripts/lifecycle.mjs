import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: 'output/worker/index.js',
        compatibilityDate: '2026-09-01',
        serviceBindings: { ORIGIN: 'origin' },
        durableObjects: { LABS: { className: 'ReliabilityLab', useSQLite: true } },
        bindings: { LAB_IDLE_TTL_MS: '800' },
      },
      {
        name: 'origin',
        modules: true,
        scriptPath: 'output/origin/origin.js',
        compatibilityDate: '2026-09-01',
      },
    ],
  }),
);
const id = randomUUID();
async function call(path, body) {
  const response = await mf.dispatchFetch(`https://example.com/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Lab-ID': id, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
try {
  await call('config', { originLatencyMs: 20 });
  const request = await call('request', {});
  assert.equal(request.status, 200);
  const before = (await call('state')).data;
  await mf.unsafeEvictDurableObject('gateway', 'ReliabilityLab', { name: id });
  const restored = (await call('state')).data;
  assert.equal(restored.state.runId, before.state.runId);
  assert.deepEqual(restored.state.cachedPayload, request.data.payload);
  assert.equal(restored.events[0].requestId, request.data.requestId);
  console.log('PASS SQLite state, real cached payload, and history survive object eviction');
  for (let i = 0; i < 4; i++) {
    await sleep(300);
    assert.equal((await call('state')).data.state.runId, before.state.runId);
  }
  console.log('PASS activity renews the idle deadline beyond the original alarm');
  await sleep(1500);
  const expired = (await call('state')).data;
  assert.equal(expired.state.total, 0);
  assert.equal(expired.events.length, 0);
  assert.notEqual(expired.state.runId, before.state.runId);
  console.log('PASS real alarm deletes idle state and next request recreates a clean schema');
  await call('config', { originLatencyMs: 2000, originTimeoutMs: 3000 });
  const inFlight = call('request', {});
  assert.equal((await inFlight).status, 409);
  assert.equal((await call('state')).data.state.total, 0);
  console.log('PASS late origin result cannot resurrect an expired lab');
} finally {
  await mf.dispose();
}
