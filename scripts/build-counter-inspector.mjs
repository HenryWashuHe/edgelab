import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';
import {
  COUNTER_FINALIZATION_RESERVE,
  COUNTER_RPC_SOURCE,
  COUNTER_SOURCE,
  MAX_COUNTER_ARTIFACT_BYTES,
  MAX_COUNTER_SAMPLE_BYTES,
  MAX_COUNTER_SAMPLES,
} from '../examples/counter-evidence/codec.mjs';
import { MAX_UNIQUE_JSON_BYTES, MAX_UNIQUE_JSON_DEPTH } from '../worker/unique-json.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = resolve(root, 'output/counter-inspector');
const inputs = [
  'examples/counter-evidence/codec.mjs',
  'examples/counter-evidence/inspect.mjs',
  'worker/unique-json.mjs',
];
const foundations = ['scripts/build-counter-inspector.mjs', 'package.json', 'package-lock.json'];
const externalImports = ['node:crypto', 'node:fs/promises', 'node:url'];
const outputNames = ['inspect-counter.mjs', 'manifest.json'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const buildOptions = {
  entryPoints: ['examples/counter-evidence/inspect.mjs'],
  outfile: 'inspect-counter.mjs',
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  packages: 'bundle',
  external: ['node:*'],
  splitting: false,
  sourcemap: false,
  minify: false,
  metafile: true,
  tsconfigRaw: {},
  logLevel: 'silent',
};

class CounterInspectorBuildError extends Error {
  constructor(stage) {
    super(`Counter inspector build failed at ${stage}.`);
    this.name = 'CounterInspectorBuildError';
    this.stage = stage;
  }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Build the fixed local inspector without writing files or executing it. */
export async function buildCounterInspector() {
  let stage = 'arguments';
  try {
    assert.equal(arguments.length, 0);
    const pins = new Map();
    async function pin(path) {
      assert([...inputs, ...foundations].includes(path));
      const bytes = await readFile(resolve(root, path));
      const recorded = pins.get(path);
      if (recorded) assert.equal(sha(bytes), recorded.sha256);
      else pins.set(path, { path, bytes: bytes.length, sha256: sha(bytes) });
      return bytes;
    }
    stage = 'foundation-pins';
    for (const path of foundations) await pin(path);
    const packageBytes = await pin('package.json');
    const project = JSON.parse(packageBytes.toString('utf8'));
    assert.equal(project.name, 'edgelab');
    assert.equal(typeof project.version, 'string');
    assert(
      project.version.length <= 32 &&
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(project.version),
    );
    stage = 'bundle';
    const loaded = new Set();
    const result = await build({
      ...buildOptions,
      absWorkingDir: root,
      plugins: [
        {
          name: 'pin-counter-inspector-inputs',
          setup(builder) {
            builder.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
              const path = relative(root, args.path).replaceAll('\\', '/');
              assert(inputs.includes(path));
              // The bytes hashed here are the exact bytes passed to esbuild.
              const bytes = await pin(path);
              loaded.add(path);
              return { contents: bytes, loader: 'js', resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    stage = 'bundle-shape';
    assert.deepEqual([...loaded].sort(), [...inputs].sort());
    assert.deepEqual(Object.keys(result.metafile.inputs).sort(), [...inputs].sort());
    assert.equal(result.outputFiles.length, 1);
    const outputs = Object.values(result.metafile.outputs);
    assert.equal(outputs.length, 1);
    assert(outputs[0].imports.every((item) => item.external && item.kind === 'import-statement'));
    assert.deepEqual(outputs[0].imports.map((item) => item.path).sort(), externalImports);
    const code = Buffer.from(result.outputFiles[0].contents);
    assert.equal(outputs[0].bytes, code.length);
    stage = 'source-stability';
    for (const path of [...inputs, ...foundations]) await pin(path);
    const manifest = freeze({
      schemaVersion: 1,
      kind: 'edgelab-counter-inspector-build',
      measuredAt: new Date().toISOString(),
      sourceProjectVersion: project.version,
      producerVersion: project.version,
      package: { name: project.name, version: project.version },
      environment: { node: process.versions.node, esbuild: esbuildVersion },
      buildOptions: {
        ...buildOptions,
        root: 'inferred-from-script',
        inputPinning: 'exact-onLoad-bytes',
      },
      inputs: inputs.map((path) => pins.get(path)),
      foundationPins: foundations.map((path) => pins.get(path)),
      externalImports: [...externalImports],
      bundle: { filename: outputNames[0], bytes: code.length, sha256: sha(code) },
      profiles: [
        {
          source: { ...COUNTER_SOURCE },
          declaredObservationClockOrigin: 'Durable Object after the additional KV read',
        },
        {
          source: { ...COUNTER_RPC_SOURCE },
          declaredObservationClockOrigin: 'gateway after the existing counter read RPC returns',
        },
      ],
      limits: {
        maxSamples: MAX_COUNTER_SAMPLES,
        maxArtifactBytes: MAX_COUNTER_ARTIFACT_BYTES,
        maxSampleBytes: MAX_COUNTER_SAMPLE_BYTES,
        finalizationReserveBytes: COUNTER_FINALIZATION_RESERVE,
        maxUniqueJsonBytes: MAX_UNIQUE_JSON_BYTES,
        maxUniqueJsonDepth: MAX_UNIQUE_JSON_DEPTH,
      },
      sourceHashesStableAfterBuild: true,
      boundaries: {
        recipientRuntime: 'Node.js 22.12 or newer; no npm packages required',
        runtimeExecutedDuringBuild: false,
        sourceAuthenticationEstablished: false,
        dependencyFreeExecutionVerified: false,
        renderedInteractionVerified: false,
      },
    });
    return { code, manifest };
  } catch {
    throw new CounterInspectorBuildError(stage);
  }
}

async function removeOutputs() {
  for (const name of outputNames)
    for (const path of [name, name + '.tmp']) await rm(resolve(directory, path), { force: true });
}
async function main() {
  let stage = 'output-cleanup';
  try {
    await mkdir(directory, { recursive: true });
    await removeOutputs();
    stage = 'arguments';
    assert.equal(process.argv.length, 2);
    stage = 'build';
    const { code, manifest } = await buildCounterInspector();
    stage = 'publish';
    await writeFile(resolve(directory, outputNames[0] + '.tmp'), code);
    await writeFile(
      resolve(directory, outputNames[1] + '.tmp'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    // Publish the manifest last; it is the success receipt for the bundle hash.
    for (const name of outputNames)
      await rename(resolve(directory, name + '.tmp'), resolve(directory, name));
    console.log('PASS standalone counter inspector built; runtime verification remains separate.');
  } catch (error) {
    await removeOutputs().catch(() => {});
    process.exitCode = 1;
    const failureStage = error instanceof CounterInspectorBuildError ? error.stage : stage;
    console.error(`Counter inspector build failed at ${failureStage}.`);
  }
}
// Node resolves the module's path through symlinks; argv can keep the alias.
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) await main();
