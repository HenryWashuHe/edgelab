import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const token = 'monitor-storage-fixture-token-not-a-production-credential';
await build({
  entryPoints: ['tests/fixtures/monitor-unavailable.ts'],
  outfile: 'output/monitor-unavailable-fixture.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['cloudflare:workers'],
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'gateway',
        modules: true,
        scriptPath: 'output/monitor-unavailable-fixture.mjs',
        compatibilityDate: '2026-09-01',
        bindings: { OPERATOR_TOKEN: token },
      },
    ],
  }),
);
const base = 'https://edgelab.example';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
try {
  assert.equal((await mf.dispatchFetch(base + '/api/health')).status, 200);
  for (const path of ['/api/ops/status', '/api/ready', '/api/ops/export']) {
    const response = await mf.dispatchFetch(base + path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('Content-Disposition'), null);
    const body = await response.json();
    assert.equal(body.code, 'monitor-storage-unavailable');
    assert.equal(body.reason, 'daily-read-limit');
    assert.equal(
      body.retryAtUTC,
      new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000).toISOString(),
    );
    assert(!JSON.stringify(body).includes(token));
    assert(!('services' in body));
    assert(!('monitoring' in body));
  }
  // Authentication, method and body validation must precede the shared cooldown.
  assert.equal((await mf.dispatchFetch(base + '/api/ops/audit')).status, 401);
  assert.equal((await mf.dispatchFetch(base + '/api/ops/status', { method: 'POST' })).status, 405);
  assert.equal(
    (
      await mf.dispatchFetch(base + '/api/ops/status', {
        headers: { Origin: 'https://untrusted.invalid' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await mf.dispatchFetch(base + '/api/ops/incident-brief', {
        method: 'POST',
        headers,
        body: '{',
      })
    ).status,
    400,
  );
  const mutation = await mf.dispatchFetch(base + '/api/ops/incident-brief', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      incident: '00000000-0000-4000-8000-000000000000',
      requestId: '00000000-0000-4000-8000-000000000001',
    }),
  });
  assert.equal(mutation.status, 503);
  assert.equal((await mutation.json()).code, 'monitor-storage-unavailable');
  const state = await (await mf.dispatchFetch(base + '/__fixture/state')).json();
  assert.equal(state.calls, 1);
  console.log(
    'PASS actual Worker quota failure boundary, liveness/readiness split, export failure, auth precedence and cooldown',
  );
} finally {
  await mf.dispose();
}
