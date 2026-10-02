import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = path.resolve(fixtureRoot, '../..');
const upstreamCommit = '1ef6020a42fbabb6d27dd1063db3a075ba95c974';
const upstreamPins = Object.freeze({
  'otClient.ts': [39828, 'e0463eb179c8d2e5052a171554a9d6bffdfc887ba205e9e9ce698beefdc2022b'],
  'code-change.ts': [33243, 'f5e05b64b37c90c4a5cd2eda181c7c27b6e42dc58dff71fdb69d4ec4f86f3bd7'],
  LICENSE: [10174, '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'],
});
const dependencyPins = Object.freeze({
  '@codemirror/state': {
    version: '6.7.1',
    integrity:
      'sha512-9QzNDgE4EYDnAHfrTlR2lwiPciiOymLtwKK+8yHQzCc7GXhAP9xdEbEJFy2IWB1j9UGUl9BsgMmTo/ImA02T7A==',
  },
  'fast-diff': {
    version: '1.3.0',
    integrity:
      'sha512-VxPP4NqbUjj6MaAOafWeUn2cXWLcCtljklUtZf0Ind4XQ+QPtmA0b18zZy0jIQx+ExRVCR/ZQpBmik5lXshNsw==',
  },
  '@marijn/find-cluster-break': {
    version: '1.0.3',
    integrity:
      'sha512-FY+MKLBoTsLNJF/eLWaOsXGdz6uh3Iu1axjPf6TUq92IYumcTcXWHoS747JARLkcdlJ/Waiaxc5wQfFO8jC6NA==',
  },
});

// These methods only observe existing fields/promises. The original source is
// separately pinned; this additive in-memory adaptation is not the upstream file.
const readOnlyProbes = `
  __evidenceSnapshot() {
    return Object.freeze({
      generation: this.#generation,
      appliedRevision: this.#appliedRevision,
      ready: this.#ready,
      fatal: this.#fatal,
      disposed: this.#disposed,
    });
  }
  async __evidenceDrain() {
    for (let turn = 0; turn < 64; turn++) {
      const queue = this.#queue;
      await queue;
      if (queue === this.#queue) return;
    }
    throw new Error('Controlled queue observation did not quiesce');
  }
`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (value) => value.split(path.sep).join('/');
const localName = (value) => slash(path.relative(fixtureRoot, value));
const inside = (root, value) => value === root || value.startsWith(`${root}${path.sep}`);
const publicPin = (file, bytes) => ({
  path: localName(file),
  bytes: bytes.length,
  sha256: sha256(bytes),
});

