import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.BASE_URL;
if (!base?.startsWith('https://')) throw new Error('Set BASE_URL to your deployed HTTPS gateway');
const checks = [];
const read = async (path) => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  assert(response.headers.get('Content-Type')?.includes('application/json'), path);
  return { response, data: await response.json() };
};
const health = await read('/api/health');
assert.equal(health.response.status, 200);
assert.equal(health.data.version, '3.3.1');
for (const path of ['/api/ready', '/api/ops/status', '/api/ops/export']) {
  const { response, data } = await read(path);
  assert.equal(response.status, 503, path);
  assert.equal(data.code, 'monitor-storage-unavailable', path);
  assert.equal(data.reason, 'daily-read-limit', path);
  assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', path);
  assert.equal(response.headers.get('Retry-After'), '60', path);
  assert.equal(response.headers.get('Content-Disposition'), null, path);
  const date = Date.parse(response.headers.get('Date'));
  assert(Number.isFinite(date), path);
  assert.equal(
    data.retryAtUTC,
    new Date((Math.floor(date / 86400000) + 1) * 86400000).toISOString(),
    path,
  );
  assert(!('services' in data) && !('monitoring' in data), path);
  checks.push({ path, status: response.status, response: data });
}
for (const path of [
  '/api/ops/audit',
  '/api/ops/incident-briefs/00000000-0000-4000-8000-000000000000',
]) {
  const { response, data } = await read(path);
  assert.equal(response.status, 401);
  assert.equal(data.error, 'Operator token required');
  checks.push({ path, status: response.status });
}
await mkdir('docs/evidence/releases', { recursive: true });
await writeFile(
  'docs/evidence/releases/3.3.1-storage-boundary.json',
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      baseUrl: base,
      health: health.data,
      verification:
        'Deployed sanitized storage-unavailable responses and auth precedence verified. This is a quota-failure boundary check, not successful autonomous monitoring recovery.',
      autonomousRecovery: 'pending daily quota reset and new observed minutes',
      productionInferenceCalls: 0,
      historySeeded: false,
      checks,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'PASS live gateway version, storage 503 responses and auth precedence. Autonomous recovery remains pending.',
);
