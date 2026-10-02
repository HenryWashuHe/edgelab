import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, extname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, version as esbuildVersion } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const BASELINE_COMMIT = '5d2f2714197d3c54f3f99f177ab6c511275ecce0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'output/request-body');
const COMPATIBILITY_DATE = '2026-09-01';
const TOKEN = 'request-body-local-token-not-a-real-secret';
const CAPABILITY = '00000000-0000-4000-8000-000000000001';
const INCIDENT = '00000000-0000-4000-8000-000000000002';
const DISPATCH_KEYS = [
  'labNames',
  'labGets',
  'labFetches',
  'monitorNames',
  'monitorGets',
  'monitorFetches',
  'ownerAdmission',
  'observerAdmission',
];
const FOUNDATION_PATHS = [
  'scripts/request-body.test.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
const runGit = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pins = new Map();
const graphs = {};
const bundles = {};
const observations = [];
const runtimes = [];
let baselineIndex;
let configBytes;

function keyOf(path) {
  const key = relative(ROOT, resolve(ROOT, path)).replaceAll('\\', '/');
  assert(key && !key.startsWith('../') && !key.includes(':'), 'Unexpected build path');
  return key;
}
async function historicalIndex() {
  const { stdout } = await runGit('git', ['show', `${BASELINE_COMMIT}:worker/index.ts`], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
    timeout: 10000,
  });
  return stdout;
}
async function pin(path) {
  const key = keyOf(path);
  const bytes = await readFile(resolve(ROOT, key));
  const sha256 = hash(bytes);
  if (pins.has(key)) assert.equal(pins.get(key).sha256, sha256, 'Source changed during recipe');
  pins.set(key, { path: key, bytes: bytes.length, sha256 });
  return bytes;
}
async function compile(profile) {
  const inputs = new Map();
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['tests/fixtures/request-body.ts'],
    outfile: resolve(OUTPUT, `${profile}.js`),
    write: false,
    metafile: true,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    external: ['cloudflare:workers'],
    tsconfigRaw: configBytes.toString('utf8'),
    plugins: [
      {
        name: 'exact-request-body-inputs',
        setup(builder) {
          builder.onLoad({ filter: /./ }, async (args) => {
            const path = keyOf(args.path);
            assert.equal(args.namespace, 'file');
            assert(/^(worker|tests\/fixtures)\//.test(path), 'Unexpected source graph');
            const loader = { '.ts': 'ts', '.mjs': 'js' }[extname(path)];
            assert(loader, 'Unexpected source loader');
            const historical = profile === 'baseline' && path === 'worker/index.ts';
            const bytes = historical ? baselineIndex : await pin(path);
            inputs.set(path, {
              path,
              bytes: bytes.length,
              sha256: hash(bytes),
              source: historical ? 'pinned-git-index' : 'maintained-working-tree',
            });
            return { contents: bytes, loader, resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  assert.deepEqual(
    Object.keys(result.metafile.inputs).map(keyOf).sort(),
    [...inputs.keys()].sort(),
  );
  assert.equal(result.outputFiles.length, 1);
  const output = Object.values(result.metafile.outputs);
  assert.equal(output.length, 1);
  assert(output[0].imports.every((item) => item.external && item.path === 'cloudflare:workers'));
  graphs[profile] = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path));
  const bytes = result.outputFiles[0].contents;
  bundles[profile] = { bytes: bytes.length, sha256: hash(bytes) };
  await writeFile(resolve(OUTPUT, `${profile}.js`), bytes);
  return new TextDecoder().decode(bytes);
}
async function stableSources() {
  for (const [path, expected] of pins)
    assert.equal(
      hash(await readFile(resolve(ROOT, path))),
      expected.sha256,
      'Frozen source changed',
    );
  assert.equal(hash(await historicalIndex()), hash(baselineIndex));
}
async function bounded(promise, milliseconds, message = 'Local operation deadline exceeded') {
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
async function waitFor(predicate, milliseconds = 5000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail('Local condition deadline exceeded');
}
function difference(after, before) {
  return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
}
function noDispatch(delta) {
  for (const key of DISPATCH_KEYS) assert.equal(delta[key], 0, `${key} before rejected body`);
}
function safeResponse(response, expectedStatus, expectedError) {
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(response.data, { error: expectedError });
}
async function decoded(response) {
  const text = await bounded(response.text(), 5000);
  assert(!text.includes('fixture-private-'), 'Private injected error escaped');
  return { status: response.status, data: JSON.parse(text), headers: response.headers };
}
function holdRegistry() {
  const entries = new Map();
  function get(key) {
    if (!entries.has(key)) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      entries.set(key, { entered: false, promise, release });
    }
    return entries.get(key);
  }
  return {
    async fetch(request) {
      const key = new URL(request.url).pathname;
      const entry = get(key);
      entry.entered = true;
      await entry.promise;
      return Response.json({ released: true });
    },
    entered: (key) => get(key).entered,
    release: (key) => get(key).release(),
    releaseAll: () => {
      for (const entry of entries.values()) entry.release();
    },
  };
}
async function createRuntime(profile, script) {
  const holds = holdRegistry();
  const record = { profile, disposed: false, originCalls: 0, socketsOpened: 0, socketsClosed: 0 };
  runtimes.push(record);
  const sockets = new Set();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      host: '127.0.0.1',
      port: 0,
      unsafeInspectDurableObjects: true,
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: 'gateway',
          modules: true,
          script,
          compatibilityDate: COMPATIBILITY_DATE,
          unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: {
            LAB_IDLE_TTL_MS: '60000',
            AI_BRIEFS_ENABLED: 'false',
            LAB_ADMISSION_ENABLED: 'true',
            OPERATOR_TOKEN: TOKEN,
            MONITOR_TARGETS: JSON.stringify([
              {
                id: 'fixture',
                name: 'Controlled request-body target',
                url: 'https://origin.internal/health',
                transport: 'origin',
                assertion: 'ok-json',
              },
            ]),
          },
          ratelimits: {
            LAB_OWNER_LIMITER: {
              namespace_id: profile === 'baseline' ? '41001' : '41003',
              simple: { limit: 1000, period: 60 },
            },
            LAB_OBSERVER_LIMITER: {
              namespace_id: profile === 'baseline' ? '41002' : '41004',
              simple: { limit: 1000, period: 60 },
            },
          },
          serviceBindings: {
            HOLD: (request) => holds.fetch(request),
            ASSETS: async () => new Response('Local fixture assets', { status: 404 }),
            ORIGIN: async () => {
              record.originCalls++;
              throw new Error('Unexpected local origin probe');
            },
          },
        },
      ],
    }),
  );
  let ready;
  let direct;
  try {
    ready = await bounded(mf.ready, 15000, 'Native runtime startup deadline exceeded');
    direct = await bounded(mf.unsafeGetDirectURL('gateway'), 5000);
  } catch (error) {
    holds.releaseAll();
    await mf.dispose();
    record.disposed = true;
    throw error;
  }
  const metrics = async () => {
    const response = await bounded(mf.dispatchFetch(new URL('/__fixture/metrics', ready)), 5000);
    assert.equal(response.status, 200);
    return bounded(response.json(), 5000);
  };
  const call = (mode, route, key) =>
    mf.dispatchFetch(new URL(`/__fixture/body?mode=${mode}&route=${route}&key=${key}`, ready));
  const ordinary = async (path, init = {}) =>
    decoded(await bounded(mf.dispatchFetch(new URL(path, ready), init), 5000));
  const partial = () => {
    const began = performance.now();
    let settled = false;
    let responseEnded = false;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const request = http.request(
      new URL('/api/config', direct),
      {
        method: 'POST',
        agent: false,
        headers: {
          'X-Lab-ID': CAPABILITY,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', rejectResult);
        response.on('end', () => {
          settled = true;
          responseEnded = true;
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            assert(!text.includes('fixture-private-'));
            resolveResult({
              status: response.statusCode,
              data: JSON.parse(text),
              headers: new Headers(response.headers),
              elapsedMs: performance.now() - began,
            });
          } catch {
            rejectResult(new Error('Invalid local HTTP response'));
          }
        });
      },
    );
    request.on('socket', (socket) => {
      record.socketsOpened++;
      sockets.add(socket);
      socket.once('close', () => {
        record.socketsClosed++;
        sockets.delete(socket);
      });
    });
    request.on('error', (error) => {
      if (!responseEnded) rejectResult(error);
    });
    request.flushHeaders();
    request.write('{');
    return {
      request,
      result,
      elapsedMs: () => performance.now() - began,
      isSettled: () => settled,
    };
  };
  return {
    profile,
    mf,
    ready,
    direct,
    holds,
    metrics,
    call,
    ordinary,
    partial,
    record,
    async dispose() {
      holds.releaseAll();
      for (const socket of sockets) socket.destroy();
      try {
        await waitFor(() => sockets.size === 0);
      } finally {
        await mf.dispose();
        record.disposed = true;
      }
      assert.equal(record.socketsOpened, record.socketsClosed);
      assert.equal(record.originCalls, 0);
    },
  };
}