async function packageAt(entry, expectedName) {
  let directory = path.dirname(entry);
  for (let level = 0; level < 12; level++) {
    const file = path.join(directory, 'package.json');
    try {
      const bytes = await readFile(file);
      const metadata = JSON.parse(bytes);
      if (metadata.name === expectedName) return { root: directory, file, bytes, metadata };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Controlled dependency resolution failed');
}

export async function buildConsumerFixture() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 12), 'Node 22.12 or later is required');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  const originalInputs = new Map();
  const remember = async (file) => {
    const bytes = await readFile(file);
    originalInputs.set(file, bytes);
    return bytes;
  };
  const foundations = [];
  for (const relative of [
    'fixture.mjs',
    'consumer.test.mjs',
    'package.json',
    'package-lock.json',
    'upstream/provenance.json',
  ]) {
    const file = path.join(fixtureRoot, relative);
    foundations.push(publicPin(file, await remember(file)));
  }
  for (const fileName of ['package.json', 'package-lock.json']) {
    const file = path.join(projectRoot, fileName);
    const bytes = await remember(file);
    foundations.push({ path: `../../${fileName}`, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const provenance = JSON.parse(
    originalInputs.get(path.join(fixtureRoot, 'upstream/provenance.json')),
  );
  assert.equal(provenance.commit, upstreamCommit);
  const unchangedSource = [];
  for (const [name, [expectedBytes, expectedHash]] of Object.entries(upstreamPins)) {
    const file = path.join(fixtureRoot, 'upstream', name);
    const bytes = await remember(file);
    assert.equal(bytes.length, expectedBytes, 'Pinned upstream byte count differs');
    assert.equal(sha256(bytes), expectedHash, 'Pinned upstream hash differs');
    const declared = provenance.files.find((item) => item.path === name);
    assert.equal(declared?.bytes, expectedBytes);
    assert.equal(declared?.sha256, expectedHash);
    unchangedSource.push(publicPin(file, bytes));
  }

  const requireFixture = createRequire(path.join(fixtureRoot, 'package.json'));
  const stateEntry = requireFixture.resolve('@codemirror/state');
  const resolvedDependencies = [
    await packageAt(stateEntry, '@codemirror/state'),
    await packageAt(requireFixture.resolve('fast-diff'), 'fast-diff'),
    await packageAt(
      createRequire(stateEntry).resolve('@marijn/find-cluster-break'),
      '@marijn/find-cluster-break',
    ),
  ];
  const lock = JSON.parse(originalInputs.get(path.join(fixtureRoot, 'package-lock.json')));
  const dependencies = resolvedDependencies.map((dependency) => {
    const name = dependency.metadata.name;
    const expected = dependencyPins[name];
    assert.ok(inside(path.join(fixtureRoot, 'node_modules'), dependency.root));
    assert.equal(
      dependency.metadata.version,
      expected.version,
      'Installed dependency version differs',
    );
    const locked = lock.packages[localName(dependency.root)];
    assert.equal(locked?.version, expected.version, 'Locked dependency version differs');
    assert.equal(locked?.integrity, expected.integrity, 'Locked dependency integrity differs');
    originalInputs.set(dependency.file, dependency.bytes);
    return {
      name,
      version: expected.version,
      integrity: expected.integrity,
      package: publicPin(dependency.file, dependency.bytes),
    };
  });

  const loaded = new Map();
  const otFile = path.join(fixtureRoot, 'upstream/otClient.ts');
  const changeFile = path.join(fixtureRoot, 'upstream/code-change.ts');
  const buildOptions = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    treeShaking: true,
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    tsconfigRaw: { compilerOptions: {} },
  };
  const built = await esbuild.build({
    ...buildOptions,
    absWorkingDir: fixtureRoot,
    entryPoints: [otFile],
    outfile: 'consumer-bundle.mjs',
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'pinned-consumer-inputs',
        setup(build) {
          build.onResolve({ filter: /^@gadgets\// }, (args) => {
            assert.equal(
              args.path,
              '@gadgets/workshop-shared/code-change',
              'Unexpected runtime API/source import',
            );
            assert.equal(args.importer, otFile, 'Unexpected alias importer');
            return { path: changeFile };
          });
          build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
            const dependency = [...resolvedDependencies]
              .sort((a, b) => b.root.length - a.root.length)
              .find((item) => inside(item.root, args.path));
            assert.ok(
              args.path === otFile || args.path === changeFile || dependency,
              'Unexpected runtime source path',
            );
            const extension = path.extname(args.path);
            assert.ok(
              ['.ts', '.js', '.mjs', '.cjs'].includes(extension),
              'Unexpected runtime source loader',
            );
            const original = originalInputs.get(args.path) ?? (await remember(args.path));
            let supplied = original;
            if (args.path === otFile) {
              const text = original.toString('utf8');
              assert.ok(text.endsWith('\n}\n'));
              assert.equal(text.includes('__evidence'), false);
              supplied = Buffer.from(`${text.slice(0, -2)}${readOnlyProbes}}\n`);
              assert.equal(supplied.toString('utf8').replace(readOnlyProbes, ''), text);
            }
            assert.deepEqual(
              Buffer.from(supplied.toString('utf8')),
              supplied,
              'Unexpected non-UTF8 runtime source',
            );
            const record = {
              ...publicPin(args.path, original),
              suppliedBytes: supplied.length,
              suppliedSha256: sha256(supplied),
              package: dependency?.metadata.name ?? null,
            };
            if (loaded.has(args.path)) assert.deepEqual(loaded.get(args.path), record);
            loaded.set(args.path, record);
            return { contents: supplied, loader: extension === '.ts' ? 'ts' : 'js' };
          });
        },
      },
    ],
  });
  const graphNames = Object.keys(built.metafile.inputs).sort();
  assert.deepEqual(
    graphNames,
    [...loaded.keys()].map(localName).sort(),
    'Incomplete esbuild input capture',
  );
  assert.equal(graphNames.length, 5, 'Unexpected runtime input graph');
  assert.deepEqual(
    [...new Set([...loaded.values()].map((item) => item.package).filter(Boolean))].sort(),
    Object.keys(dependencyPins).sort(),
  );
  const graph = graphNames.map((name) => {
    const file = path.join(fixtureRoot, name);
    const imports = built.metafile.inputs[name].imports.map((item) => {
      assert.equal(item.external ?? false, false, 'Unexpected external runtime import');
      assert.ok(graphNames.includes(item.path), 'Unexpected runtime graph edge');
      return { path: item.path, kind: item.kind, original: item.original ?? null };
    });
    return { ...loaded.get(file), imports };
  });
  assert.equal(built.outputFiles.length, 1);
  assert.equal(Object.values(built.metafile.outputs).flatMap((item) => item.imports).length, 0);
  const code = built.outputFiles[0].contents;
  const assertStable = async () => {
    for (const [file, expected] of originalInputs) {
      assert.deepEqual(
        await readFile(file),
        expected,
        'A controlled source input changed during the proof',
      );
    }
  };
  await assertStable();
  const evidence = {
    kind: 'controlled-node-ot-model-boundary',
    environment: {
      node: process.versions.node,
      platform: process.platform,
      esbuild: esbuild.version,
    },
    upstreamCommit,
    unchangedSource,
    foundations,
    dependencies,
    buildOptions,
    adaptation: {
      methods: ['__evidenceSnapshot', '__evidenceDrain'],
      queueObservationMaxTurns: 64,
      privateStateWrites: false,
      additiveBytes: Buffer.byteLength(readOnlyProbes),
    },
    graph,
    bundle: { bytes: code.length, sha256: sha256(code) },
    runtimeApiImports: 0,
    domProvided: false,
    limitations: [
      'No full application, rendering, server, transport or remote execution.',
      'Applied revision observes the internal OT model, not downstream application acknowledgement.',
      'Controlled delegate callbacks and queue observation do not establish production timing or incident frequency.',
    ],
  };
  const directory = await mkdtemp(path.join(tmpdir(), 'edgelab-ot-consumer-'));
  let removed = false;
  try {
    const bundleFile = path.join(directory, 'consumer.mjs');
    await writeFile(bundleFile, code, { flag: 'wx' });
    const { ChatOtClient } = await import(pathToFileURL(bundleFile).href);
    assert.equal(typeof ChatOtClient, 'function');
    await assertStable();
    return {
      ChatOtClient,
      evidence,
      assertStable,
      async dispose() {
        if (!removed) {
          await rm(directory, { recursive: true, force: true });
          removed = true;
        }
        await assertStable();
        return {
          ...evidence,
          sourceHashesStableAfterRunAndDisposal: true,
          tempBundleDisposed: true,
        };
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
