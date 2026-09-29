import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.BASE_URL || 'http://localhost:8787';
const id = randomUUID();
async function call(path, body, session = id, extra = {}) {
  const response = await fetch(`${base}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'X-Lab-ID': session, 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
await call('reset', {});
assert.equal((await call('state')).data.state.total, 0);
const warm = await call('request', {});
assert.equal(warm.status, 200);
assert.equal(warm.data.payload.service, 'demo-catalog');
assert.equal(warm.headers.get('X-Request-ID'), warm.data.requestId);
await call('config', { originMode: 'failing' });
for (let i = 0; i < 3; i++) {
  const cached = await call('request', {});
  assert.equal(cached.data.outcome, 'stale');
  assert.deepEqual(cached.data.payload, warm.data.payload);
  assert.ok(cached.data.cacheAgeMs >= 0);
  assert.equal(cached.headers.get('X-Response-Source'), 'stale');
}
assert.equal((await call('state')).data.state.circuit, 'open');
assert.equal((await call('request', {})).data.outcome, 'stale');
await call('config', { staleFallback: false });
const blocked = await call('request', {});
assert.equal(blocked.status, 503);
assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
await call('config', { originMode: 'healthy' });
await new Promise((resolve) => setTimeout(resolve, 4100));
assert.equal((await call('request', {})).status, 200);
assert.equal((await call('state')).data.state.circuit, 'closed');
console.log('PASS service-bound origin → exact cached payload → blocked → recovery');
const fresh = (await call('request', {})).data.payload;
assert.notEqual(fresh.revision, warm.data.payload.revision);
await call('reset', {});
await call('config', { originLatencyMs: 500, originTimeoutMs: 100, staleFallback: false });
const timeout = await call('request', {});
assert.equal(timeout.status, 504);
assert.equal((await call('state')).data.state.failures, 1);
console.log('PASS real origin timeout becomes HTTP 504 and a circuit failure');
await call('reset', {});
await call('config', { refillPerSecond: 1 });
const started = Date.now();
const results = await Promise.all(Array.from({ length: 24 }, () => call('request', {})));
const admitted = results.filter((r) => r.status === 200).length;
assert.ok(admitted >= 12 && admitted <= 12 + Math.floor((Date.now() - started) / 1000));
assert.ok(results.some((r) => r.status === 429));
const snap = (await call('state')).data;
assert.equal(snap.state.total, 24);
assert.equal(snap.events.length, 24);
assert.equal(new Set(snap.events.map((e) => e.requestId)).size, 24);
assert.equal(snap.events.filter((e) => e.originAttempted).length, admitted);
assert.ok(snap.expiresAt > snap.now && snap.expiresAt <= snap.now + 86400000);
assert.equal(snap.state.originCalls, admitted);
assert.equal((await call('state', undefined, randomUUID())).data.state.total, 0);
console.log(
  `PASS 24 concurrent requests: ${admitted} admitted, ${24 - admitted} limited; separate session isolated`,
);
assert.equal((await call('config', { capacity: -1 })).status, 400);
assert.equal((await call('state', {})).status, 405);
assert.equal((await call('request')).status, 405);
assert.equal((await call('config', { originMode: ['healthy'] })).status, 400);
assert.equal((await call('state', undefined, 'invalid')).status, 400);
assert.equal((await call('request', {}, id, { Origin: 'https://untrusted.example' })).status, 403);
assert.equal((await call('config', { value: 'x'.repeat(5000) })).status, 413);
console.log(
  'PASS invalid configuration, missing capability, cross-origin and oversized payload rejected',
);
await call('reset', {});
await call('config', { originLatencyMs: 1000 });
const pending = call('request', {});
// Observe admission, so this test does not depend on an arbitrary scheduling delay.
const admissionDeadline = Date.now() + 5000;
while ((await call('state')).data.state.total === 0) {
  assert.ok(Date.now() < admissionDeadline, 'Request admission timed out');
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await call('reset', {});
assert.equal((await pending).status, 409);
assert.equal((await call('state')).data.state.total, 0);
console.log('PASS reset fences actual in-flight origin completion');
// Exercise event retention with a replenishing bucket and a burst of rejected requests.
await Promise.all(Array.from({ length: 190 }, () => call('request', {})));
assert.equal((await call('state')).data.events.length, 180);
await call('reset', {});
console.log('PASS SQLite event history bounded to 180 rows');
console.log('All integration checks passed against ' + base);
