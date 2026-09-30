import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import NetworkWebSocket from 'ws';

// Actual local production classes, controlled origin, ephemeral SQLite only.
// No protocol fixture is exposed by the deployed gateway; no native/account calls.
await mkdir('output/lab-observer', { recursive: true });
const bundle = 'output/lab-observer/worker.js';
const domainBundle = 'output/lab-observer/domain.mjs';
await build({
  entryPoints: ['tests/fixtures/lab-observer.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'esnext',
  external: ['cloudflare:workers'],
});
await build({
  entryPoints: ['worker/lab-observer.ts'],
  outfile: domainBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'esnext',
});
const {
  LAB_OBSERVER_PROTOCOL: VERSION,
  LAB_OBSERVER_CAPABILITY_PREFIX: PREFIX,
  MAX_LAB_OBSERVER_FRAME_BYTES: MAX_BYTES,
  parseLabObserverFrame,
} = await import(pathToFileURL(resolve(domainBundle)).href);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['worker/index.ts', 'worker/engine.ts', 'worker/lab-observer.ts'];
const sourceSHA256 = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (path) => [path, sha(await readFile(path))])),
);
const report = {
  measuredAt: new Date().toISOString(),
  recipe: 'node scripts/lab-observer.mjs',
  runtime: 'Actual local workerd SQLite and hibernatable WebSockets via Miniflare',
  environment: {
    node: process.version,
    miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
    workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8')).version,
    ws: JSON.parse(await readFile('node_modules/ws/package.json', 'utf8')).version,
    compatibilityDate: '2026-09-01',
    productionRequests: 0,
    accountCalls: 0,
    nativeInferenceCalls: 0,
  },
  sourceSHA256,
  bundleSHA256: sha(await readFile(bundle)),
  assertions: [],
  costs: [],
  serverCloseControlFrames: [],
  touchFailureBoundaries: [],
  limitations: [
    'SQL counts are consumed cursor rowsRead/rowsWritten/statements, including SQL triggers. They exclude hidden KV SQLite work and alarm billing; KV/alarm method operations are reported separately.',
    'Controlled fixed workload only. No production account usage, global throughput, CPU, socket duration charges, natural hibernation timing or daily capacity claim.',
    'Forced hibernation uses unsafeEvictDurableObject with webSockets:hibernate; no abort or manually reconstructed production object.',
    'Observers use real WebSocket network peers against Miniflare.ready, including close and original-socket hibernation assertions. dispatchFetch is used only for HTTP requests; its in-process WebSocket bridge does not faithfully deliver server-initiated HTTP/alarm close handshakes.',
    'The ws network peer has a 500 ms close-handshake timeout. Close codes require a received server close frame; this does not measure natural TCP teardown timing in the local runtime.',
    'Faults execute and consume real SQL before throwing inside the unchanged production transactionSync. A separately committed owner touch may be published before a later action fails.',
    'A rejected production blockConcurrencyWhile resets the object and can interrupt observers with code 1006 before a terminal frame. Tests distinguish this from handled action failures that send unavailable/1011; neither confirms the failed action.',
  ],
};
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function waitFor(predicate, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail('Timed out: ' + label);
}
const catalog = () => ({
  service: 'demo-catalog',
  revision: 'controlled-origin-revision',
  generatedAt: Date.now(),
  products: [
    { sku: 'fixture-secret-product-one', available: 42 },
    { sku: 'fixture-secret-product-two', available: 18 },
  ],
});
const sum = (counts) => Object.values(counts).reduce((total, count) => total + count, 0);
function record(socket) {
  const watcher = { socket, frames: [], texts: [], closes: [], errors: [] };
  socket.addEventListener('message', ({ data }) => {
    try {
      assert.equal(typeof data, 'string');
      assert(Buffer.byteLength(data, 'utf8') <= MAX_BYTES);
      assert(watcher.frames.length < 300, 'Bounded fixture receive queue');
      const parsed = parseLabObserverFrame(data);
      assert(parsed, 'Server must emit a valid bounded frame');
      const raw = JSON.parse(data);
      for (const key of ['payload', 'cachedPayload', 'requestId', 'message', 'capability'])
        assert(!data.includes('"' + key + '"'), 'Private field in raw server frame: ' + key);
      assert(!data.includes('fixture-secret-'), 'Private origin body in server frame');
      watcher.frames.push(raw);
      watcher.texts.push(data);
    } catch (error) {
      watcher.errors.push(String(error.stack ?? error));
    }
  });
  socket.addEventListener('close', ({ code, reason }) =>
    watcher.closes.push({
      code,
      reason,
      receivedCloseFrame: socket._closeFrameReceived ?? null,
    }),
  );
  socket.addEventListener('error', ({ error }) =>
    watcher.errors.push(String(error ?? 'Socket error')),
  );
  if (typeof socket.accept === 'function') socket.accept();
  return watcher;
}
async function runtime(ttl = 20000) {
  const held = [];
  let mode = 'immediate';
  let originCalls = 0;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: 'gateway',
          modules: true,
          scriptPath: bundle,
          compatibilityDate: '2026-09-01',
          durableObjects: {
            LABS: { className: 'ReliabilityLab', useSQLite: true },
            MONITORS: { className: 'MonitorStore', useSQLite: true },
          },
          bindings: { LAB_IDLE_TTL_MS: String(ttl), AI_BRIEFS_ENABLED: 'false' },
          serviceBindings: {
            ASSETS: async () => new Response('Fixture assets', { status: 404 }),
            ORIGIN: async (request) => {
              originCalls++;
              const settings = await request.json();
              const response = (override) =>
                override === 'failure' || (override !== 'success' && settings.fails)
                  ? Response.json({ error: 'Controlled origin failure' }, { status: 503 })
                  : Response.json(catalog());
              if (mode === 'held')
                return new Promise((done) => held.push((override) => done(response(override))));
              return response();
            },
          },
        },
      ],
    }),
  );
  const namespace = await mf.getDurableObjectNamespace('LABS', 'gateway');
  const sockets = [];
  const stub = (id) => namespace.get(namespace.idFromName(id));
  const control = async (id, action, body) => {
    const response = await stub(id).fetch('https://lab.internal/__fixture/' + action, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const call = async (id, action, body) => {
    const response = await mf.dispatchFetch('https://edgelab.example/api/' + action, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Lab-ID': id, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const handshake = (id, options = {}) => {
    const headers = {
      Upgrade: 'websocket',
      Origin: 'https://edgelab.example',
      'Sec-WebSocket-Protocol': `${VERSION}, ${PREFIX}${id}`,
      ...options.headers,
    };
    for (const [key, value] of Object.entries(headers)) if (value === null) delete headers[key];
    return mf.dispatchFetch('https://edgelab.example/api/observe' + (options.search ?? ''), {
      method: options.method ?? 'GET',
      headers,
    });
  };
  const connect = async (id, options) => {
    const ready = await mf.ready;
    const url = new URL('/api/observe', ready);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new NetworkWebSocket(url, [VERSION, PREFIX + id], {
      origin: ready.origin,
      headers: options?.headers,
      closeTimeout: 500,
    });
    const watcher = record(socket);
    sockets.push(watcher);
    await new Promise((done, reject) => {
      socket.once('open', done);
      socket.once('error', reject);
      socket.once('unexpected-response', (_, response) =>
        reject(new Error('Unexpected network handshake: ' + response.statusCode)),
      );
    });
    assert.equal(socket.protocol, VERSION);
    assert(!socket.protocol.includes(id));
    await waitFor(() => watcher.frames.length === 1 || watcher.errors.length, 'initial snapshot');
    assert.deepEqual(watcher.errors, []);
    assert.equal(watcher.frames[0].kind, 'snapshot');
    return watcher;
  };
  return {
    mf,
    stub,
    control,
    call,
    handshake,
    connect,
    held,
    originCalls: () => originCalls,
    mode: (next) => (mode = next),
    storage: (id) => mf.unsafeGetDurableObjectStorage('gateway', 'ReliabilityLab', { name: id }),
    async close(watcher) {
      watcher.socket.close(1000, 'Fixture finished');
      await waitFor(() => watcher.closes.length, 'normal close');
    },
    async dispose() {
      held.splice(0).forEach((release) => release('failure'));
      for (const watcher of sockets) {
        try {
          watcher.socket.close(1000, 'Fixture finished');
        } catch {
          // Disposed/expired peers already need no close.
        }
      }
      await mf.dispose();
    },
  };
}
const proof = (message) => {
  report.assertions.push(message);
  console.log('PASS ' + message);
};
const assertServerClose = (watcher, code) => {
  assert.equal(watcher.closes[0]?.code, code);
  assert.equal(watcher.closes[0]?.receivedCloseFrame, true, 'Actual server close control frame');
  report.serverCloseControlFrames.push({ code, received: true });
};
const stateOf = (inspection) => JSON.parse(inspection.state[0].value);
const updatesOf = (watcher) => watcher.frames.filter((frame) => frame.kind === 'update');
async function settle(runtime, id, watchers) {
  const inspection = await runtime.control(id, 'inspect');
  const revision = stateOf(inspection).revision;
  await waitFor(
    () => watchers.every((watcher) => watcher.frames.at(-1)?.revision === revision),
    'watchers reach committed source revision',
  );
  for (const watcher of watchers) assert.deepEqual(watcher.errors, []);
  return inspection;
}

try {
  const lab = await runtime();
  try {
    const id = randomUUID();
    for (const [options, expected] of [
      [{ method: 'POST', headers: { Upgrade: null } }, 405],
      // Undici rejects arbitrary Upgrade values before dispatch. Omitting the
      // header exercises the production gateway's actual426 boundary instead.
      [{ headers: { Upgrade: null } }, 426],
      [{ headers: { Origin: '' } }, 403],
      [{ headers: { Origin: 'https://other.example' } }, 403],
      [{ headers: { 'Sec-WebSocket-Protocol': VERSION } }, 400],
      [{ headers: { 'Sec-WebSocket-Protocol': `${PREFIX}${id}, ${VERSION}` } }, 400],
      [{ headers: { 'Sec-WebSocket-Protocol': `${VERSION}, ${PREFIX}${id}, extra` } }, 400],
      [{ headers: { 'Sec-WebSocket-Protocol': `${VERSION}, ${PREFIX}not-a-uuid` } }, 400],
      [{ headers: { 'Sec-WebSocket-Protocol': 'x'.repeat(129) } }, 400],
      [{ search: '?capability=' + id }, 400],
    ]) {
      await lab.mf.dispatchFetch('https://edgelab.example/__fixture/gateway', { method: 'POST' });
      const response = await lab.handshake(id, options);
      assert.equal(response.status, expected);
      if (expected === 405) assert.equal(response.headers.get('Allow'), 'GET');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      await response.text();
      const touched = await lab.mf.dispatchFetch('https://edgelab.example/__fixture/gateway');
      assert.equal((await touched.json()).namespaceCalls, 0);
    }
    proof(
      'Gateway rejects method, upgrade, Origin, protocol/UUID and query capability before namespace access',
    );

    const absent = await lab.handshake(id);
    assert.equal(absent.status, 404);
    await absent.text();
    const unknown = await lab.control(id, 'inspect');
    assert.deepEqual(unknown.state, []);
    assert.deepEqual(unknown.events, []);
    assert.equal(unknown.expiresAt, null);
    assert.equal(unknown.alarmAt, null);
    report.costs.push({ operation: 'unknown-observer-cold', ...(await lab.control(id, 'meter')) });
    proof('Unknown observer cannot create a source run, deadline or alarm');

    assert.equal(
      (await lab.call(id, 'config', { originLatencyMs: 20, originTimeoutMs: 1000 })).status,
      200,
    );
    const before = await lab.control(id, 'inspect');
    await lab.control(id, 'meter-reset', {});
    const alpha = await lab.connect(id, {
      headers: {
        Authorization: 'Bearer fixture-secret-observer-token',
        Cookie: 'fixture-secret-observer-cookie',
        'X-Lab-ID': randomUUID(),
        'X-Fixture-Custom': 'fixture-secret-extra-header',
      },
    });
    const forwarded = (await lab.control(id, 'inspect')).observerHeaderNames;
    for (const name of ['authorization', 'cookie', 'x-lab-id', 'x-fixture-custom'])
      assert(!forwarded.includes(name), 'Unnecessary credential/custom header forwarded to DO');
    const handshakeCost = await lab.control(id, 'meter');
    report.costs.push({ operation: 'existing-observer-handshake', ...handshakeCost });
    assert.equal(handshakeCost.sql.rowsWritten, 0);
    assert.equal(handshakeCost.operations.kvPut, 0);
    assert.equal(handshakeCost.operations.alarmSet, 0);
    const beta = await lab.connect(id);
    const after = await lab.control(id, 'inspect');
    assert.deepEqual(after.state, before.state);
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.alarmAt, before.alarmAt);
    assert.deepEqual({ ...alpha.frames[0], now: 0 }, { ...beta.frames[0], now: 0 });
    proof(
      'Two upgrade 101 sockets select only version protocol; allowlisted forwarding drops unrelated credentials; attach never renews source/TTL/alarm',
    );

    lab.mode('held');
    const first = lab.call(id, 'request', {});
    const second = lab.call(id, 'request', {});
    await waitFor(() => lab.held.length === 2, 'two real held origin calls');
    await settle(lab, id, [alpha, beta]);
    assert.equal(alpha.frames.at(-1).state.total, 2);
    assert.equal(sum(alpha.frames.at(-1).state.counts), 0);
    lab.held.shift()('success');
    lab.held.shift()('success');
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    await settle(lab, id, [alpha, beta]);
    assert.equal(alpha.frames.at(-1).state.counts.origin, 2);
    assert.deepEqual(updatesOf(alpha), updatesOf(beta));
    for (let index = 1; index < alpha.frames.length; index++)
      assert(alpha.frames[index].revision > alpha.frames[index - 1].revision);
    assert(alpha.frames.some((frame) => frame.state.total === 2 && sum(frame.state.counts) === 0));
    proof(
      'Two clients receive identical ordered committed admission/pending/outcome frames under concurrent origin work',
    );

    const third = await lab.connect(id);
    const fourth = await lab.connect(id);
    const capacityBefore = await lab.control(id, 'inspect');
    const fifth = await lab.handshake(id);
    assert.equal(fifth.status, 429);
    await fifth.text();
    const capacityAfter = await lab.control(id, 'inspect');
    assert.deepEqual(capacityAfter, capacityBefore);
    assert.equal(capacityAfter.attachments.length, 4);
    const oldBoot = capacityAfter.bootId;
    await lab.mf.unsafeEvictDurableObject('gateway', 'ReliabilityLab', {
      name: id,
      webSockets: 'hibernate',
    });
    assert.equal(alpha.closes.length, 0);
    assert.equal(beta.closes.length, 0);
    const restored = await lab.control(id, 'inspect');
    assert.notEqual(restored.bootId, oldBoot);
    assert.deepEqual(restored.attachments, capacityBefore.attachments);
    lab.mode('immediate');
    assert.equal((await lab.call(id, 'config', { capacity: 8 })).status, 200);
    await settle(lab, id, [alpha, beta, third, fourth]);
    assert.deepEqual(updatesOf(alpha), updatesOf(beta));
    for (const watcher of [alpha, beta, third, fourth]) assert.equal(watcher.closes.length, 0);
    proof(
      'Maximum 4 rejects fifth without displacement; genuine hibernation restores original sockets/attachments and HTTP mutation updates them',
    );

    const independent = randomUUID();
    await lab.call(independent, 'state');
    const other = await lab.connect(independent);
    const otherFrames = other.frames.length;
    await lab.call(id, 'config', { capacity: 9 });
    await settle(lab, id, [alpha, beta, third, fourth]);
    await sleep(30);
    assert.equal(other.frames.length, otherFrames);
    assert.notEqual(other.frames[0].runId, alpha.frames.at(-1).runId);
    await lab.close(third);
    await lab.close(fourth);
    const beforeReconnect = await lab.control(id, 'inspect');
    const reconnect = await lab.connect(id);
    assert.equal(reconnect.frames.length, 1);
    assert.equal(reconnect.frames[0].kind, 'snapshot');
    const afterReconnect = await lab.control(id, 'inspect');
    assert.deepEqual(afterReconnect.state, beforeReconnect.state);
    assert.deepEqual(afterReconnect.events, beforeReconnect.events);
    assert.equal(afterReconnect.expiresAt, beforeReconnect.expiresAt);
    assert.equal(afterReconnect.alarmAt, beforeReconnect.alarmAt);
    proof('Independent UUIDs isolate frames and reconnect supplies only a read-only snapshot');

    await lab.close(reconnect);
    for (const [message, code] of [
      [JSON.stringify({ action: 'reset' }), 1008],
      [new Uint8Array([1, 2]).buffer, 1008],
      ['x'.repeat(MAX_BYTES + 1), 1009],
    ]) {
      const watcher = await lab.connect(id);
      const source = await lab.control(id, 'inspect');
      watcher.socket.send(message);
      await waitFor(() => watcher.closes.length, 'inbound rejection');
      assertServerClose(watcher, code);
      const current = await lab.control(id, 'inspect');
      assert.deepEqual(current.state, source.state);
      assert.deepEqual(current.events, source.events);
      assert.equal(current.expiresAt, source.expiresAt);
      assert.equal(current.alarmAt, source.alarmAt);
      assert.equal(current.attachments.length, source.attachments.length - 1);
    }
    proof(
      'Commands, binary and oversized inbound messages close 1008/1009 without source writes or lease renewal',
    );

    lab.mode('held');
    const pending = lab.call(id, 'request', {});
    await waitFor(() => lab.held.length === 1, 'held request before reset');
    const oldRun = stateOf(await lab.control(id, 'inspect')).runId;
    await lab.call(id, 'reset', {});
    const reset = await settle(lab, id, [alpha, beta]);
    assert.notEqual(stateOf(reset).runId, oldRun);
    assert.equal(stateOf(reset).total, 0);
    const frameCount = alpha.frames.length;
    lab.held.shift()('success');
    assert.equal((await pending).status, 409);
    await sleep(30);
    const resetAfter = await lab.control(id, 'inspect');
    assert.deepEqual(resetAfter.state, reset.state);
    assert.deepEqual(resetAfter.events, []);
    assert.equal(alpha.frames.length, frameCount);
    proof(
      'Reset carries revision, changes run, and fences late origin without source resurrection or phantom frame',
    );

    await lab.call(id, 'config', { failureThreshold: 1, staleFallback: false });
    const early = lab.call(id, 'request', {});
    const later = lab.call(id, 'request', {});
    await waitFor(() => lab.held.length === 2, 'generation race');
    lab.held.splice(1, 1)[0]('failure');
    assert.equal((await later).status, 502);
    await settle(lab, id, [alpha, beta]);
    const opened = stateOf(await lab.control(id, 'inspect'));
    assert.equal(opened.circuit, 'open');
    lab.held.shift()('success');
    assert.equal((await early).status, 200);
    await settle(lab, id, [alpha, beta]);
    const fenced = stateOf(await lab.control(id, 'inspect'));
    assert.equal(fenced.circuit, 'open');
    assert.equal(fenced.generation, opened.generation);
    assert.equal(fenced.cachedPayload, null);
    proof('Older in-flight success cannot close a newer open generation or refresh its cache');

    await lab.call(id, 'reset', {});
    await lab.call(id, 'config', { originTimeoutMs: 100, staleFallback: false });
    const timeoutRequest = lab.call(id, 'request', {});
    await waitFor(() => lab.held.length === 1, 'timeout held origin');
    assert.equal((await timeoutRequest).status, 504);
    const timedOut = await settle(lab, id, [alpha, beta]);
    const timeoutFrames = alpha.frames.length;
    lab.held.shift()('success');
    await sleep(40);
    assert.deepEqual((await lab.control(id, 'inspect')).state, timedOut.state);
    assert.deepEqual((await lab.control(id, 'inspect')).events, timedOut.events);
    assert.equal(alpha.frames.length, timeoutFrames);
    proof(
      'Timeout outcome is committed once; late provider success cannot replace its source/event/frame',
    );
  } finally {
    await lab.dispose();
  }

  // Direct source import is local-only fixture setup, never a production API.
  const legacy = await runtime();
  try {
    const id = randomUUID();
    await legacy.call(id, 'state');
    const storage = await legacy.storage(id);
    const source = stateOf(await legacy.control(id, 'inspect'));
    delete source.revision;
    delete source.committedAt;
    source.total = 20;
    source.originCalls = 20;
    source.counts.origin = 20;
    source.cachedPayload = catalog();
    source.cachedAt = Date.now();
    await storage.exec('UPDATE state SET value=? WHERE id=1', JSON.stringify(source));
    for (let index = 0; index < 20; index++)
      await storage.exec(
        'INSERT INTO events(value) VALUES(?)',
        JSON.stringify({
          at: Date.now() - 20 + index,
          latencyMs: 20,
          outcome: 'origin',
          status: 200,
          circuit: 'closed',
          originAttempted: true,
          message: 'fixture-secret-event-message',
          requestId: id,
          payload: catalog(),
          capability: id,
        }),
      );
    const before = await legacy.control(id, 'inspect');
    const watcher = await legacy.connect(id);
    assert.equal(watcher.frames[0].revision, 0);
    assert.equal(watcher.frames[0].committedAt, null);
    assert.equal(watcher.frames[0].events.length, 12);
    assert.deepEqual(
      watcher.frames[0].events.map((event) => event.id),
      [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9],
    );
    assert(!watcher.texts[0].includes(id));
    assert.deepEqual((await legacy.control(id, 'inspect')).state, before.state);
    assert.deepEqual((await legacy.control(id, 'inspect')).events, before.events);
    source.revision = 1;
    source.committedAt = Date.now() + 86400000;
    await storage.exec('UPDATE state SET value=? WHERE id=1', JSON.stringify(source));
    const malformed = await legacy.handshake(id);
    assert.equal(malformed.status, 503);
    const errorText = await malformed.text();
    assert(!errorText.includes('fixture-secret-'));
    await waitFor(
      () => watcher.closes.length,
      'malformed metadata closure: ' +
        JSON.stringify({
          kinds: watcher.frames.map((frame) => frame.kind),
          closes: watcher.closes,
          errors: watcher.errors,
          socketStates: (await legacy.control(id, 'inspect')).socketStates,
          clientState: watcher.socket.readyState,
          receivedCloseFrame: watcher.socket._closeFrameReceived,
          receivedCloseCode: watcher.socket._closeCode,
        }),
    );
    assertServerClose(watcher, 1011);
    assert.equal(watcher.frames.at(-1).kind, 'unavailable');
    assert.equal((await legacy.control(id, 'inspect')).attachments.length, 0);
    for (const metadata of [
      { revision: -1, committedAt: 'invalid' },
      { revision: 'invalid', committedAt: null },
      { revision: 1 },
      { committedAt: Date.now() },
    ]) {
      const malformedSource = { ...source };
      delete malformedSource.revision;
      delete malformedSource.committedAt;
      Object.assign(malformedSource, metadata);
      await storage.exec('UPDATE state SET value=? WHERE id=1', JSON.stringify(malformedSource));
      const beforeMalformed = await legacy.control(id, 'inspect');
      const rejected = await legacy.handshake(id);
      assert.equal(rejected.status, 503);
      const sanitized = await rejected.text();
      assert(!sanitized.includes('fixture-secret-'));
      const afterMalformed = await legacy.control(id, 'inspect');
      assert.deepEqual(afterMalformed.state, beforeMalformed.state);
      assert.deepEqual(afterMalformed.events, beforeMalformed.events);
      assert.equal(afterMalformed.expiresAt, beforeMalformed.expiresAt);
      assert.equal(afterMalformed.alarmAt, beforeMalformed.alarmAt);
    }
    proof(
      'Legacy 0/null snapshot, bounded newest 12 evidence, and raw privacy projection; malformed or partial stored metadata sanitizes unavailable without renewal',
    );
  } finally {
    await legacy.dispose();
  }

  for (const stage of ['owner-save', 'owner-alarm', 'owner-alarm-after']) {
    const fault = await runtime();
    try {
      const id = randomUUID();
      await fault.call(id, 'state');
      const watcher = await fault.connect(id);
      const before = await fault.control(id, 'inspect');
      await sleep(20);
      await fault.control(id, 'arm', { stage, reason: 'generic' });
      const result = await fault.call(id, 'state');
      assert.equal(result.status, 503);
      assert.equal(result.data.code, 'lab-storage-unavailable');
      assert(!JSON.stringify(result.data).includes('fixture-private-'));
      const after = await fault.control(id, 'inspect');
      report.touchFailureBoundaries.push({
        stage,
        revisionDelta: stateOf(after).revision - stateOf(before).revision,
        deadlineRenewed: after.expiresAt > before.expiresAt,
        alarmRenewed: after.alarmAt > before.alarmAt,
        objectReset: after.bootId !== before.bootId,
      });
      assert.deepEqual(after.events, before.events);
      assert.equal(after.alarmAt, before.alarmAt);
      assert.deepEqual(after.state, before.state, 'Interrupted touch is not confirmed durable');
      assert.equal(after.expiresAt, before.expiresAt);
      await waitFor(() => watcher.closes.length, 'owner touch concurrency-block interruption');
      assert.equal(watcher.closes[0].code, 1006);
      assert.equal(watcher.closes[0].receivedCloseFrame, false);
      assert.notEqual(after.bootId, before.bootId, 'Rejected concurrency block resets the object');
      assert.equal(watcher.frames.at(-1).kind, 'snapshot');
      assert.equal(
        updatesOf(watcher).length,
        0,
        'Failed lease setup cannot publish a confirmation',
      );
      proof(
        stage === 'owner-save'
          ? 'Executed first owner-touch save failure rolls back both source and KV deadline without a phantom update'
          : stage === 'owner-alarm'
            ? 'Alarm failure before native storage confirmation resets the unconfirmed touch without a phantom update'
            : 'Failure after awaited native alarm still precedes successful concurrency-block/output-gate completion; measured source/KV/alarm rollback and no phantom update',
      );
    } finally {
      await fault.dispose();
    }
  }

  const unknownDeadline = await runtime();
  try {
    const id = randomUUID();
    await unknownDeadline.call(id, 'request', {});
    await unknownDeadline.control(id, 'clear-deadline', {});
    const before = await unknownDeadline.control(id, 'inspect');
    const unavailable = await unknownDeadline.handshake(id);
    assert.equal(unavailable.status, 503);
    await unavailable.text();
    const afterObserve = await unknownDeadline.control(id, 'inspect');
    assert.deepEqual(afterObserve.state, before.state);
    assert.deepEqual(afterObserve.events, before.events);
    assert.equal(afterObserve.expiresAt, null);
    assert.equal(afterObserve.alarmAt, null);
    const owner = await unknownDeadline.call(id, 'state');
    assert.equal(owner.status, 200);
    const afterOwner = await unknownDeadline.control(id, 'inspect');
    assert.equal(stateOf(afterOwner).runId, stateOf(before).runId);
    assert.equal(stateOf(afterOwner).total, stateOf(before).total);
    assert.deepEqual(afterOwner.events, before.events);
    assert(afterOwner.expiresAt > Date.now());
    assert.equal(afterOwner.alarmAt, afterOwner.expiresAt);
    await unknownDeadline.control(id, 'meter-reset', {});
    await sleep(50);
    const idle = await unknownDeadline.control(id, 'meter');
    assert.deepEqual(idle.sql, { statements: 0, rowsRead: 0, rowsWritten: 0 });
    assert(Object.values(idle.operations).every((count) => count === 0));
    proof(
      'Unknown legacy deadline cannot be observed or invented; ordinary owner renewal preserves run/history, and idle observers do no source work',
    );
  } finally {
    await unknownDeadline.dispose();
  }

  for (const stage of ['config-save', 'admission-save', 'completion-save', 'event-insert']) {
    const fault = await runtime();
    try {
      const id = randomUUID();
      await fault.call(id, 'config', { originLatencyMs: 20, originTimeoutMs: 1000 });
      const watcher = await fault.connect(id);
      const before = await fault.control(id, 'inspect');
      const stateBefore = stateOf(before);
      await fault.control(id, 'arm', { stage, reason: 'generic' });
      const result = await fault.call(
        id,
        stage === 'config-save' ? 'config' : 'request',
        stage === 'config-save' ? { capacity: 7 } : {},
      );
      assert.equal(result.status, 503);
      assert.equal(result.data.code, 'lab-storage-unavailable');
      assert(!JSON.stringify(result.data).includes('fixture-private-'));
      const after = await fault.control(id, 'inspect');
      const stateAfter = stateOf(after);
      assert.equal(
        stateAfter.revision,
        stateBefore.revision + (stage === 'completion-save' || stage === 'event-insert' ? 2 : 1),
      );
      assert.equal(stateAfter.config.capacity, stateBefore.config.capacity);
      assert.deepEqual(after.events, before.events);
      assert.equal(sum(stateAfter.counts), 0);
      assert.equal(
        stateAfter.total,
        stage === 'completion-save' || stage === 'event-insert' ? 1 : 0,
      );
      await waitFor(() => watcher.closes.length, 'fault terminal closure');
      assert.equal(watcher.frames.at(-1).kind, 'unavailable');
      assertServerClose(watcher, 1011);
      assert.equal((await fault.control(id, 'inspect')).attachments.length, 0);
      const updates = watcher.frames.filter((frame) => frame.kind === 'update');
      assert.equal(updates.length, stage === 'completion-save' || stage === 'event-insert' ? 2 : 1);
      assert(updates.every((frame) => sum(frame.state.counts) === 0));
      assert.equal((await fault.control(id, 'meter')).faultsFired, 1);
      proof(
        `Actual executed/consumed ${stage} failure rolls back failed commit; prior owner touch/admission only remains observable`,
      );
    } finally {
      await fault.dispose();
    }
  }

  for (const reason of ['generic', 'read-quota', 'write-quota']) {
    const failure = await runtime();
    try {
      const id = randomUUID();
      await failure.call(id, 'state');
      const before = await failure.control(id, 'inspect');
      await failure.control(id, 'arm', { stage: 'observer-read', reason });
      const response = await failure.handshake(id);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const body = await response.json();
      assert.equal(body.code, 'lab-storage-unavailable');
      assert.equal(
        body.reason,
        reason === 'read-quota'
          ? 'daily-read-limit'
          : reason === 'write-quota'
            ? 'daily-write-limit'
            : 'storage-unavailable',
      );
      assert(!JSON.stringify(body).includes('fixture-private-'));
      const after = await failure.control(id, 'inspect');
      assert.deepEqual(after.state, before.state);
      assert.equal(after.expiresAt, before.expiresAt);
      assert.equal(after.alarmAt, before.alarmAt);
      if (reason !== 'generic') {
        const calls = (await failure.control(id, 'meter')).sql.statements;
        const repeated = await failure.handshake(id);
        assert.equal(repeated.status, 503);
        await repeated.text();
        assert.equal(
          (await failure.control(id, 'meter')).sql.statements,
          calls,
          'Quota cooldown must avoid source SQL',
        );
      }
      proof(
        `Actual observer ${reason} storage failure returns sanitized 503 without lease/source renewal`,
      );
    } finally {
      await failure.dispose();
    }
  }

  const expiry = await runtime(600);
  try {
    const id = randomUUID();
    await expiry.call(id, 'state');
    const before = await expiry.control(id, 'inspect');
    const watcher = await expiry.connect(id);
    await sleep(200);
    const reconnect = await expiry.connect(id);
    const after = await expiry.control(id, 'inspect');
    assert.equal(after.expiresAt, before.expiresAt);
    assert.equal(after.alarmAt, before.alarmAt);
    await waitFor(() => watcher.closes.length && reconnect.closes.length, 'real idle alarm', 5000);
    assertServerClose(watcher, 4001);
    assertServerClose(reconnect, 4001);
    assert.equal(watcher.frames.at(-1).kind, 'expired');
    const expired = await expiry.control(id, 'inspect');
    assert.deepEqual(expired.state, []);
    assert.deepEqual(expired.events, []);
    assert.equal(expired.expiresAt, null);
    await expiry.control(id, 'meter-reset', {});
    const missing = await expiry.handshake(id);
    assert.equal(missing.status, 404);
    await missing.text();
    const emptyCost = await expiry.control(id, 'meter');
    assert.equal(emptyCost.sql.statements, 0);
    assert.equal(emptyCost.operations.kvPut, 0);
    assert.equal(emptyCost.operations.alarmSet, 0);
    assert.equal((await expiry.call(id, 'state')).status, 200);
    assert.equal((await expiry.control(id, 'inspect')).state.length, 1);
    proof(
      'Live observer/reconnect/idle never renew owner TTL; actual alarm clears source and sends close 4001',
    );
  } finally {
    await expiry.dispose();
  }
  const pendingExpiry = await runtime();
  try {
    const id = randomUUID();
    await pendingExpiry.call(id, 'config', { originTimeoutMs: 1000 });
    const watcher = await pendingExpiry.connect(id);
    pendingExpiry.mode('held');
    const request = pendingExpiry.call(id, 'request', {});
    await waitFor(() => pendingExpiry.held.length === 1, 'origin before deadline expiry');
    await settle(pendingExpiry, id, [watcher]);
    await pendingExpiry.control(id, 'deadline', {
      expiresAt: Date.now() - 1,
      alarmAt: Date.now() + 1000,
    });
    const source = await pendingExpiry.control(id, 'inspect');
    const closed = await pendingExpiry.handshake(id);
    assert.equal(closed.status, 410);
    await closed.text();
    assert.deepEqual((await pendingExpiry.control(id, 'inspect')).state, source.state);
    pendingExpiry.held.shift()('success');
    assert.equal((await request).status, 409);
    assert.deepEqual((await pendingExpiry.control(id, 'inspect')).state, source.state);
    assert.deepEqual((await pendingExpiry.control(id, 'inspect')).events, source.events);
    await pendingExpiry.control(id, 'deadline', {
      expiresAt: Date.now() - 1,
      alarmAt: Date.now() + 100,
    });
    await waitFor(
      async () => (await pendingExpiry.control(id, 'inspect')).state.length === 0,
      'pending deadline actual alarm deletes source',
    );
    await waitFor(() => watcher.closes.length, 'expired peer close control');
    assertServerClose(watcher, 4001);
    assert.deepEqual((await pendingExpiry.control(id, 'inspect')).state, []);
    proof(
      'Expired attach 410 and late origin cannot resurrect source while idle alarm is still pending',
    );
  } finally {
    await pendingExpiry.dispose();
  }

  const renewal = await runtime();
  try {
    const id = randomUUID();
    await renewal.call(id, 'config', { originTimeoutMs: 1000 });
    const watcher = await renewal.connect(id);
    renewal.mode('held');
    const request = renewal.call(id, 'request', {});
    await waitFor(() => renewal.held.length === 1, 'origin before delayed alarm renewal');
    await settle(renewal, id, [watcher]);
    const old = stateOf(await renewal.control(id, 'inspect'));
    await renewal.control(id, 'deadline', {
      expiresAt: Date.now() - 1,
      alarmAt: Date.now() + 10000,
    });
    const owner = await renewal.call(id, 'state');
    assert.equal(owner.status, 200);
    assert.notEqual(owner.data.state.runId, old.runId);
    assert(owner.data.state.revision > old.revision);
    assert.equal(owner.data.state.total, 0);
    assert.deepEqual(owner.data.events, []);
    await waitFor(
      () => watcher.closes.length,
      'old observers close after successful expired-run replacement',
    );
    assertServerClose(watcher, 4001);
    assert(
      watcher.frames
        .filter((frame) => 'runId' in frame)
        .every((frame) => frame.runId === old.runId),
    );
    const fresh = await renewal.connect(id);
    assert.equal(fresh.frames[0].runId, owner.data.state.runId);
    renewal.held.shift()('success');
    assert.equal((await request).status, 409);
    const source = await renewal.control(id, 'inspect');
    assert.equal(stateOf(source).runId, owner.data.state.runId);
    assert.equal(stateOf(source).total, 0);
    assert.deepEqual(source.events, []);
    assert.equal(fresh.frames.length, 1);
    proof(
      'Elapsed deadline before delayed alarm becomes a new owner run; old sockets expire and old permit stays 409 under renewed lease',
    );
  } finally {
    await renewal.dispose();
  }

  const recurring = [];
  for (const watchers of [0, 1, 4]) {
    const cost = await runtime();
    try {
      const id = randomUUID();
      await cost.call(id, 'config', { originLatencyMs: 20, originTimeoutMs: 1000, capacity: 8 });
      const clients = [];
      await cost.control(id, 'meter-reset', {});
      for (let index = 0; index < watchers; index++) clients.push(await cost.connect(id));
      report.costs.push({
        operation: 'warm-handshakes',
        watchers,
        ...(await cost.control(id, 'meter')),
      });
      await cost.control(id, 'meter-reset', {});
      await cost.call(id, 'config', { capacity: 7 });
      await cost.call(id, 'request', {});
      await cost.call(id, 'request', {});
      await cost.call(id, 'reset', {});
      const sample = {
        operation: 'fixed-recurring-owner-workload',
        workload: 'config + two successful requests + reset; ten committed updates',
        watchers,
        ...(await cost.control(id, 'meter')),
        originCalls: cost.originCalls(),
      };
      recurring.push(sample);
      report.costs.push(sample);
      assert.equal(sample.originCalls, 2);
      if (clients.length) {
        await settle(cost, id, clients);
        for (const client of clients) {
          assert.equal(updatesOf(client).length, 10);
          assert.deepEqual(updatesOf(client), updatesOf(clients[0]));
        }
      }
    } finally {
      await cost.dispose();
    }
  }
  assert.deepEqual(
    recurring[1].sql,
    recurring[2].sql,
    'Recurring source SQL cannot scale per watcher',
  );
  assert.deepEqual(
    recurring[0].sql,
    recurring[1].sql,
    'Projection occurs once per source commit, including zero watchers',
  );
  assert.deepEqual(recurring[0].operations, recurring[1].operations);
  assert.deepEqual(recurring[1].operations, recurring[2].operations);
  proof(
    'Same fixed owner workload has identical consumed SQL and KV/alarm operation counts with 0/1/4 watchers; handshakes metered separately',
  );
  report.sourceStableDuringRun = (
    await Promise.all(
      sourceFiles.map(async (path) => sha(await readFile(path)) === sourceSHA256[path]),
    )
  ).every(Boolean);
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await writeFile('output/lab-observer-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Local observer evidence: output/lab-observer-results.json');
}
