import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const base = process.env.BASE_URL || 'http://localhost:8790';
const rounds = Number(process.env.ROUNDS || 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('ROUNDS must be 1–10');
const samples = [];
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
for (const concurrency of [1, 12, 24, 48]) {
  for (let round = 0; round < rounds; round++) {
    const id = randomUUID();
    const headers = { 'X-Lab-ID': id, 'Content-Type': 'application/json' };
    const call = async (path, body) =>
      fetch(`${base}/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    const configured = await call('config', {
      capacity: 12,
      refillPerSecond: 1,
      originLatencyMs: 250,
      originTimeoutMs: 1000,
    });
    assert.equal(configured.status, 200);
    await configured.arrayBuffer();
    const start = performance.now();
    const requests = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const before = performance.now();
        const r = await call('request', {});
        const body = await r.json();
        return { status: r.status, elapsedMs: performance.now() - before, outcome: body.outcome };
      }),
    );
    const elapsed = performance.now() - start;
    const state = await (await call('state')).json();
    const accepted = requests.filter((r) => r.status === 200).length;
    const limited = requests.filter((r) => r.status === 429).length;
    assert.equal(accepted + limited, concurrency, 'Unexpected gateway failure');
    assert.equal(state.state.total, concurrency, 'A completion was lost');
    assert(
      accepted <= 12 + Math.floor(elapsed / 1000),
      'Admission exceeded capacity plus maximum elapsed refill',
    );
    const times = requests.map((r) => r.elapsedMs);
    samples.push({
      concurrency,
      round: round + 1,
      accepted,
      limited,
      wallMs: +elapsed.toFixed(2),
      clientP50Ms: +percentile(times, 0.5).toFixed(2),
      clientP95Ms: +percentile(times, 0.95).toFixed(2),
      originCalls: state.state.originCalls,
    });
  }
}
const report = {
  project: 'EdgeLab',
  version: 3,
  runAt: new Date().toISOString(),
  baseUrl: base,
  node: process.version,
  rounds,
  methodology:
    'Fresh isolated lab per trial. Capacity 12, refill 1/s, controlled private origin delay 250ms. Client elapsed includes network and body consumption. Concurrent burst test; not sustained throughput, production traffic, or multi-region performance. Assertions: no lost events, only expected status codes, accepted <= initial capacity + maximum elapsed refill.',
  samples,
};
await mkdir('docs/evidence', { recursive: true });
const file = base.includes('localhost')
  ? 'docs/evidence/benchmark-local.json'
  : 'docs/evidence/benchmark-live.json';
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.table(samples);
console.log(`Saved ${file}`);
