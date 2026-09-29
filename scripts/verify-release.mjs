import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = process.env.BASE_URL;
if (!base?.startsWith('https://')) throw new Error('Set BASE_URL to your deployed HTTPS gateway');
const token = (await readFile('.env.operator', 'utf8')).match(/^OPERATOR_TOKEN=(.+)$/m)?.[1];
const get = async (path, headers = {}) => {
  const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
  return { response: r, data: await r.json() };
};
const health = await get('/api/health');
assert.equal(health.data.version, '3.0.0');
assert.equal((await get('/api/ops/audit')).response.status, 401);
assert.equal(
  (await get('/api/ops/audit', { Authorization: `Bearer ${token}` })).response.status,
  200,
);
assert.equal(
  (await get('/api/ops/status', { Origin: 'https://untrusted.invalid' })).response.status,
  403,
);
console.log('PASS live version, public read boundary, and authenticated operator access');
const started = Date.now();
let previous = '';
while (Date.now() - started < 16 * 60_000) {
  const { response, data } = await get('/api/ops/status');
  assert.equal(response.status, 200);
  assert.equal(data.services.length, 2);
  assert(!JSON.stringify(data).includes(token));
  assert(!JSON.stringify(data).includes('origin.internal'));
  assert(!JSON.stringify(data).includes('"note"'));
  const observed = data.services.map((s) => ({
    id: s.id,
    latestSlot: s.latest?.slot ?? null,
    outcome: s.latest?.outcome ?? null,
    uniqueRecentSlots: [
      ...new Set(
        s.history.filter((c) => c.at >= started && c.outcome === 'good').map((c) => c.slot),
      ),
    ],
  }));
  const progress = JSON.stringify(observed);
  if (progress !== previous) {
    console.log(progress);
    previous = progress;
  }
  if (observed.every((s) => s.uniqueRecentSlots.length >= 2)) {
    await mkdir('docs/evidence', { recursive: true });
    await writeFile(
      'docs/evidence/live-monitoring.json',
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          startedAt: new Date(started).toISOString(),
          baseUrl: base,
          verification:
            'Two distinct new good scheduled minutes for each service after verification began. No manual tick endpoint was invoked. Operator audit authentication and public privacy boundaries checked.',
          health: health.data,
          snapshot: data,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS autonomous scheduled monitoring: both services produced two new good minutes. Evidence saved.',
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
throw new Error(
  'Cron failed to produce two new good minutes within propagation window; release not verified',
);
