import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { collectBenchmarkSamples } from './benchmark-control.mjs';
const base = process.env.BASE_URL || 'http://localhost:8790';
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname);
const rounds = Number(process.env.ROUNDS || 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('ROUNDS must be 1–10');
// Collection rejects only after already-dispatched siblings settle. A failure
// never returns a partial sample set or reaches the successful artifact writer.
const samples = await collectBenchmarkSamples(rounds, () => {
  const id = randomUUID();
  const headers = { 'X-Lab-ID': id, 'Content-Type': 'application/json' };
  const call = async (path, body) =>
    fetch(`${base}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  return call;
});
const report = {
  project: 'EdgeLab',
  version: 3,
  runAt: new Date().toISOString(),
  baseUrl: base,
  node: process.version,
  rounds,
  methodology:
    'Fresh isolated lab per trial. Capacity 12, refill 1/s, healthy controlled private origin delay 250ms, stale fallback disabled. Client elapsed includes network and body consumption. Concurrent burst test; not sustained throughput, production traffic, or multi-region performance. Gateway admission refusal, malformed response or failed state confirmation aborts the entire report after dispatched siblings settle, without replay. Every engine status/outcome/request ID and response header must agree; only origin 200 and engine limited 429 are expected. Source counters and history must reconcile exactly. Accepted <= initial capacity + maximum elapsed refill. Gateway limiter overhead is not measured.',
  samples,
};
await mkdir('docs/evidence', { recursive: true });
const file = isLocal ? 'docs/evidence/benchmark-local.json' : 'docs/evidence/benchmark-live.json';
// A failed write must not truncate an older successful report or publish a
// partially written success artifact. Temporary output is removed on failure.
const temporary = `${file}.${randomUUID()}.tmp`;
try {
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n');
  await rename(temporary, file);
} finally {
  await rm(temporary, { force: true });
}
console.table(samples);
console.log(`Saved ${file}`);
