import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare';
import * as codec from '../examples/counter-evidence/codec.mjs';

// A fixed, local-only integration with an externally authored example. No
// browser, deployment, account, application credential or remote input exists.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = resolve(root, 'output/counter-portability');
const started = performance.now();
const sourceHashes = new Map();
const runtimes = [];
const sockets = new Set();
const run = promisify(execFile);
const expectedCode = '1c7c0f960a1f9b91b0b7488fc228208d8ec2a39fdfaf0d89b553184fae9151a6';
const expectedLicense = '246b89de9b9621800e31db8422c53fdcb41b942a0cc1f7733dc6736fe49e6670';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let stage = 'arguments';
let proxy = null;
let result = null;
let disposed = false;

async function bounded(promise, limit = 5000, cleanup = false) {
  const left = 60000 - (performance.now() - started);
  if (!cleanup && left <= 0) throw new Error('deadline');
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('deadline')),
          Math.min(limit, cleanup ? limit : left),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function pin(path) {
  const key = relative(root, resolve(root, path)).replaceAll('\\', '/');
  assert(key && !key.startsWith('../') && !key.includes(':'));
  const bytes = await readFile(resolve(root, key));
  const hash = sha(bytes);
  if (sourceHashes.has(key)) assert.equal(hash, sourceHashes.get(key));
  sourceHashes.set(key, hash);
  return bytes;
}
async function bundle(entry) {
  const inputs = new Set();
  const built = await bounded(
    build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      external: ['cloudflare:workers'],
      metafile: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'pin-example-inputs',
          setup(builder) {
            builder.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
              inputs.add(relative(root, args.path).replaceAll('\\', '/'));
              return {
                contents: (await pin(args.path)).toString('utf8'),
                loader: 'js',
                resolveDir: dirname(args.path),
              };
            });
          },
        },
      ],
    }),
  );
  assert.equal(built.outputFiles.length, 1);
  assert.deepEqual(Object.keys(built.metafile.inputs).sort(), [...inputs].sort());
  return {
    script: built.outputFiles[0].text,
    sha256: sha(built.outputFiles[0].contents),
    inputs: [...inputs].sort(),
  };
}
function runtime(built, className) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      workers: [
        {
          name: 'counter',
          modules: true,
          script: built.script,
          compatibilityDate: '2026-09-01',
          durableObjects: { COUNTERS: { className, useSQLite: true } },
        },
      ],
    }),
  );
  runtimes.push(mf);
  return mf;
}
function address(ready, path, name) {
  const url = new URL(path, ready);
  if (name) url.searchParams.set('name', name);
  return url;
}
async function body(response, maximum = 1024) {
  const text = await bounded(response.text());
  assert(Buffer.byteLength(text) <= maximum);
  return text;
}
async function count(mf, ready, name, path = '/', method = 'GET') {
  const response = await bounded(mf.dispatchFetch(address(ready, path, name), { method }));
  assert.equal(response.status, 200);
  const text = await body(response, 512);
  const prefix = `Durable Object '${name}' count: `;
  assert(text.startsWith(prefix));
  const value = text.slice(prefix.length);
  assert(/^-?\d+$/.test(value));
  assert(Number.isSafeInteger(Number(value)));
  return Number(value);
}
async function json(mf, ready, name, path) {
  const response = await bounded(mf.dispatchFetch(address(ready, path, name)));
  assert.equal(response.status, 200);
  return JSON.parse(await body(response));
}
async function meter(mf, ready, name) {
  const value = await json(mf, ready, name, '/__meter');
  assert.equal(value.scope, 'attempted-logical-calls-since-construction');
  assert.deepEqual(
    Object.keys(value).sort(),
    ['scope', 'operations', 'constructionSequence'].sort(),
  );
  assert.deepEqual(
    Object.keys(value.operations).sort(),
    [
      'get',
      'put',
      'delete',
      'list',
      'deleteAll',
      'getAlarm',
      'setAlarm',
      'deleteAlarm',
      'sync',
    ].sort(),
  );
  for (const operationCount of Object.values(value.operations))
    assert(Number.isSafeInteger(operationCount) && operationCount >= 0);
  return value.operations;
}
async function sample(mf, ready, name) {
  stage = 'sample-before-meter';
  const before = await meter(mf, ready, name);
  stage = 'sample-read';
  const value = await json(mf, ready, name, '/__sample');
  const receivedAt = Date.now();
  stage = 'sample-after-meter';
  const after = await meter(mf, ready, name);
  stage = 'sample-operation-delta';
  assert.deepEqual(after, { ...before, get: before.get + 1 });
  assert.equal(value.sourceRevision, null);
  assert.equal(value.sourceCommitAt, null);
  return { ...value, receivedAt };
}
async function unavailable(url) {
  try {
    const response = await bounded(
      fetch(url, {
        method: 'POST',
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      }),
    );
    await body(response);
    return false;
  } catch {
    return true;
  }
}
async function atomic(name, value) {
  const path = resolve(directory, name);
  const temporary = path + '.tmp';
  await writeFile(
    temporary,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  );
  await rename(temporary, path);
}

