import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import NetworkWebSocket from 'ws';

const BASELINE_COMMIT = 'a830b2622a4e00759099da295467b0e5b8aadf8f';
const COMPATIBILITY_DATE = '2026-09-01';
const outputDirectory = 'output/lab-observer-delivery';
const finalPath = `${outputDirectory}/result.json`;
const checkpointPath = `${outputDirectory}/baseline.json`;
const projectRoot = resolve('.');
const git = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const foundationPaths = [
  'scripts/lab-observer-delivery.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
const currentPins = new Map();
const graphs = {};
const bundles = {};
let baselineIndex;
let stage = 'initialization';

function projectPath(path) {
  const key = relative(projectRoot, resolve(projectRoot, path)).replaceAll('\\', '/');
  assert(key && !key.startsWith('../') && !key.includes(':'), 'Unexpected build input');
  return key;
}
async function historicalIndex() {
  const { stdout } = await git('git', ['show', `${BASELINE_COMMIT}:worker/index.ts`], {
    cwd: projectRoot,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
    timeout: 10000,
  });
  return stdout;
}
async function pinCurrent(path) {
  const key = projectPath(path);
  const bytes = await readFile(resolve(projectRoot, key));
  const hash = sha256(bytes);
  if (currentPins.has(key)) assert.equal(currentPins.get(key).sha256, hash);
  currentPins.set(key, { bytes: bytes.length, sha256: hash });
  return bytes;
}
async function buildPinned(name, entry, baseline = false, node = false) {
  const inputs = new Map();
  const output = resolve(projectRoot, `${outputDirectory}/${name}.${node ? 'mjs' : 'js'}`);
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: [entry],
    outfile: output,
    write: false,
    metafile: true,
    bundle: true,
    format: 'esm',
    platform: node ? 'node' : 'browser',
    target: 'esnext',
    external: node ? [] : ['cloudflare:workers'],
    plugins: [
      {
        name: 'pin-exact-delivery-inputs',
        setup(builder) {
          builder.onLoad({ filter: /./ }, async (args) => {
            const key = projectPath(args.path);
            assert.equal(args.namespace, 'file', 'Unexpected build namespace');
            assert(/^(worker|tests\/fixtures)\//.test(key), 'Unexpected input path');
            const loader = { '.ts': 'ts', '.mjs': 'js' }[extname(key)];
            assert(loader, 'Unexpected input loader');
            const isHistorical = baseline && key === 'worker/index.ts';
            const bytes = isHistorical ? baselineIndex : await pinCurrent(args.path);
            inputs.set(key, {
              path: key,
              bytes: bytes.length,
              sha256: sha256(bytes),
              source: isHistorical ? 'pinned-git-index' : 'maintained-working-tree',
            });
            return { contents: bytes, loader, resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  assert.deepEqual(
    Object.keys(result.metafile.inputs).map(projectPath).sort(),
    [...inputs.keys()].sort(),
    'Complete exact-byte build graph',
  );
  assert.equal(result.outputFiles.length, 1);
  const bytes = result.outputFiles[0].contents;
  await writeFile(output, bytes);
  graphs[name] = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path));
  bundles[name] = { bytes: bytes.length, sha256: sha256(bytes) };
  return output;
}
async function verifyPins() {
  for (const [path, expected] of currentPins)
    assert.equal(sha256(await readFile(resolve(projectRoot, path))), expected.sha256);
  assert.equal(sha256(await historicalIndex()), sha256(baselineIndex));
}
function foundations() {
  return foundationPaths.map((path) => ({ path, ...currentPins.get(path) }));
}
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(predicate, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail('Bounded local condition did not settle');
}
function stateOf(inspection) {
  assert.equal(inspection.state.length, 1);
  return JSON.parse(inspection.state[0].value);
}
const terminalFrames = (peer) =>
  peer.frames.filter((frame) => frame.kind === 'expired' || frame.kind === 'unavailable');

async function runCase(profile, kind, paths, protocol) {
  let mf;
  const peers = [];
  let completed = false;
  let result;
  const capability = randomUUID();
  try {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        unsafeInspectDurableObjects: true,
        workers: [
          {
            name: 'gateway',
            modules: true,
            scriptPath: paths[profile],
            compatibilityDate: COMPATIBILITY_DATE,
            durableObjects: {
              LABS: { className: 'ReliabilityLab', useSQLite: true },
              MONITORS: { className: 'MonitorStore', useSQLite: true },
            },
            bindings: {
              LAB_IDLE_TTL_MS: '20000',
              AI_BRIEFS_ENABLED: 'false',
              LAB_ADMISSION_ENABLED: 'false',
            },
            serviceBindings: {
              ASSETS: async () => new Response('Local fixture assets', { status: 404 }),
              ORIGIN: 'origin',
            },
          },
          {
            name: 'origin',
            modules: true,
            scriptPath: paths.origin,
            compatibilityDate: COMPATIBILITY_DATE,
          },
        ],
      }),
    );
    const ready = await bounded(mf.ready, 10000, 'Local runtime initialization failed');
    const namespace = await mf.getDurableObjectNamespace('LABS', 'gateway');
    const stub = namespace.get(namespace.idFromName(capability));
    const control = async (action, body) => {
      const response = await bounded(
        stub.fetch('https://lab.internal/__fixture/' + action, {
          method: body === undefined ? 'GET' : 'POST',
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        5000,
        'Fixture control did not settle',
      );
      assert.equal(response.status, 200);
      return bounded(response.json(), 5000, 'Fixture control body did not settle');
    };
    const owner = async (action, body) => {
      const response = await bounded(
        mf.dispatchFetch(new URL('/api/' + action, ready), {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'X-Lab-ID': capability, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        5000,
        'Owner action did not settle',
      );
      const text = await bounded(response.text(), 5000, 'Owner body did not settle');
      assert(!text.includes('fixture-private-delivery-detail'));
      return { status: response.status, data: JSON.parse(text), headers: response.headers };
    };
    const connect = async () => {
      const url = new URL('/api/observe', ready);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new NetworkWebSocket(
        url,
        [protocol.LAB_OBSERVER_PROTOCOL, protocol.LAB_OBSERVER_CAPABILITY_PREFIX + capability],
        { origin: ready.origin, closeTimeout: 500 },
      );
      const peer = { socket, frames: [], closes: [], invalid: false, errors: 0 };
      peers.push(peer);
      socket.on('message', (bytes, binary) => {
        try {
          assert.equal(binary, false);
          assert(bytes.length <= protocol.MAX_LAB_OBSERVER_FRAME_BYTES);
          assert(peer.frames.length < 16);
          const text = bytes.toString('utf8');
          assert(!text.includes(capability));
          assert(!text.includes('fixture-private-delivery-detail'));
          for (const key of ['payload', 'cachedPayload', 'requestId', 'message', 'capability'])
            assert(!text.includes('"' + key + '"'));
          const frame = protocol.parseLabObserverFrame(text);
          assert(frame);
          assert.deepEqual(JSON.parse(text), frame, 'Exact allowlisted decoded wire frame');
          peer.frames.push(frame);
        } catch {
          peer.invalid = true;
        }
      });
      socket.on('close', (code, reason) =>
        peer.closes.push({
          code,
          reason: reason.toString('utf8'),
          receivedCloseFrame: socket._closeFrameReceived === true,
        }),
      );
      socket.on('error', () => peer.errors++);
      await bounded(
        new Promise((done, reject) => {
          socket.once('open', done);
          socket.once('error', () => reject(new Error('Local network handshake failed')));
          socket.once('unexpected-response', () =>
            reject(new Error('Local network handshake rejected')),
          );
        }),
        5000,
        'Local network handshake did not settle',
      );
      assert.equal(socket.protocol, protocol.LAB_OBSERVER_PROTOCOL);
      await waitFor(() => peer.frames.length === 1 || peer.invalid);
      assert.equal(peer.invalid, false);
      assert.equal(peer.frames[0].kind, 'snapshot');
      return peer;
    };
    const enrolled = await owner('state');
    assert.equal(enrolled.status, 200);
    const selected = await connect();
    await sleep(20);
    const healthy = await connect();
    const beforeHibernation = await control('inspect');
    assert.equal(beforeHibernation.openSockets, 2);
    assert.equal(new Set(beforeHibernation.attachments.map((a) => a.joinedAt)).size, 2);
    await bounded(
      mf.unsafeEvictDurableObject('gateway', 'ReliabilityLab', {
        name: capability,
        webSockets: 'hibernate',
      }),
      5000,
      'Native hibernation did not settle',
    );
    const resumed = await control('inspect');
    assert.notEqual(resumed.bootId, beforeHibernation.bootId);
    assert.deepEqual(resumed.state, beforeHibernation.state);
    assert.deepEqual(resumed.events, beforeHibernation.events);
    assert.deepEqual(resumed.attachments, beforeHibernation.attachments);
    assert.equal(resumed.expiresAt, beforeHibernation.expiresAt);
    assert.equal(resumed.alarmAt, beforeHibernation.alarmAt);
    assert.equal(resumed.openSockets, 2);
    assert.equal(stateOf(resumed).total, 0);
    assert.equal(stateOf(resumed).originCalls, 0);
    assert.equal(selected.frames.length, 1);
    assert.equal(healthy.frames.length, 1);
    await control('arm', { kind });
    let actionResponseStatus = null;
    if (kind === 'unavailable') {
      const original = stateOf(resumed);
      const response = await owner('config', { capacity: original.config.capacity + 1 });
      actionResponseStatus = response.status;
      assert.equal(response.status, 503);
      assert.equal(response.data.code, 'lab-storage-unavailable');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      await waitFor(() => healthy.closes.length === 1);
      const source = await control('inspect');
      const after = stateOf(source);
      assert.deepEqual(after.config, original.config);
      assert.equal(after.runId, original.runId);
      assert.equal(after.revision, original.revision + 1);
      assert.equal(after.total, 0);
      assert.equal(after.originCalls, 0);
      assert.deepEqual(after.counts, original.counts);
      assert.deepEqual(source.events, resumed.events);
      assert.equal(source.delivery.storageFaults, 1);
      assert.equal(source.delivery.nativeSaveExecuted, true);
      const selectedUpdates = selected.frames.filter((frame) => frame.kind === 'update');
      const healthyUpdates = healthy.frames.filter((frame) => frame.kind === 'update');
      assert.equal(selectedUpdates.length, 1);
      assert.deepEqual(selectedUpdates, healthyUpdates);
      assert.equal(selectedUpdates[0].revision, after.revision);
      assert.equal(selectedUpdates[0].state.config.capacity, original.config.capacity);
      assert.equal(selectedUpdates[0].expiresAt, source.expiresAt);
      assert.equal(source.expiresAt, source.alarmAt);
    } else {
      await control('deadline', { expiresAt: Date.now() + 1000 });
      await waitFor(() => healthy.closes.length === 1);
      const source = await control('inspect');
      assert.deepEqual(source.state, []);
      assert.deepEqual(source.events, []);
      assert.equal(source.expiresAt, null);
      assert.equal(source.alarmAt, null);
      assert.equal(source.delivery.storageFaults, 0);
      assert.equal(selected.frames.filter((frame) => frame.kind === 'update').length, 0);
      assert.equal(healthy.frames.filter((frame) => frame.kind === 'update').length, 0);
    }
    const expectedCode = kind === 'unavailable' ? 1011 : 4001;
    const expectedReason =
      kind === 'unavailable' ? 'Lab observer unavailable' : 'Lab idle deadline expired';
    const expectedClose = {
      code: expectedCode,
      reason: expectedReason,
      receivedCloseFrame: true,
    };
    assert.deepEqual(healthy.closes, [expectedClose]);
    assert.equal(terminalFrames(healthy).length, 1);
    assert.equal(terminalFrames(healthy)[0].kind, kind);
    assert.equal(terminalFrames(selected).length, 0);
    if (profile === 'baseline') {
      assert.equal(selected.socket.readyState, NetworkWebSocket.OPEN);
      assert.deepEqual(selected.closes, []);
      await waitFor(async () => (await control('inspect')).socketMembership === 1);
    } else {
      await waitFor(() => selected.closes.length === 1);
      assert.deepEqual(selected.closes, [expectedClose]);
      await waitFor(async () => (await control('inspect')).socketMembership === 0);
    }
    const final = await control('inspect');
    assert.equal(final.openSockets, profile === 'baseline' ? 1 : 0);
    assert.equal(final.delivery.selectedOpenAtFailure, true);
    assert.equal(final.delivery.sendFailures, 1);
    assert.equal(final.delivery.selectedSendAttempts, 1);
    assert.equal(final.delivery.healthySendAttempts, 1);
    assert.equal(final.delivery.selectedCloseAttempts, profile === 'baseline' ? 0 : 1);
    assert.equal(final.delivery.healthyCloseAttempts, 1);
    assert(peers.every((peer) => !peer.invalid && peer.errors === 0));
    result = {
      kind,
      peers: 2,
      originalSocketsSurviveForcedHibernation: true,
      hibernationPreservesStateDeadlineAlarmAndAttachments: true,
      chosenRecipientOpenWhenSendThrows: true,
      chosenTerminalDelivered: false,
      healthyTerminalDelivered: true,
      chosenNativeCloseAttempts: final.delivery.selectedCloseAttempts,
      healthyNativeCloseAttempts: final.delivery.healthyCloseAttempts,
      chosenCloseControlReceived: selected.closes[0]?.receivedCloseFrame ?? false,
      healthyCloseControlReceived: true,
      chosenCloseCode: selected.closes[0]?.code ?? null,
      healthyCloseCode: expectedCode,
      remainingOpenSockets: final.openSockets,
      remainingMembership: final.socketMembership,
      controlledSendFailures: final.delivery.sendFailures,
      actualConfigSaveFaults: final.delivery.storageFaults,
      executedNativeSaveBeforeFault: final.delivery.nativeSaveExecuted,
      actionResponseStatus,
      failedConfigRolledBackWithEarlierTouchPreserved: kind === 'unavailable',
      alarmClearsStateDeadlineAndEvents: kind === 'expired',
      noExperimentOrOriginAdmission: true,
      receivedCloseReasonsMatchStaticProtocol: true,
      protocolPrivacyPassed: true,
    };
    completed = true;
  } finally {
    for (const peer of peers) {
      if (peer.socket.readyState === NetworkWebSocket.OPEN)
        peer.socket.close(1000, 'Local fixture finished');
    }
    await bounded(
      Promise.all(
        peers.map(async (peer) => {
          if (peer.socket.readyState === NetworkWebSocket.CLOSED) return;
          await bounded(
            new Promise((done) => peer.socket.once('close', done)),
            1500,
            'Local peer cleanup deadline',
          ).catch(() => peer.socket.terminate());
        }),
      ),
      2000,
      'Local peer cleanup did not settle',
    );
    if (mf) await bounded(mf.dispose(), 10000, 'Runtime disposal did not settle');
  }
  assert(completed);
  return { ...result, runtimeDisposed: true };
}

try {
  assert.equal(process.argv.length, 2, 'Local recipe accepts no arguments');
  await mkdir(outputDirectory, { recursive: true });
  await rm(finalPath, { force: true });
  await rm(checkpointPath, { force: true });
  for (const path of foundationPaths) await pinCurrent(path);
  baselineIndex = await historicalIndex();
  stage = 'baseline-build';
  const paths = {};
  paths.baseline = await buildPinned('baseline', 'tests/fixtures/lab-observer-delivery.ts', true);
  paths.origin = await buildPinned('origin', 'worker/origin.ts');
  paths.protocol = await buildPinned('protocol', 'worker/lab-observer.ts', false, true);
  const protocol = await import(pathToFileURL(paths.protocol).href);
  const baseline = [];
  for (const kind of ['unavailable', 'expired']) {
    stage = 'baseline-' + kind;
    baseline.push(await runCase('baseline', kind, paths, protocol));
  }
  await verifyPins();
  const baselineCheckpoint = {
    schemaVersion: 1,
    kind: 'edgelab-lab-terminal-delivery-baseline',
    measuredAt: new Date().toISOString(),
    comparisonScope:
      'Exact pinned old index with maintained dependencies; not a full historical deployment',
    baselineIndex: {
      commit: BASELINE_COMMIT,
      path: 'worker/index.ts',
      sha256: sha256(baselineIndex),
    },
    cases: baseline,
    foundations: foundations(),
    buildInputs: { baseline: graphs.baseline, origin: graphs.origin, protocol: graphs.protocol },
    bundles: { baseline: bundles.baseline, origin: bundles.origin, protocol: bundles.protocol },
    sourceStableAfterDisposal: true,
  };
  await writeFile(checkpointPath, JSON.stringify(baselineCheckpoint, null, 2) + '\n');
  console.log('PASS pinned-index baseline: both native terminal cases reproduce omitted close');
  stage = 'maintained-build';
  paths.maintained = await buildPinned('maintained', 'tests/fixtures/lab-observer-delivery.ts');
  assert.deepEqual(
    graphs.baseline.filter(({ path }) => path !== 'worker/index.ts'),
    graphs.maintained.filter(({ path }) => path !== 'worker/index.ts'),
    'Comparison uses identical maintained dependencies',
  );
  const maintained = [];
  for (const kind of ['unavailable', 'expired']) {
    stage = 'maintained-' + kind;
    maintained.push(await runCase('maintained', kind, paths, protocol));
  }
  stage = 'provenance';
  await verifyPins();
  const packageVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
  const report = {
    schemaVersion: 1,
    kind: 'edgelab-lab-terminal-delivery-proof',
    measuredAt: new Date().toISOString(),
    recipe: 'node scripts/lab-observer-delivery.mjs',
    projectVersion: packageVersion,
    runtime: 'Actual local workerd SQLite and native network WebSockets via Miniflare',
    environment: {
      node: process.version,
      platform: process.platform,
      esbuild: JSON.parse(await readFile('node_modules/esbuild/package.json', 'utf8')).version,
      miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
      workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
      ws: JSON.parse(await readFile('node_modules/ws/package.json', 'utf8')).version,
      compatibilityDate: COMPATIBILITY_DATE,
      cfMetadata: false,
      telemetry: false,
      productionRequests: 0,
      accountCalls: 0,
      nativeInferenceCalls: 0,
    },
    comparisonScope: baselineCheckpoint.comparisonScope,
    baselineIndex: baselineCheckpoint.baselineIndex,
    cases: { baseline, maintained },
    foundations: foundations(),
    buildInputs: graphs,
    bundles,
    sourceStableAfterDisposal: true,
    allRuntimesDisposed: true,
    limitations: [
      'The send exception is fixture-thrown JavaScript before one terminal send delegates to a still-OPEN native socket. It is a controlled API failure, not an observed native send exception or evidence of natural production incidence.',
      'getWebSockets returns proxies around actual runtime sockets; nonfaulted send and all close calls are bound native methods. Socket transport, acceptance, attachments and membership are not simulated.',
      'The baseline substitutes only the exact historical worker/index.ts bytes from the pinned Git commit; all other graph inputs and foundations match the maintained build.',
      'Forced hibernation uses the supported unsafeEvictDurableObject API with webSockets:hibernate. No natural production eviction timing is claimed.',
      'The peer uses a 500 ms close-handshake timeout. Received server close control frames and membership release are asserted; natural TCP teardown timing is not measured.',
      'Unavailable injects a JavaScript exception after real config-save SQL is consumed inside the production transaction; it is not a naturally occurring SQLite failure. The failed action rolls back, while the earlier successful owner touch remains visible.',
      'Expiry uses a fixture-shortened deadline and the real alarm. Diagnostic controls are local only and no experiment or origin request is issued.',
      'Source commits and native send/close attempts do not acknowledge client application of a frame. No storage billing, capacity or account-wide cost claim is made.',
    ],
  };
  // Publish success only after every case, disposal and exact source-pin check.
  await writeFile(finalPath, JSON.stringify(report, null, 2) + '\n');
  console.log('PASS maintained: missing terminal message still closes both native memberships');
  console.log('PASS four local cases; source hashes stable after disposal');
} catch {
  await rm(finalPath, { force: true }).catch(() => {});
  console.error('Lab observer delivery proof failed at ' + stage + '.');
  process.exitCode = 1;
}
