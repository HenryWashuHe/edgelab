import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import NetworkWebSocket from 'ws';

// Real local production classes and origin, ephemeral storage, one network peer.
// The fixture supplies read-only constructor/attachment inspection. Its source,
// deadline and fault controls are never used; no account or native AI is called.
if (process.argv.length !== 2) throw new Error('This local recording recipe accepts no arguments.');

const PRODUCER_VERSION = '3.12.4';
const COMPATIBILITY_DATE = '2026-09-01';
const outputDirectory = 'output/lab-recording';
const outputArtifact = 'output/lab-recording-example.json';
const outputManifest = 'output/recording-source-manifest.json';
const bundles = {
  gateway: `${outputDirectory}/gateway.js`,
  origin: `${outputDirectory}/origin.js`,
  recording: `${outputDirectory}/recording.mjs`,
};
const projectRoot = resolve('.');
const pinnedSources = new Map();
const buildInputs = {};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function projectPath(path) {
  const key = relative(projectRoot, resolve(path)).replaceAll('\\', '/');
  assert(key && !key.startsWith('../') && !key.includes(':'), 'Unexpected project input path');
  return key;
}
async function pinSource(path) {
  const key = projectPath(path);
  const bytes = await readFile(resolve(projectRoot, key));
  const hash = sha256(bytes);
  if (pinnedSources.has(key))
    assert.equal(hash, pinnedSources.get(key), 'Source changed during build');
  pinnedSources.set(key, hash);
  return bytes;
}
function sourceHashes() {
  return Object.fromEntries([...pinnedSources].sort(([a], [b]) => a.localeCompare(b)));
}
async function buildPinned(name, options) {
  const suppliedInputs = new Set();
  const result = await build({
    absWorkingDir: projectRoot,
    ...options,
    metafile: true,
    plugins: [
      {
        name: 'pin-recording-project-inputs',
        setup(builder) {
          builder.onLoad({ filter: /./ }, async (args) => {
            const key = projectPath(args.path);
            const loader = { '.ts': 'ts', '.mjs': 'js' }[extname(key)];
            assert.equal(args.namespace, 'file', 'Unexpected project input namespace');
            assert(/^(src|worker|tests\/fixtures)\//.test(key), 'Unexpected project input path');
            assert(loader, 'Unexpected project input loader');
            const bytes = await pinSource(args.path);
            suppliedInputs.add(key);
            return { contents: bytes, loader, resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  const graphInputs = Object.keys(result.metafile.inputs).map(projectPath).sort();
  assert.deepEqual(
    graphInputs,
    [...suppliedInputs].sort(),
    'All build inputs have exact source pins',
  );
  buildInputs[name] = graphInputs;
}
async function verifySourceHashes() {
  await Promise.all(
    [...pinnedSources].map(async ([path, hash]) =>
      assert.equal(
        sha256(await readFile(resolve(projectRoot, path))),
        hash,
        'Recipe source remains stable during capture',
      ),
    ),
  );
}
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const sum = (counts) => Object.values(counts).reduce((total, count) => total + count, 0);

await mkdir(outputDirectory, { recursive: true });
for (const path of [
  'scripts/lab-recording.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
])
  await pinSource(path);
await buildPinned('gateway', {
  entryPoints: ['tests/fixtures/lab-observer.ts'],
  outfile: bundles.gateway,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
await buildPinned('origin', {
  entryPoints: ['worker/origin.ts'],
  outfile: bundles.origin,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
});
await buildPinned('codec', {
  entryPoints: ['src/lab-recording.ts', 'worker/lab-observer.ts'],
  outdir: `${outputDirectory}/codec`,
  outbase: '.',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'esnext',
});
const beforeSourceHashes = sourceHashes();
bundles.recording = `${outputDirectory}/codec/src/lab-recording.mjs`;
bundles.protocol = `${outputDirectory}/codec/worker/lab-observer.mjs`;
const {
  beginLabRecording,
  appendLabRecording,
  finalizeLabRecording,
  exportLabRecording,
  importLabRecording,
  MAX_LAB_RECORDING_ENTRIES,
  MAX_LAB_RECORDING_BYTES,
  LAB_RECORDING_FINALIZATION_HEADROOM,
} = await import(pathToFileURL(resolve(bundles.recording)).href);
const { LAB_OBSERVER_PROTOCOL, LAB_OBSERVER_CAPABILITY_PREFIX, MAX_LAB_OBSERVER_FRAME_BYTES } =
  await import(pathToFileURL(resolve(bundles.protocol)).href);
const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
assert.equal(packageVersion, PRODUCER_VERSION, 'Recorder version matches the project release');
const capability = randomUUID();
const assertions = [];
const errors = [];
const closes = [];
let recording = null;
let peer = null;
let mf = null;
let step = 'initialization';
const inFlight = new Set();
const sanitized = (value) => String(value).split(capability).join('[omitted capability]');
const proof = (message) => assertions.push(message);
const frames = () => recording?.entries.map((entry) => entry.frame) ?? [];
const dataFrames = () => frames().filter((frame) => 'state' in frame);
const latest = () => dataFrames().at(-1);
async function waitFor(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (errors.length) throw new Error(errors[0]);
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out: ' + label);
}

try {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      // Miniflare otherwise may refresh its optional Request.cf metadata remotely.
      cf: false,
      telemetry: { enabled: false },
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: bundles.gateway,
          compatibilityDate: COMPATIBILITY_DATE,
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: { AI_BRIEFS_ENABLED: 'false' },
          serviceBindings: {
            ORIGIN: 'origin',
            ASSETS: async () => new Response('Recording fixture assets', { status: 404 }),
          },
        },
        {
          name: 'origin',
          modules: true,
          scriptPath: bundles.origin,
          compatibilityDate: COMPATIBILITY_DATE,
        },
      ],
    }),
  );
  const ready = await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('LABS', 'gateway');
  const lab = namespace.get(namespace.idFromName(capability));
  const inspect = async () => {
    const response = await lab.fetch('https://lab.internal/__fixture/inspect');
    assert.equal(response.status, 200);
    return response.json();
  };
  const stateOf = (inspection) => JSON.parse(inspection.state[0].value);
  const call = (action, body) => {
    const request = mf
      .dispatchFetch(new URL(`/api/${action}`, ready), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Lab-ID': capability, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      .then(async (response) => ({ status: response.status, data: await response.json() }));
    inFlight.add(request);
    request.then(
      () => inFlight.delete(request),
      () => inFlight.delete(request),
    );
    return request;
  };
  const settledAt = async (revision) => {
    await waitFor(() => latest()?.revision === revision, 'network peer reaches stored revision');
  };
  const callOK = async (action, body) => {
    const result = await call(action, body);
    assert.equal(result.status, 200, 'Successful owner control: ' + action);
    const inspection = await inspect();
    await settledAt(stateOf(inspection).revision);
    return result;
  };

  step = 'initial snapshot';
  assert.equal((await call('state')).status, 200);
  const health = await mf.dispatchFetch(new URL('/api/health', ready));
  assert.equal(health.status, 200);
  const observedGatewayVersion = (await health.json()).version;
  assert.equal(
    observedGatewayVersion,
    packageVersion,
    'Actual gateway reports the project release',
  );
  proof('Project, recorder and actual gateway health versions agree.');
  const url = new URL('/api/observe', ready);
  url.protocol = ready.protocol === 'https:' ? 'wss:' : 'ws:';
  peer = new NetworkWebSocket(
    url,
    [LAB_OBSERVER_PROTOCOL, LAB_OBSERVER_CAPABILITY_PREFIX + capability],
    { origin: ready.origin, closeTimeout: 500 },
  );
  peer.on('message', (bytes, binary) => {
    try {
      assert.equal(binary, false);
      const text = bytes.toString('utf8');
      assert(Buffer.byteLength(text, 'utf8') <= MAX_LAB_OBSERVER_FRAME_BYTES);
      recording = recording
        ? appendLabRecording(recording, text, Date.now())
        : beginLabRecording(text, Date.now(), PRODUCER_VERSION);
      assert(recording.entries.length <= MAX_LAB_RECORDING_ENTRIES, 'Bounded recipe capture queue');
      assert.equal(recording.end, null, 'Recipe must remain within codec limits');
    } catch (error) {
      errors.push(sanitized(error.message));
    }
  });
  peer.on('error', (error) => errors.push(sanitized(error.message)));
  peer.on('close', (code) => closes.push(code));
  await new Promise((done, reject) => {
    peer.once('open', done);
    peer.once('error', reject);
    peer.once('unexpected-response', (_, response) =>
      reject(new Error('Unexpected network handshake status: ' + response.statusCode)),
    );
  });
  assert.equal(peer.protocol, LAB_OBSERVER_PROTOCOL);
  await waitFor(() => recording?.entries.length === 1, 'actual initial snapshot');
  assert.equal(latest().kind, 'snapshot');
  assert.equal(latest().state.total, 0);
  proof('One actual network socket starts with the existing production run snapshot.');

  step = 'overlapping real origin requests';
  await callOK('config', {
    capacity: 6,
    refillPerSecond: 20,
    originLatencyMs: 700,
    originTimeoutMs: 3000,
  });
  const pair = [call('request', {}), call('request', {})];
  await waitFor(
    () => dataFrames().some((frame) => frame.state.total - sum(frame.state.counts) === 2),
    'two real pending admissions',
  );
  const results = await Promise.all(pair);
  assert(results.every((result) => result.status === 200 && result.data.outcome === 'origin'));
  const settled = await inspect();
  await settledAt(stateOf(settled).revision);
  assert.equal(latest().state.total, 2);
  assert.equal(latest().state.counts.origin, 2);
  assert.equal(sum(latest().state.counts), 2);
  proof(
    'Two overlapping production-origin requests emit pending reservations and two settled successes.',
  );

  step = 'reset fences an actual in-flight request';
  await callOK('config', { originLatencyMs: 1800, originTimeoutMs: 4000 });
  const oldRun = latest().runId;
  const pending = call('request', {});
  await waitFor(
    () => latest()?.state.total - sum(latest().state.counts) === 1,
    'in-flight reset request',
  );
  await callOK('reset', {});
  const resetSource = await inspect();
  const resetFrame = latest();
  assert.notEqual(resetFrame.runId, oldRun);
  assert.equal(resetFrame.state.total, 0);
  assert.equal(resetFrame.events.length, 0);
  assert.equal((await pending).status, 409);
  const afterLate = await inspect();
  assert.deepEqual(afterLate.state, resetSource.state);
  assert.deepEqual(afterLate.events, resetSource.events);
  assert.equal(latest().revision, resetFrame.revision);
  proof(
    'Reset changes run identity; an actual late origin completion returns409 without a new-run event/update.',
  );

  step = 'original socket survives real hibernation';
  const beforeHibernation = await inspect();
  assert.equal(beforeHibernation.attachments.length, 1);
  await mf.unsafeEvictDurableObject('gateway', 'ReliabilityLab', {
    name: capability,
    webSockets: 'hibernate',
  });
  const afterHibernation = await inspect();
  assert.notEqual(afterHibernation.bootId, beforeHibernation.bootId);
  assert.deepEqual(afterHibernation.attachments, beforeHibernation.attachments);
  assert.deepEqual(afterHibernation.state, beforeHibernation.state);
  assert.equal(peer.readyState, NetworkWebSocket.OPEN);
  assert.equal(closes.length, 0);
  await callOK('config', {
    originMode: 'failing',
    originLatencyMs: 60,
    originTimeoutMs: 2000,
    failureThreshold: 1,
    cooldownMs: 1000,
    staleFallback: false,
  });
  assert.equal(latest().runId, resetFrame.runId);
  assert(latest().revision > resetFrame.revision);
  assert.equal(frames().filter((frame) => frame.kind === 'snapshot').length, 1);
  proof(
    'Forced hibernation restarts the real constructor and restores attachments; the original socket receives the next commit without reconnect.',
  );

  step = 'real failure and recovery';
  const failure = await call('request', {});
  assert.equal(failure.status, 502);
  assert.equal(failure.data.outcome, 'error');
  await settledAt(stateOf(await inspect()).revision);
  assert.equal(latest().state.circuit, 'open');
  assert.equal(latest().state.counts.error, 1);
  await callOK('config', { originMode: 'healthy' });
  // The controlled origin and circuit use actual timers; no clock or state is injected.
  await sleep(1100);
  const recovered = await call('request', {});
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.outcome, 'origin');
  await settledAt(stateOf(await inspect()).revision);
  assert.equal(latest().state.circuit, 'closed');
  assert.equal(latest().state.counts.error, 1);
  assert.equal(latest().state.counts.origin, 1);
  assert(dataFrames().some((frame) => frame.state.circuit === 'half-open'));
  proof('The actual origin failure opens the circuit; an actual timed recovery probe closes it.');

  step = 'export verified bounded recording';
  assert.deepEqual(errors, []);
  assert.equal(closes.length, 0);
  for (let index = 1; index < dataFrames().length; index++)
    assert(dataFrames()[index].revision > dataFrames()[index - 1].revision);
  recording = finalizeLabRecording(recording, 'stopped', Date.now());
  const { artifact, json } = await exportLabRecording(recording);
  assert.deepEqual(await importLabRecording(json), artifact);
  assert.equal(artifact.entries.length, frames().length);
  assert(!json.includes(capability), 'Capability must be omitted from the recording');
  for (const field of ['cachedPayload', 'payload', 'requestId', 'message', 'Authorization'])
    assert(!json.includes('"' + field + '"'), 'Private field in recording: ' + field);
  await verifySourceHashes();
  const manifest = {
    schemaVersion: 1,
    kind: 'edgelab-local-recording-source-manifest',
    recordedAt: new Date().toISOString(),
    recipe: 'node scripts/lab-recording.mjs',
    sourceProjectVersion: packageVersion,
    observedGatewayVersion,
    recordingProducerVersion: PRODUCER_VERSION,
    recording: {
      path: outputArtifact,
      bytes: Buffer.byteLength(json, 'utf8'),
      entries: artifact.entries.length,
      contentHash: artifact.contentHash,
      fileSHA256: sha256(json),
      end: artifact.end,
      limits: {
        entries: MAX_LAB_RECORDING_ENTRIES,
        bytes: MAX_LAB_RECORDING_BYTES,
        finalizationHeadroom: LAB_RECORDING_FINALIZATION_HEADROOM,
      },
    },
    runtime: {
      node: process.version,
      miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
      workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
      compatibilityDate: COMPATIBILITY_DATE,
      origin: 'Unchanged worker/origin.ts through an internal service binding',
      transport: 'One real ws network peer against Miniflare.ready',
      storage: 'Ephemeral actual workerd SQLite Durable Object',
      nativeInferenceCalls: 0,
      productionRequests: 0,
      accountCalls: 0,
      aiEnabled: false,
      remoteRequestCfRefresh: false,
      miniflareTelemetry: false,
    },
    sourceSHA256: beforeSourceHashes,
    buildInputs,
    bundleSHA256: Object.fromEntries(
      await Promise.all(
        Object.entries(bundles).map(async ([name, path]) => [name, sha256(await readFile(path))]),
      ),
    ),
    sourceStableDuringRun: true,
    assertions,
    limitations: [
      'A controlled local runtime trace, not a production incident, native AI result or customer traffic measurement.',
      'Receipt times and run/event identities are real and vary each run; the fixed recipe is reproducible, not byte-identical across executions.',
      'The production-exporting fixture adds read-only boot/attachment inspection and real storage instrumentation; no source seeding, deadline/clock manipulation or fault injection is used.',
      'Hibernation is forced with the supported Miniflare unsafeEvictDurableObject testing API; this does not establish natural production hibernation timing.',
      'The network peer uses a500ms close timeout. Recording capture stops before client cleanup; natural TCP teardown, billing and capacity are not measured.',
      'The content hash identifies changes to the bounded recording. It is unsigned and does not authenticate its producer or prove causality.',
    ],
  };
  const manifestJSON = JSON.stringify(manifest, null, 2) + '\n';
  assert(!manifestJSON.includes(capability), 'Capability must be omitted from the source manifest');
  await writeFile(outputArtifact, json);
  await writeFile(outputManifest, manifestJSON);
  console.log(
    JSON.stringify({
      recording: outputArtifact,
      manifest: outputManifest,
      entries: artifact.entries.length,
      bytes: Buffer.byteLength(json, 'utf8'),
      contentHash: artifact.contentHash,
    }),
  );
} catch (error) {
  console.error('Local recording failed during ' + step + ': ' + sanitized(error.message));
  process.exitCode = 1;
} finally {
  if (peer && peer.readyState < NetworkWebSocket.CLOSING) peer.close(1000, 'Recording finished');
  if (peer) {
    await Promise.race([
      new Promise((done) =>
        peer.readyState === NetworkWebSocket.CLOSED ? done() : peer.once('close', done),
      ),
      sleep(1000),
    ]);
    if (peer.readyState !== NetworkWebSocket.CLOSED) peer.terminate();
  }
  if (mf) await mf.dispose();
  await Promise.allSettled([...inFlight]);
}