try {
  assert.equal(process.argv.length, 2);
  await mkdir(directory, { recursive: true });
  // A failed rerun must not leave an old result looking like current success.
  for (const name of ['result.json', 'before-loss.json', 'after-loss.json'])
    await rm(resolve(directory, name), { force: true });
  stage = 'source-provenance';
  const code = await pin('examples/counter-evidence/upstream/counter.js');
  const license = await pin('examples/counter-evidence/upstream/LICENSE-CODE');
  assert.equal(sha(code), expectedCode);
  assert.equal(sha(license), expectedLicense);
  assert.equal(code.byteLength, 1713);
  assert.equal(license.byteLength, 1088);
  const provenance = JSON.parse(await pin('examples/counter-evidence/upstream/provenance.json'));
  assert.equal(provenance.codeSha256, expectedCode);
  assert.equal(provenance.licenseSha256, expectedLicense);
  assert.equal(provenance.commit, '976c80e2120fdea5b4e1b1dd0eff2683802da981');
  for (const file of [
    'scripts/counter-portability.mjs',
    'examples/counter-evidence/codec.mjs',
    'examples/counter-evidence/inspect.mjs',
    'worker/unique-json.mjs',
    'package.json',
    'package-lock.json',
  ])
    await pin(file);
  const version = JSON.parse(await readFile(resolve(root, 'package.json'))).version;
  const bareBuild = await bundle('examples/counter-evidence/upstream/counter.js');
  const adaptedBuild = await bundle('examples/counter-evidence/adapter.mjs');
  const memoryBuild = await bundle('examples/counter-evidence/memory-control.mjs');
  const bare = runtime(bareBuild, 'Counter');
  const adapted = runtime(adaptedBuild, 'EvidenceCounter');
  const memory = runtime(memoryBuild, 'MemoryCounter');
  const bareReady = await bounded(bare.ready);
  const ready = await bounded(adapted.ready);
  const memoryReady = await bounded(memory.ready);

  stage = 'unchanged-route-parity';
  const parityName = randomUUID();
  const parity = [];
  for (const [path, method] of [
    ['/', 'GET'],
    ['/increment', 'POST'],
    ['/increment', 'GET'],
    ['/decrement', 'POST'],
    ['/', 'GET'],
  ]) {
    const originalValue = await count(bare, bareReady, parityName, path, method);
    const adaptedValue = await count(adapted, ready, parityName, path, method);
    assert.equal(adaptedValue, originalValue);
    parity.push({ path, method, value: originalValue });
  }
  assert.deepEqual(
    parity.map((row) => row.value),
    [0, 1, 2, 1, 1],
  );
  for (const mf of [bare, adapted]) {
    const start = mf === bare ? bareReady : ready;
    assert.equal(
      (await bounded(mf.dispatchFetch(address(start, '/missing', parityName)))).status,
      404,
    );
    assert.equal((await bounded(mf.dispatchFetch(address(start, '/')))).status, 200);
  }
  assert.equal(
    (
      await bounded(
        adapted.dispatchFetch(address(ready, '/__sample', parityName), { method: 'POST' }),
      )
    ).status,
    405,
  );
  assert.equal((await bounded(adapted.dispatchFetch(address(ready, '/__sample')))).status, 400);

  stage = 'initial-adapter-samples';
  const names = { before: randomUUID(), after: randomUUID() };
  const beforeInitial = await sample(adapted, ready, names.before);
  const afterInitial = await sample(adapted, ready, names.after);
  assert.equal(beforeInitial.state.value, 0);
  assert.equal(afterInitial.state.value, 0);
  const transport = {
    beforeAttempts: 0,
    beforeDelegations: 0,
    afterAttempts: 0,
    afterDelegations: 0,
    afterResponsesConsumed: 0,
    upstreamErrors: 0,
  };
  proxy = createServer(async (request, response) => {
    request.resume();
    if (request.method !== 'POST' || !['/before', '/after'].includes(request.url)) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === '/before') {
      transport.beforeAttempts++;
      request.socket.destroy();
      return;
    }
    transport.afterAttempts++;
    transport.afterDelegations++;
    try {
      // Consuming the original normal response crosses its default output gate.
      // The client receives neither headers nor the response value.
      assert.equal(await count(adapted, ready, names.after, '/increment', 'POST'), 1);
      transport.afterResponsesConsumed++;
    } catch {
      transport.upstreamErrors++;
    }
    request.socket.destroy();
  });
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await bounded(
    new Promise((done, fail) => {
      proxy.once('error', fail);
      proxy.listen(0, '127.0.0.1', done);
    }),
  );
  const port = proxy.address().port;
  const beforeLossMeters = {
    before: await meter(adapted, ready, names.before),
    after: await meter(adapted, ready, names.after),
  };
  stage = 'network-before-drop';
  assert.equal(await unavailable(`http://127.0.0.1:${port}/before`), true);
  stage = 'network-after-drop';
  assert.equal(await unavailable(`http://127.0.0.1:${port}/after`), true);
  stage = 'transport-attempts';
  assert.deepEqual(transport, {
    beforeAttempts: 1,
    beforeDelegations: 0,
    afterAttempts: 1,
    afterDelegations: 1,
    afterResponsesConsumed: 1,
    upstreamErrors: 0,
  });
  const afterLossMeters = {
    before: await meter(adapted, ready, names.before),
    after: await meter(adapted, ready, names.after),
  };
  assert.deepEqual(afterLossMeters.before, beforeLossMeters.before);
  assert.deepEqual(afterLossMeters.after, {
    ...beforeLossMeters.after,
    get: beforeLossMeters.after.get + 1,
    put: beforeLossMeters.after.put + 1,
  });
  stage = 'source-after-loss';
  const beforeAfterLoss = await sample(adapted, ready, names.before);
  const afterAfterLoss = await sample(adapted, ready, names.after);
  assert.equal(beforeAfterLoss.state.value, 0);
  assert.equal(afterAfterLoss.state.value, 1);
  assert.equal((await meter(adapted, ready, names.before)).put, 0);
  assert.equal((await meter(adapted, ready, names.after)).put, 1);

  stage = 'actual-eviction';
  await bounded(
    adapted.unsafeEvictDurableObject('counter', 'EvidenceCounter', { name: names.before }),
  );
  await bounded(
    adapted.unsafeEvictDurableObject('counter', 'EvidenceCounter', { name: names.after }),
  );
  const beforeAfterEviction = await sample(adapted, ready, names.before);
  const afterAfterEviction = await sample(adapted, ready, names.after);
  assert.equal(beforeAfterEviction.state.value, 0);
  assert.equal(afterAfterEviction.state.value, 1);
  const resumedMeters = {
    before: await meter(adapted, ready, names.before),
    after: await meter(adapted, ready, names.after),
  };
  assert.equal(resumedMeters.before.get, 1);
  assert.equal(resumedMeters.after.get, 1);
  assert.equal(resumedMeters.before.put, 0);
  assert.equal(resumedMeters.after.put, 0);
  for (const counts of Object.values(resumedMeters)) {
    for (const [key, value] of Object.entries(counts)) if (key !== 'get') assert.equal(value, 0);
  }

  stage = 'volatile-state-negative-control';
  const controlName = randomUUID();
  assert.equal(await count(memory, memoryReady, controlName, '/increment', 'POST'), 1);
  const controlBeforeEviction = await count(memory, memoryReady, controlName);
  await bounded(memory.unsafeEvictDurableObject('counter', 'MemoryCounter', { name: controlName }));
  const controlAfterEviction = await count(memory, memoryReady, controlName);
  assert.equal(controlBeforeEviction, 1);
  assert.equal(controlAfterEviction, 0);

  stage = 'bounded-offline-artifacts';
  const cases = [
    ['before-loss.json', [beforeInitial, beforeAfterLoss, beforeAfterEviction]],
    ['after-loss.json', [afterInitial, afterAfterLoss, afterAfterEviction]],
  ];
  const artifacts = [];
  for (const [file, samples] of cases) {
    let recording = codec.start(samples[0], version);
    for (const value of samples.slice(1)) recording = codec.append(recording, value);
    recording = codec.finish(recording, 'stopped', Date.now());
    const exported = await codec.exportSamples(recording);
    const imported = await codec.importSamples(exported.json);
    assert.deepEqual(imported, exported.artifact);
    assert.deepEqual(
      imported.samples.map((row) => row.state.value),
      samples.map((row) => row.state.value),
    );
    for (const privateValue of Object.values(names)) assert(!exported.json.includes(privateValue));
    await atomic(file, exported.json);
    artifacts.push({
      file,
      bytes: Buffer.byteLength(exported.json),
      contentHash: imported.contentHash,
      values: samples.map((row) => row.state.value),
    });
  }
  const fence = resolve(directory, 'offline-fence.mjs');
  await writeFile(
    fence,
    `import http from 'node:http';\nimport https from 'node:https';\nimport net from 'node:net';\nimport tls from 'node:tls';\nimport {syncBuiltinESMExports} from 'node:module';\nconst denied=()=>{throw new Error('Network forbidden during inspection');};\nglobalThis.fetch=denied;\nfor(const module of [http,https]) {module.request=denied;module.get=denied;}\nnet.connect=denied;net.createConnection=denied;net.Socket.prototype.connect=denied;tls.connect=denied;\nsyncBuiltinESMExports();\n`,
  );
  for (const artifact of artifacts) {
    const output = await bounded(
      run(
        process.execPath,
        [
          '--import',
          fence,
          resolve(root, 'examples/counter-evidence/inspect.mjs'),
          resolve(directory, artifact.file),
        ],
        { timeout: 5000, maxBuffer: 4096 },
      ),
    );
    assert.equal(output.stderr, '');
    assert(output.stdout.includes('Coverage: discrete-read-samples; samples: 3'));
    assert(
      output.stdout.includes(
        `Observed value: first ${artifact.values[0]}; last ${artifact.values.at(-1)};`,
      ),
    );
    assert(output.stdout.includes(`Content SHA-256: ${artifact.contentHash}`));
  }
  result = {
    schemaVersion: 1,
    kind: 'edgelab-counter-portability-proof',
    measuredAt: new Date().toISOString(),
    producerVersion: version,
    environment: {
      node: process.versions.node,
      esbuild: esbuildVersion,
      miniflare: JSON.parse(await readFile(resolve(root, 'node_modules/miniflare/package.json')))
        .version,
      compatibilityDate: '2026-09-01',
      storage: 'Ephemeral local workerd SQLite DO using asynchronous KV API',
    },
    upstream: provenance,
    builds: {
      original: { sha256: bareBuild.sha256, inputs: bareBuild.inputs },
      adapter: { sha256: adaptedBuild.sha256, inputs: adaptedBuild.inputs },
      memoryControl: { sha256: memoryBuild.sha256, inputs: memoryBuild.inputs },
    },
    routeParity: parity,
    transport,
    artifacts,
    sampling: {
      samplesPerCase: 3,
      additionalKVGetCallsPerSample: 1,
      additionalKVWritesPerSample: 0,
      explicitAlarmOrSyncMethodsPerSample: 0,
      diagnosticMeterRPCsPerMeasuredSample: 2,
      resumedMeters,
      beforeLossMeters,
      afterLossMeters,
      scope: 'Attempted logical storage methods, not SQL rows or billed work',
    },
    negativeControl: {
      kind: 'intentional-memory-only-substitute',
      separateRuntime: true,
      valueBeforeEviction: controlBeforeEviction,
      valueAfterEviction: controlAfterEviction,
      persistenceRequirementSatisfied: false,
      upstreamDefect: false,
    },
    boundaries: {
      externalAuthoredExample: true,
      originalMutationSourceUnchanged: true,
      realLocalNetworkLoss: true,
      actualForcedEviction: true,
      offlineInspectorNetworkBlocked: true,
      retries: 0,
      productionOrAccountCalls: 0,
      nativeCommitTimestamp: null,
      deterministicReexecution: false,
      perCommandAttribution: false,
      exactlyOnceExecution: false,
      externalAdoption: false,
      fasterDiagnosisMeasured: false,
    },
  };
} catch (error) {
  process.exitCode = 1;
  const line = /counter-portability\.mjs:(\d+)/.exec(String(error?.stack))?.[1] ?? 'unavailable';
  console.error(`Counter portability proof failed at ${stage}, recipe line ${line}.`);
} finally {
  for (const socket of sockets) socket.destroy();
  if (proxy)
    await bounded(new Promise((done) => proxy.close(done)), 5000, true).catch(() => {
      process.exitCode = 1;
    });
  const cleanup = await Promise.allSettled(
    runtimes.map((mf) => bounded(mf.dispose(), 10000, true)),
  );
  disposed = cleanup.every((entry) => entry.status === 'fulfilled');
  if (!disposed) process.exitCode = 1;
  if (result && !process.exitCode) {
    try {
      for (const [path, hash] of sourceHashes)
        assert.equal(sha(await readFile(resolve(root, path))), hash);
      result.testedSources = [...sourceHashes]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, sha256]) => ({ path, sha256 }));
      result.sourceHashesStableAfterDisposal = true;
      result.runtimesDisposed = true;
      await atomic('result.json', result);
      console.log(
        'PASS unchanged external counter, two real response-loss cases, read-only samples, actual eviction and offline inspection',
      );
    } catch {
      process.exitCode = 1;
      console.error('Counter portability proof failed during final evidence validation.');
    }
  }
  if (process.exitCode) {
    for (const name of ['result.json', 'before-loss.json', 'after-loss.json'])
      await rm(resolve(directory, name), { force: true });
  }
}