test(
  'bounded request bodies through actual maintained and pinned baseline gateway',
  { timeout: 120000 },
  async (t) => {
    const startedAt = new Date().toISOString();
    await mkdir(OUTPUT, { recursive: true });
    await rm(resolve(OUTPUT, 'evidence.json'), { force: true });
    for (const path of FOUNDATION_PATHS) await pin(path);
    configBytes = await pin('tsconfig.json');
    baselineIndex = await historicalIndex();
    const packageInfo = JSON.parse((await pin('package.json')).toString('utf8'));
    assert.equal(packageInfo.version, '3.12.5');
    const scripts = {
      baseline: await compile('baseline'),
      maintained: await compile('maintained'),
    };
    assert(graphs.maintained.some((input) => input.path === 'worker/request-body.ts'));
    assert(!graphs.baseline.some((input) => input.path === 'worker/request-body.ts'));
    for (const oldInput of graphs.baseline)
      if (oldInput.path !== 'worker/index.ts')
        assert.deepEqual(
          oldInput,
          graphs.maintained.find((input) => input.path === oldInput.path),
        );
    let baseline;
    let maintained;
    const native = [];
    const passed = [];
    async function group(name, fn) {
      let didPass = false;
      await t.test(name, async () => {
        await fn();
        didPass = true;
      });
      assert(didPass, 'A native proof group failed; final evidence will not be published');
      passed.push(name);
    }
    try {
      baseline = await createRuntime('baseline', scripts.baseline);
      native.push(baseline);
      maintained = await createRuntime('maintained', scripts.maintained);
      native.push(maintained);
      await group(
        'pinned baseline waits for held cancellation on lab and authorized operations',
        async () => {
          for (const route of ['lab', 'ops']) {
            const key = `baseline-${route}`;
            const before = await baseline.metrics();
            let settled = false;
            const pending = baseline.call('overflow-hold', route, key).then((response) => {
              settled = true;
              return response;
            });
            await waitFor(() => baseline.holds.entered(`/${key}/cancel`));
            await sleep(250);
            assert.equal(settled, false);
            const heldDelta = difference(await baseline.metrics(), before);
            noDispatch(heldDelta);
            baseline.holds.release(`/${key}/cancel`);
            const response = await decoded(await bounded(pending, 5000));
            safeResponse(response, 413, 'Request exceeds 4 KB');
            noDispatch(difference(await baseline.metrics(), before));
            observations.push({
              profile: 'baseline',
              case: 'held-cancellation',
              route,
              input: 'constructed-stream',
              overflowBytes: 4097,
              observedPendingForMs: 250,
              statusAfterRelease: response.status,
              dispatchWhileHeld: heldDelta,
            });
          }
        },
      );
      await group(
        'maintained overflow does not await held or throwing cancellation before rejection',
        async () => {
          for (const route of ['lab', 'ops'])
            for (const mode of ['overflow-hold', 'overflow-throw']) {
              const key = `maintained-${route}-${mode}`;
              const before = await maintained.metrics();
              const pending = maintained.call(mode, route, key);
              if (mode === 'overflow-hold')
                await waitFor(() => maintained.holds.entered(`/${key}/cancel`));
              const response = await decoded(await bounded(pending, 1500));
              safeResponse(response, 413, 'Request exceeds 4 KB');
              const delta = difference(await maintained.metrics(), before);
              noDispatch(delta);
              assert.equal(delta.cancelCalls, 1);
              if (mode === 'overflow-hold') {
                assert.equal(delta.cancelCompleted, 0);
                maintained.holds.release(`/${key}/cancel`);
                await waitFor(
                  async () => difference(await maintained.metrics(), before).cancelCompleted === 1,
                );
              }
              observations.push({
                profile: 'maintained',
                case: mode,
                route,
                input: 'constructed-stream',
                overflowBytes: 4097,
                status: response.status,
                dispatchAtRejection: delta,
              });
            }
        },
      );
      await group(
        'read and signal faults return sanitized400 before delegation; late supplied bytes cannot mutate',
        async () => {
          for (const route of ['lab', 'ops'])
            for (const mode of ['read-error', 'abort-before', 'abort-late']) {
              const key = `maintained-${route}-${mode}`;
              const before = await maintained.metrics();
              const pending = maintained.call(mode, route, key);
              if (mode === 'abort-late')
                await waitFor(() => maintained.holds.entered(`/${key}/data`));
              const response = await decoded(await bounded(pending, 5000));
              safeResponse(response, 400, 'Request body could not be read');
              const delta = difference(await maintained.metrics(), before);
              noDispatch(delta);
              if (mode === 'abort-late') {
                assert.equal(delta.lateSupplyAttempts, 0);
                maintained.holds.release(`/${key}/data`);
                await waitFor(
                  async () =>
                    difference(await maintained.metrics(), before).lateSupplyAttempts === 1,
                );
                const late = difference(await maintained.metrics(), before);
                noDispatch(late);
                assert.equal(late.lateSupplyRejected, 1);
              }
              observations.push({
                profile: 'maintained',
                case: mode,
                route,
                input: 'constructed-stream',
                status: response.status,
                dispatchAfterLateRelease: difference(await maintained.metrics(), before),
              });
            }
        },
      );
      await group(
        'exact4096-byte controls and splitUTF8/tiny/empty chunks preserve native state and JSON validation',
        async () => {
          for (const runtime of native) {
            const health = await runtime.ordinary('/api/health');
            assert.equal(health.status, 200);
            assert.equal(
              health.data.version,
              runtime.profile === 'maintained' ? '3.12.5' : '3.12.4',
            );
            const status = await runtime.ordinary('/api/ops/status');
            assert.equal(status.status, 200);
            const storage = await runtime.mf.unsafeGetDurableObjectStorage(
              'gateway',
              'MonitorStore',
              { name: 'operations' },
            );
            await storage.exec(
              'INSERT INTO incidents(id,service,opened,resolved,acknowledged,note) VALUES(?,?,?,?,?,?)',
              INCIDENT,
              'fixture',
              Date.now() - 60000,
              null,
              null,
              '',
            );
            for (const mode of ['exact', 'tiny-empty']) {
              const before = await runtime.metrics();
              const response = await decoded(
                await bounded(runtime.call(mode, 'lab', `${runtime.profile}-${mode}`), 8000),
              );
              assert.equal(response.status, 200);
              assert.deepEqual(response.data, { ok: true });
              const delta = difference(await runtime.metrics(), before);
              assert.equal(delta.ownerAdmission, 1);
              assert.equal(delta.labFetches, 1);
              const state = await runtime.ordinary('/api/state', {
                headers: { 'X-Lab-ID': CAPABILITY },
              });
              assert.equal(state.status, 200);
              assert.equal(state.data.state.config.capacity, 17);
              observations.push({
                profile: runtime.profile,
                case: mode,
                route: 'lab',
                input: 'constructed-stream',
                bytes: 4096,
                status: 200,
                dispatch: delta,
              });
            }
            const before = await runtime.metrics();
            const note = await decoded(
              await bounded(runtime.call('split-utf8', 'ops', `${runtime.profile}-utf8`), 8000),
            );
            assert.equal(note.status, 201);
            assert.equal(note.data.note.note, 'é🟩');
            const rows = await storage.exec(
              'SELECT note FROM incident_notes WHERE incident=?',
              INCIDENT,
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].note, 'é🟩');
            const delta = difference(await runtime.metrics(), before);
            assert.equal(delta.monitorFetches, 1);
            observations.push({
              profile: runtime.profile,
              case: 'split-utf8',
              route: 'ops',
              input: 'constructed-stream',
              bytes: 4096,
              status: 201,
              unicodePreservedInNativeSQLite: true,
              dispatch: delta,
            });
            for (const route of ['lab', 'ops']) {
              const before = await runtime.metrics();
              const response = await decoded(
                await bounded(
                  runtime.call('overflow-finite', route, `${runtime.profile}-finite-${route}`),
                  5000,
                ),
              );
              safeResponse(response, 413, 'Request exceeds 4 KB');
              const overflowDelta = difference(await runtime.metrics(), before);
              noDispatch(overflowDelta);
              observations.push({
                profile: runtime.profile,
                case: 'overflow-finite',
                route,
                input: 'constructed-stream',
                bytes: 4097,
                status: 413,
                dispatch: overflowDelta,
              });
              for (const mode of ['empty', 'no-body', 'invalid-json', 'array-json']) {
                const before = await runtime.metrics();
                const response = await decoded(
                  await bounded(
                    runtime.call(mode, route, `${runtime.profile}-${mode}-${route}`),
                    5000,
                  ),
                );
                assert.equal(response.status, 400);
                const delta = difference(await runtime.metrics(), before);
                if (route === 'ops') noDispatch(delta);
                else {
                  assert.equal(delta.ownerAdmission, 1);
                  assert.equal(delta.labFetches, 1);
                }
                observations.push({
                  profile: runtime.profile,
                  case: mode,
                  route,
                  input: 'constructed-stream',
                  status: 400,
                  dispatch: delta,
                });
              }
            }
          }
        },
      );
      await group(
        'real loopback partialHTTP baseline stays pending then completed valid body reaches native actor',
        async () => {
          const before = await baseline.metrics();
          const upload = baseline.partial();
          try {
            await sleep(250);
            assert.equal(upload.isSettled(), false);
            const heldDelta = difference(await baseline.metrics(), before);
            noDispatch(heldDelta);
            upload.request.end('"capacity":19}');
            const response = await bounded(upload.result, 5000);
            assert.equal(response.status, 200);
            assert.deepEqual(response.data, { ok: true });
            const state = await baseline.ordinary('/api/state', {
              headers: { 'X-Lab-ID': CAPABILITY },
            });
            assert.equal(state.status, 200);
            assert.equal(state.data.state.config.capacity, 19);
            observations.push({
              profile: 'baseline',
              case: 'partial-connected-http',
              input: 'actual-node-http-loopback',
              observedPendingForMs: 250,
              statusAfterCompletingValidBody: 200,
              dispatchWhileHeld: heldDelta,
            });
          } finally {
            upload.request.destroy();
          }
        },
      );
      await group(
        'real loopback partialHTTP returns408 at absolute10s despite additional bytes before deadline',
        async () => {
          const before = await maintained.metrics();
          const upload = maintained.partial();
          let extraTimer;
          let extraBytesSentAtMs = null;
          let extraWriteFailed = false;
          try {
            extraTimer = setTimeout(() => {
              upload.request.write('"capacity":', (error) => {
                if (error) extraWriteFailed = true;
                else extraBytesSentAtMs = upload.elapsedMs();
              });
            }, 6000);
            const response = await bounded(upload.result, 13000);
            safeResponse(response, 408, 'Request body timed out');
            assert.equal(extraWriteFailed, false);
            assert(extraBytesSentAtMs !== null && extraBytesSentAtMs < response.elapsedMs);
            assert(
              response.elapsedMs >= 9500 && response.elapsedMs < 12500,
              'Actual fixed body deadline',
            );
            const delta = difference(await maintained.metrics(), before);
            noDispatch(delta);
            observations.push({
              profile: 'maintained',
              case: 'partial-connected-http',
              input: 'actual-node-http-loopback',
              extraBytesScheduledAfterMs: 6000,
              extraBytesSentAtMs,
              status: 408,
              elapsedMs: response.elapsedMs,
              deadlineMs: 10000,
              dispatch: delta,
            });
          } finally {
            clearTimeout(extraTimer);
            upload.request.destroy();
          }
        },
      );
      await group(
        'cooperative yields let absolute10s deadline reject a constructed stream of empty chunks',
        async () => {
          const before = await maintained.metrics();
          const began = performance.now();
          const response = await decoded(
            await bounded(maintained.call('empty-forever', 'ops', 'empty-forever'), 13000),
          );
          const elapsedMs = performance.now() - began;
          safeResponse(response, 408, 'Request body timed out');
          assert(elapsedMs >= 9500 && elapsedMs < 12500);
          const delta = difference(await maintained.metrics(), before);
          noDispatch(delta);
          observations.push({
            profile: 'maintained',
            case: 'empty-forever',
            route: 'ops',
            input: 'constructed-stream',
            status: 408,
            elapsedMs,
            deadlineMs: 10000,
            dispatch: delta,
          });
        },
      );
    } finally {
      const cleanups = await Promise.allSettled(native.map((runtime) => runtime.dispose()));
      const failed = cleanups.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    await stableSources();
    assert(runtimes.every((runtime) => runtime.disposed));
    const installed = JSON.parse(
      await readFile(resolve(ROOT, 'node_modules/miniflare/package.json'), 'utf8'),
    );
    const evidence = {
      schemaVersion: 1,
      kind: 'edgelab-request-body-boundary',
      startedAt,
      measuredAt: new Date().toISOString(),
      projectVersion: packageInfo.version,
      baselineCommit: BASELINE_COMMIT,
      environment: {
        node: process.version,
        esbuild: esbuildVersion,
        miniflare: installed.version,
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: [],
        connectedHTTPListener:
          'Miniflare unsafeDirectSockets native workerd loopback; Node http client',
        runtime:
          'actual local workerd with native Durable Objects/SQLite and native admission binding',
      },
      bounds: {
        retainedBodyBytes: 4096,
        fullBodyDeadlineMs: 10000,
        normalOperationDeadlineMs: 8000,
        timeoutObservationDeadlineMs: 13000,
        baselinePendingObservationMs: 250,
        recipeDeadlineMs: 120000,
      },
      sources: {
        foundations: FOUNDATION_PATHS.map((path) => pins.get(path)),
        current: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path)),
        baselineIndex: {
          path: 'worker/index.ts',
          commit: BASELINE_COMMIT,
          bytes: baselineIndex.length,
          sha256: hash(baselineIndex),
        },
        graphs,
        bundles,
        stableAfterDisposal: true,
        substitution:
          'Only worker/index.ts is replaced by its pinned old bytes; all other reached dependencies use the same current buffers. The new reader is reached only by the maintained index.',
      },
      proofGroups: passed,
      observations,
      runtimes,
      privacy: {
        operatorToken: 'synthetic local fixture only; not serialized',
        capabilities: 'synthetic local fixture only; not serialized',
        rejectedErrors: 'exact static error JSON verified; private injected error strings absent',
      },
      limitations: [
        'Held/throwing cancellation, body read faults, abort signals, late data and infinite empty chunks are constructed streams inside workerd, with controlled Node HOLD service bindings.',
        "The connected partial upload uses actual Node HTTP to the native workerd unsafeDirectSockets loopback listener. It uses the production fixed ten-second deadline, not an injected clock or timeout; it bypasses Miniflare's Node front transport.",
        'Constructed AbortController faults do not establish incoming network disconnect signaling. No enable_request_signal compatibility flag was added.',
        'This reproduces local controlled boundaries, not naturally observed production faults, account costs, demand, rendered UI or universal transport behavior.',
        'Dispatch counters wrap and delegate actual native namespaces, stubs and rate limiters; they are not actor decisions or billing counters.',
        'Native runtime package and source buffers are pinned; the installed workerd binary is exercised through Miniflare, not independently attested.',
      ],
      externalCalls: { cloudflareAccount: 0, production: 0, browser: 0 },
    };
    await writeFile(resolve(OUTPUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  },
);
