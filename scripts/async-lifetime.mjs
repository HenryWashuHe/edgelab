import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build, version as esbuildVersion } from 'esbuild';
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselineCommit = 'c31f8f34bca1ac96d38b792287405fb4c97a6cd9';
const recipe = 'scripts/async-lifetime.mjs';
const output = 'output/async-lifetime/result.json';
const started = performance.now();
const totalLimitMs = 60000;
const sourceHashes = new Map();
const baselineHashes = new Map();
const runtimes = [];
const sha = (value) => createHash('sha256').update(value).digest('hex');
let stage = 'arguments';
let disposed = false;

function safePath(path) {
  const key = relative(root, resolve(root, path)).replaceAll('\\', '/');
  assert(key && !key.startsWith('../') && !key.includes(':'));
  return key;
}
async function pin(path) {
  const key = safePath(path);
  const value = await readFile(resolve(root, key));
  const hash = sha(value);
  if (sourceHashes.has(key)) assert.equal(hash, sourceHashes.get(key));
  sourceHashes.set(key, hash);
  return value;
}
async function bounded(promise, limitMs = 5000, cleanup = false) {
  const remaining = totalLimitMs - (performance.now() - started);
  if (!cleanup && remaining <= 0) throw new Error('deadline');
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('deadline')),
          Math.min(limitMs, cleanup ? limitMs : remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function bundle(entry, historical = false) {
  const inputsBefore = new Map();
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
          name: 'pin-tested-inputs',
          setup(builder) {
            builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
              const key = safePath(args.path);
              let contents;
              if (historical && key.startsWith('worker/')) {
                contents = execFileSync('git', ['show', `${baselineCommit}:${key}`], {
                  cwd: root,
                  timeout: 5000,
                  maxBuffer: 1048576,
                  stdio: ['ignore', 'pipe', 'ignore'],
                });
                assert(contents.byteLength <= 1048576);
                baselineHashes.set(key, sha(contents));
              } else contents = await pin(key);
              inputsBefore.set(key, sha(contents));
              return {
                contents: contents.toString('utf8'),
                loader: key.endsWith('tsx') ? 'tsx' : key.endsWith('ts') ? 'ts' : 'js',
                resolveDir: dirname(args.path),
              };
            });
          },
        },
      ],
    }),
  );
  assert.equal(built.outputFiles.length, 1);
  const inputs = Object.keys(built.metafile.inputs).sort();
  assert(inputs.length <= 128);
  for (const path of inputs) assert(inputsBefore.has(safePath(path)));
  return {
    script: built.outputFiles[0].text,
    sha256: sha(built.outputFiles[0].contents),
    inputs: [...inputsBefore]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, sha256]) => ({ path, sha256 })),
  };
}
function runtime(workers) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      workers,
    }),
  );
  runtimes.push(mf);
  return mf;
}
async function measuredCall(mf, subject, scenario) {
  const response = await bounded(
    mf.dispatchFetch(`https://fixture.example/check?subject=${subject}&scenario=${scenario}`),
  );
  assert.equal(response.status, 200);
  const data = await bounded(response.json());
  assert.deepEqual(
    Object.keys(data).sort(),
    [
      'subject',
      'scenario',
      'outcome',
      'status',
      'timeoutMs',
      'elapsedMs',
      'requests',
      'pulls',
      'deliveredBytes',
      'sourceBytes',
      'cancelCalls',
      'bodyLockedAfterObservation',
      'signalAbortedAfterObservation',
    ].sort(),
  );
  assert.equal(data.subject, subject);
  assert.equal(data.scenario, scenario);
  assert.equal(data.requests, 1);
  for (const key of [
    'elapsedMs',
    'timeoutMs',
    'requests',
    'pulls',
    'deliveredBytes',
    'sourceBytes',
    'cancelCalls',
  ])
    assert(Number.isSafeInteger(data[key]) && data[key] >= 0);
  return data;
}
function assertCurrent(sample) {
  const { subject, scenario, outcome } = sample;
  let expected;
  if (['healthy', 'exact-limit', 'split-utf8'].includes(scenario)) expected = 'good';
  else if (['oversize', 'invalid-json', 'missing-body'].includes(scenario))
    expected = subject === 'lab' ? 'invalid' : 'invalid-body';
  else if (scenario.startsWith('status-cancel') || scenario === 'network-error')
    expected =
      subject === 'lab' ? 'error' : scenario === 'network-error' ? 'network-error' : 'http-error';
  else expected = 'timeout';
  assert.equal(outcome, expected);
  assert.equal(sample.bodyLockedAfterObservation, false);
  if (scenario === 'exact-limit') assert.equal(sample.sourceBytes, 16384);
  if (scenario === 'oversize') assert.equal(sample.sourceBytes, 16385);
  if (
    scenario.startsWith('body-timeout') ||
    scenario === 'late-response' ||
    scenario === 'empty-stream'
  ) {
    assert.equal(sample.cancelCalls, 1);
    assert.equal(sample.signalAbortedAfterObservation, true);
  }
  if (scenario === 'late-response') {
    assert.equal(sample.pulls, 0);
    assert.equal(sample.deliveredBytes, 0);
  }
  if (scenario.startsWith('status-cancel')) {
    assert.equal(sample.cancelCalls, 1);
    assert.equal(sample.signalAbortedAfterObservation, false);
    if (subject === 'monitor') assert.equal(sample.status, 503);
  }
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
async function verifyStoppedRuns(mf, controller) {
  const health = await bounded(mf.dispatchFetch('https://fixture.example/api/health'));
  assert.equal(health.status, 200);
  assert.equal(
    (await health.json()).version,
    JSON.parse((await pin('package.json')).toString('utf8')).version,
  );
  const samples = [];
  for (const scenario of [
    'held-reset',
    'held-request',
    'failed-confirmation',
    'abandoned-epoch',
    'transport-loss',
  ]) {
    const capability = randomUUID();
    const events = [];
    const calls = [];
    let current = true;
    let confirmed = true;
    let finalReads = 0;
    let marked = 0;
    let busy = true;
    let settled = false;
    let displayed;
    const command = scenario === 'held-reset' ? 'reset' : 'request';
    async function api(path, body, final = false) {
      calls.push({ path: path.split('?')[0], method: body === undefined ? 'GET' : 'POST', final });
      const response = await bounded(
        mf.dispatchFetch(`https://fixture.example/api/${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'X-Lab-ID': capability, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const data = await bounded(response.json());
      if (!response.ok) throw new Error('Controlled protocol failure');
      return data;
    }
    await api('config', { originLatencyMs: 20 });
    displayed = await api('state');
    const originalRun = displayed.state.runId;
    const gate = deferred();
    const committed = deferred();
    const stopped = new AbortController();
    const action = (async () => {
      await api(command, {});
      events.push('mutation-committed');
      committed.resolve();
      await gate.promise;
      events.push('response-delivered');
      if (scenario === 'transport-loss')
        throw new DOMException('Controlled response loss', 'AbortError');
      controller.checkDemoStop(stopped.signal);
    })();
    const result = controller
      .settleLabRun(action, {
        isCurrent: () => current,
        markUnconfirmed: () => {
          marked++;
          confirmed = false;
          events.push('marked-unconfirmed');
        },
        confirmState: async () => {
          assert(current);
          assert.equal(confirmed, false);
          finalReads++;
          events.push('confirmation-start');
          const next = await api(
            scenario === 'failed-confirmation' ? 'state?fixture-fail=1' : 'state',
            undefined,
            true,
          );
          if (!current) return;
          displayed = next;
          confirmed = true;
          events.push('confirmation-applied');
        },
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        busy = false;
        settled = true;
        events.push('unlocked');
      });
    await bounded(committed.promise);
    stopped.abort();
    stopped.abort();
    events.push('stop');
    if (scenario === 'abandoned-epoch') current = false;
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(busy, true);
    assert.equal(finalReads, 0);
    gate.resolve();
    const completion = await bounded(result);
    assert.equal(busy, false);
    assert.equal(calls.filter((call) => call.method === 'POST' && call.path === command).length, 1);
    if (scenario === 'abandoned-epoch') {
      assert.equal(completion.value, 'abandoned');
      assert.equal(finalReads, 0);
      assert.equal(marked, 0);
    } else if (scenario === 'transport-loss') {
      assert.equal(completion.error?.name, 'AbortError');
      assert.equal(finalReads, 0);
      assert.equal(marked, 0);
    } else {
      assert.equal(marked, 1);
      assert.equal(finalReads, 1);
      assert(events.indexOf('response-delivered') < events.indexOf('marked-unconfirmed'));
      assert(events.indexOf('marked-unconfirmed') < events.indexOf('confirmation-start'));
      assert(events.indexOf('confirmation-start') < events.indexOf('unlocked'));
      if (scenario === 'failed-confirmation') {
        assert(completion.error instanceof Error);
        assert.equal(confirmed, false);
      } else {
        assert.equal(completion.value, 'stopped');
        assert.equal(confirmed, true);
        if (command === 'reset') {
          assert.notEqual(displayed.state.runId, originalRun);
          assert.equal(displayed.state.total, 0);
          assert.equal(displayed.events.length, 0);
        } else {
          assert.equal(displayed.state.runId, originalRun);
          assert.equal(displayed.state.total, 1);
          assert.equal(displayed.state.originCalls, 1);
          assert.equal(displayed.events.length, 1);
          assert.equal(displayed.events[0].outcome, 'origin');
          assert.equal(displayed.state.cachedPayload.service, 'demo-catalog');
        }
      }
    }
    // Diagnostic source read is explicitly separate from the controller's reads.
    const source = await api('state');
    assert.equal(source.state.total, command === 'reset' ? 0 : 1);
    assert.equal(source.state.originCalls, command === 'reset' ? 0 : 1);
    assert.equal(source.events.length, command === 'reset' ? 0 : 1);
    samples.push({
      scenario,
      command,
      result:
        completion.value ??
        (scenario === 'transport-loss' ? 'transport-error' : 'confirmation-error'),
      markedUnconfirmed: marked,
      finalReads,
      diagnosticReads: 1,
      ownerCalls: calls.length,
      postAttempts: calls.filter((call) => call.method === 'POST').length,
      commandDispatches: 1,
      replayedWrites: 0,
      confirmedAfterController:
        scenario === 'abandoned-epoch' || scenario === 'transport-loss' ? null : confirmed,
      source: {
        total: source.state.total,
        originCalls: source.state.originCalls,
        events: source.events.length,
      },
      sequence: events,
      interpretation:
        scenario === 'transport-loss'
          ? 'An unknown transport AbortError preserves its failure identity and makes no controller follow-up. The UI caller owns its unconfirmed failure state.'
          : scenario === 'abandoned-epoch'
            ? 'No abandoned controller callbacks or follow-up requests; the separate diagnostic observes the committed source.'
            : 'The actual mutation commits before its response is delivered to the controller; deliberate Stop never undoes or repeats it.',
    });
  }
  return samples;
}

async function verifyFailedBurst(mf, controller) {
  const capability = randomUUID();
  const events = [];
  let finalReads = 0;
  let marked = 0;
  let settled = false;
  let writes = 0;
  async function api(path, body) {
    if (body !== undefined) writes++;
    const response = await bounded(
      mf.dispatchFetch(`https://fixture.example/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Lab-ID': capability, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const data = await bounded(response.json());
    if (controller.isLabHttpFailure(path.split('?')[0], response.status, data)) {
      assert.equal(response.status, 429);
      assert.equal(data.code, 'lab-admission-limited');
      events.push('controlled-refusal');
      throw new Error('Controlled admission refusal');
    }
    return data;
  }
  await api('config', { originLatencyMs: 20 });
  await api('state');
  const gate = deferred();
  const committed = deferred();
  const good = (async () => {
    const result = await api('request', {});
    assert.equal(result.outcome, 'origin');
    events.push('sibling-committed');
    committed.resolve();
    await gate.promise;
    events.push('sibling-response-delivered');
  })();
  const refused = api('request?fixture-admission=1', {});
  const result = controller
    .settleLabRun(controller.settleLabBatch([good, refused]), {
      isCurrent: () => true,
      markUnconfirmed: () => {
        marked++;
      },
      confirmState: async () => {
        finalReads++;
        await api('state');
      },
    })
    .then(
      () => null,
      (error) => error,
    )
    .finally(() => {
      settled = true;
      events.push('unlocked');
    });
  await bounded(committed.promise);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(finalReads, 0);
  gate.resolve();
  assert((await bounded(result)) instanceof Error);
  assert.equal(finalReads, 0);
  assert.equal(marked, 0);
  assert.equal(writes, 3);
  assert(events.indexOf('sibling-response-delivered') < events.indexOf('unlocked'));
  const source = await api('state');
  assert.equal(source.state.total, 1);
  assert.equal(source.state.originCalls, 1);
  assert.equal(source.events.length, 1);
  return {
    scenario: 'failed-burst',
    result: 'admission-error',
    finalReads,
    markedUnconfirmed: marked,
    commandDispatches: 2,
    postAttempts: writes,
    diagnosticReads: 1,
    replayedWrites: 0,
    source: {
      total: source.state.total,
      originCalls: source.state.originCalls,
      events: source.events.length,
    },
    sequence: events,
    interpretation:
      'A test-only HTTP 429 wrapper refuses one call; another actual private-origin call commits and its delivered response is held. The actual batch/run helpers wait for that sibling and perform no automatic state read. This is not a native production admission threshold measurement.',
  };
}

async function run() {
  assert.equal(process.argv.length, 2);
  stage = 'source capture';
  const packageData = JSON.parse((await pin('package.json')).toString('utf8'));
  await pin('package-lock.json');
  await pin('tsconfig.json');
  await pin(recipe);
  await pin('src/main.tsx');
  const historical = await bundle('tests/fixtures/upstream-lifetime.ts', true);
  const maintained = await bundle('tests/fixtures/upstream-lifetime.ts');
  const gateway = await bundle('tests/fixtures/async-gateway.ts');
  const origin = await bundle('worker/origin.ts');
  const runControl = await bundle('src/lab-run-control.ts');
  const runExports = await import(
    `data:text/javascript;base64,${Buffer.from(runControl.script).toString('base64')}`
  );
  const batchControl = await bundle('src/lab-request-control.ts');
  const batchExports = await import(
    `data:text/javascript;base64,${Buffer.from(batchControl.script).toString('base64')}`
  );
  const controller = { ...runExports, ...batchExports };
  stage = 'historical runtime';
  const old = runtime([
    {
      name: 'upstream-baseline',
      modules: true,
      script: historical.script,
      compatibilityDate: '2026-09-01',
    },
  ]);
  const before = [];
  for (const subject of ['monitor', 'lab'])
    for (const scenario of [
      'healthy',
      'body-timeout',
      'body-timeout-cancel-pending',
      'late-response',
      'status-cancel-pending',
      'oversize',
    ])
      before.push(await measuredCall(old, subject, scenario));
  for (const sample of before) {
    if (sample.scenario.startsWith('body-timeout') || sample.scenario === 'late-response') {
      assert.equal(sample.outcome, 'timeout');
      assert.equal(sample.cancelCalls, 0);
      assert.equal(sample.bodyLockedAfterObservation, true);
    }
    if (sample.subject === 'lab' && sample.scenario === 'status-cancel-pending')
      assert.equal(sample.outcome, 'timeout');
    if (sample.subject === 'lab' && sample.scenario === 'oversize')
      assert.equal(sample.outcome, 'good');
  }
  stage = 'maintained runtime';
  const current = runtime([
    {
      name: 'upstream-current',
      modules: true,
      script: maintained.script,
      compatibilityDate: '2026-09-01',
    },
  ]);
  const after = [];
  for (const subject of ['monitor', 'lab'])
    for (const scenario of [
      'healthy',
      'exact-limit',
      'split-utf8',
      'oversize',
      'invalid-json',
      'missing-body',
      'network-error',
      'status-cancel-pending',
      'status-cancel-rejected',
      'body-timeout',
      'body-timeout-cancel-pending',
      'body-timeout-cancel-rejected',
      'late-response',
      'empty-stream',
    ]) {
      const sample = await measuredCall(current, subject, scenario);
      assertCurrent(sample);
      after.push(sample);
    }
  stage = 'actual lab protocol';
  const lab = runtime([
    {
      name: 'gateway',
      modules: true,
      script: gateway.script,
      compatibilityDate: '2026-09-01',
      durableObjects: { LABS: { className: 'ReliabilityLab', useSQLite: true } },
      serviceBindings: { ORIGIN: 'origin' },
      bindings: { LAB_ADMISSION_ENABLED: 'false', AI_BRIEFS_ENABLED: 'false' },
    },
    { name: 'origin', modules: true, script: origin.script, compatibilityDate: '2026-09-01' },
  ]);
  const stoppedRuns = await verifyStoppedRuns(lab, controller);
  stoppedRuns.push(await verifyFailedBurst(lab, controller));
  stage = 'runtime disposal';
  for (const mf of runtimes) await bounded(mf.dispose(), 10000, true);
  disposed = true;
  stage = 'stable source';
  for (const [path, hash] of sourceHashes)
    assert.equal(sha(await readFile(resolve(root, path))), hash);
  const result = {
    schemaVersion: 1,
    version: packageData.version,
    measuredAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      esbuild: esbuildVersion,
      miniflare: JSON.parse(
        (await readFile(resolve(root, 'node_modules/miniflare/package.json'))).toString('utf8'),
      ).version,
      compatibilityDate: '2026-09-01',
      cloudflareMetadataFetch: false,
      telemetry: false,
    },
    build: {
      memoryOnly: true,
      platform: 'neutral',
      target: 'es2022',
      format: 'esm',
      external: ['cloudflare:workers'],
      tsconfig: 'tsconfig.json',
    },
    limits: { overallMs: totalLimitMs, requestMs: 5000, disposalMs: 10000, bodyBytes: 16384 },
    baseline: {
      commit: baselineCommit,
      bundleSha256: historical.sha256,
      inputs: historical.inputs,
      testedWorkerInputs: [...baselineHashes]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, sha256]) => ({ path, sha256 })),
      samples: before,
    },
    maintained: { bundleSha256: maintained.sha256, inputs: maintained.inputs, samples: after },
    demoStop: stoppedRuns,
    bundles: {
      gateway: { sha256: gateway.sha256, inputs: gateway.inputs },
      origin: { sha256: origin.sha256, inputs: origin.inputs },
      runController: { sha256: runControl.sha256, inputs: runControl.inputs },
      batchController: { sha256: batchControl.sha256, inputs: batchControl.inputs },
    },
    sourceInputs: [...sourceHashes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, sha256]) => ({ path, sha256 })),
    proof: {
      historicalFailureReproduced: true,
      allCurrentSamplesPass: true,
      sourceStableAfterDisposal: true,
      allRuntimesDisposed: true,
    },
    interpretation: [
      'Actual workerd streams use controlled in-isolate fetch adapters that intentionally ignore AbortSignal; this does not prove a network provider stops work.',
      'The historical fixture closes orphaned source streams only after recording each failing sample. Its baseline worker sources are read from the fixed published Git commit.',
      'The body cap bounds retained bytes, not total heap, CPU or billing. Cancellation is requested without waiting for its completion.',
      'The run controller executes in Node against actual local gateway, SQLite Durable Object and private origin protocol; no React DOM or browser behavior is tested.',
      'Stopped runs make one guarded confirmation read after held successful responses settle. Reads never replay writes or undo committed mutations.',
      'No production/account calls, native inference, browser controls, external notifications or user dev-server requests occur.',
    ],
  };
  stage = 'atomic output';
  await mkdir(resolve(root, dirname(output)), { recursive: true });
  const temporary = `${resolve(root, output)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: 'w', mode: 0o600 });
    await rename(temporary, resolve(root, output));
  } finally {
    await rm(temporary, { force: true });
  }
  process.stdout.write(
    `PASS actual upstream lifetimes: ${before.length} baseline / ${after.length} maintained samples; ${stoppedRuns.length} lab stop cases; stable inputs and disposed runtimes\n`,
  );
}

try {
  await run();
} catch {
  if (!disposed)
    for (const mf of runtimes)
      try {
        await bounded(mf.dispose(), 10000, true);
      } catch {
        /* Preserve the static diagnostic. */
      }
  process.stderr.write(
    `FAIL local asynchronous lifetime check (${stage}); no provider details published\n`,
  );
  process.exitCode = 1;
}
