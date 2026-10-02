import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

// The before build substitutes only the exact old parser. Both builds execute
// the same actual MonitorStore and dependencies on native local SQLite.
const baselineCommit = '69a27ee153dace7dd7dde86d83ceb271a2ac0db2';
const parserPath = 'worker/monitor-domain.ts';
const oldParser = execFileSync('git', ['show', `${baselineCommit}:${parserPath}`]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const target = {
  id: 'catalog',
  name: 'Controlled target',
  url: 'https://origin.internal/health',
  transport: 'origin',
  assertion: 'ok-json',
};
const cases = {
  numericID: [{ ...target, id: 7 }],
  arrayURL: [{ ...target, url: [target.url] }],
  valid: [
    { ...target, id: '7' },
    { ...target, id: '8', url: 'https://origin.internal:443/health' },
  ],
};
const sourcePins = {};
const observations = {};
const recipePaths = ['scripts/monitor-targets.test.mjs', 'package.json', 'package-lock.json'];
const recipePins = Object.fromEntries(
  await Promise.all(recipePaths.map(async (path) => [path, hash(await readFile(path))])),
);
let originCalls = 0;

async function compile(before) {
  const result = await build({
    stdin: {
      contents:
        'export { MonitorStore } from "./worker/monitor"; export default { fetch() { return new Response("fixture"); } };',
      resolveDir: process.cwd(),
      sourcefile: 'monitor-targets-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    external: ['cloudflare:workers'],
    plugins: [
      {
        name: 'captured-monitor-inputs',
        setup(plugin) {
          plugin.onLoad({ filter: /\/worker\/.*\.ts$/ }, async ({ path }) => {
            const file = relative(process.cwd(), path);
            const bytes = await readFile(path);
            sourcePins[file] ??= hash(bytes);
            assert.equal(hash(bytes), sourcePins[file]);
            return {
              contents: (before && file === parserPath ? oldParser : bytes).toString('utf8'),
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    if (path === 'monitor-targets-entry.ts') continue;
    const file = relative(process.cwd(), resolve(path));
    assert(Object.hasOwn(sourcePins, file), 'Every input must be captured at build time');
    assert.equal(hash(await readFile(file)), sourcePins[file]);
  }
  return result.outputFiles[0].text;
}

async function runVariant(before) {
  const variant = before ? 'old-parser' : 'strict-parser';
  const script = await compile(before);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      host: '127.0.0.1',
      port: 0,
      unsafeInspectDurableObjects: true,
      log: new Log(LogLevel.NONE),
      workers: Object.entries(cases).map(([name, targets]) => ({
        name,
        modules: true,
        script,
        compatibilityDate: '2026-09-01',
        durableObjects: { MONITORS: { className: 'MonitorStore', useSQLite: true } },
        bindings: { MONITOR_TARGETS: JSON.stringify(targets), AI_BRIEFS_ENABLED: 'false' },
        serviceBindings: {
          ORIGIN: async () => {
            originCalls++;
            throw new Error('Read-only fixture must never probe an origin');
          },
        },
      })),
    }),
  );
  const results = { bundleSHA256: hash(script), cases: {}, disposed: false };
  const deadline = Date.now() + 15000;
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native fixture deadline exceeded')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await bounded(mf.ready);
    for (const name of Object.keys(cases)) {
      const ns = await bounded(mf.getDurableObjectNamespace('MONITORS', name));
      const stub = ns.get(ns.idFromName('operations'));
      const storage = await bounded(
        mf.unsafeGetDurableObjectStorage(name, 'MonitorStore', {
          name: 'operations',
        }),
      );
      const sql = (...args) => bounded(storage.exec(...args));
      const revisions = [];
      let rejected = false;
      for (let read = 0; read < 3; read++) {
        try {
          const response = await stub.fetch('https://monitor.internal/export', {
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(response.status, 200);
          await response.json();
        } catch (error) {
          if (before || name === 'valid') throw error;
          assert.match(
            String(error),
            name === 'numericID'
              ? /Invalid or duplicate monitor identity/
              : /Monitor target URL must be a string/,
          );
          rejected = true;
        }
        revisions.push(
          (await sql('SELECT id,revision FROM services ORDER BY id')).map((row) => ({
            id: row.id,
            revision: row.revision,
          })),
        );
      }
      const policyAttempts = [];
      if (before && name === 'numericID') {
        for (const service of [7, '7', '7.0']) {
          const response = await stub.fetch('https://monitor.internal/policy', {
            method: 'POST',
            body: JSON.stringify({ service, revision: 1, policy: { paused: true } }),
            signal: AbortSignal.timeout(10000),
          });
          const data = await response.json();
          assert.equal(response.status, 400);
          assert.equal(data.error, 'Known service and revision required');
          policyAttempts.push({ service, status: response.status });
        }
      }
      const versions = await sql(
        'SELECT service,revision FROM service_versions ORDER BY service,revision',
      );
      if (!before && name !== 'valid') {
        assert(rejected);
        assert.deepEqual(revisions, [[], [], []]);
        assert.equal(versions.length, 0);
        assert.equal((await sql('SELECT * FROM audit')).length, 0);
      } else if (name === 'numericID') {
        assert.deepEqual(
          revisions,
          Array.from({ length: 3 }, () => [{ id: '7.0', revision: 1 }]),
        );
        assert.equal(versions.length, 1);
      } else {
        const expected =
          name === 'valid'
            ? [
                { id: '7', revision: 1 },
                { id: '8', revision: 1 },
              ]
            : [{ id: 'catalog', revision: 1 }];
        assert.deepEqual(revisions, [expected, expected, expected]);
        assert.equal(versions.length, expected.length);
        await bounded(mf.unsafeEvictDurableObject(name, 'MonitorStore', { name: 'operations' }));
        const restored = await stub.fetch('https://monitor.internal/export', {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(restored.status, 200);
        await restored.json();
        assert.deepEqual(
          (await sql('SELECT id,revision FROM services ORDER BY id')).map((row) => ({
            id: row.id,
            revision: row.revision,
          })),
          expected,
        );
      }
      results.cases[name] = { rejected, revisions, versionRows: versions.length, policyAttempts };
      if (name === 'valid') {
        const response = await stub.fetch('https://monitor.internal/policy', {
          method: 'POST',
          body: JSON.stringify({ service: '7', revision: 1, policy: { paused: true } }),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, revision: 2 });
        assert.equal((await sql('SELECT revision FROM services WHERE id=?', '7'))[0].revision, 2);
        results.cases[name].validPolicyUpdateStatus = response.status;
      }
    }
    assert.equal(originCalls, 0);
  } finally {
    await mf.dispose();
    results.disposed = true;
  }
  observations[variant] = results;
}

test(
  'native SQLite reproduces a non-string monitor identity that operator policy cannot address',
  { timeout: 30000 },
  async () => {
    await runVariant(true);
  },
);
test(
  'strict parser rejects malformed configuration before enrollment and preserves valid targets across eviction',
  { timeout: 30000 },
  async () => {
    await runVariant(false);
    const after = Object.fromEntries(
      await Promise.all(
        Object.keys(sourcePins).map(async (path) => [path, hash(await readFile(path))]),
      ),
    );
    assert.deepEqual(after, sourcePins);
    const recipeAfter = Object.fromEntries(
      await Promise.all(recipePaths.map(async (path) => [path, hash(await readFile(path))])),
    );
    assert.deepEqual(recipeAfter, recipePins);
    assert.deepEqual(Object.keys(observations).sort(), ['old-parser', 'strict-parser']);
    await mkdir('output/monitor-targets', { recursive: true });
    await writeFile(
      'output/monitor-targets/evidence.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          measuredAt: new Date().toISOString(),
          baselineCommit,
          baselineParserSHA256: hash(oldParser),
          sourcePins,
          recipePins,
          sourceStableThroughDisposal: true,
          environment: {
            node: process.version,
            platform: process.platform,
            nativeLocalSQLite: true,
            miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8'))
              .version,
            esbuild: JSON.parse(await readFile('node_modules/esbuild/package.json', 'utf8'))
              .version,
            workerd: JSON.parse(await readFile('node_modules/workerd/package.json', 'utf8'))
              .version,
            originCalls,
            accountCalls: 0,
          },
          boundary:
            'Only the parser is substituted in the before build. Both variants run the same tracked MonitorStore and dependencies. Configuration is controlled, HTTP reads are uncached exports, and eviction is local native workerd. No production malformed configuration, natural failure frequency, billing or customer value is measured.',
          observations,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
