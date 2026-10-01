import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build, version as viteVersion } from 'vite';

// Fixed local build comparison: no URL, credentials, browser, runtime, remote
// checkout/fetch, application execution, dist write, or configurable baseline.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const baselineCommit = 'a55bbe8750ac6d3e225d80aaeeee4143da702dee';
const baselinePublicationCommit = '4bde8b6b160dd04ee66fe62af743dabfe5d21c3d';
const baselineArchivePath = 'docs/evidence/releases/3.10.0-live-monitoring.json';
const directory = 'output/client-build';
const recipe = 'scripts/client-build.mjs';
const maxFiles = 128;
const maxFileBytes = 1024 * 1024;
const maxSnapshotBytes = 4 * 1024 * 1024;
const selections = [
  'src',
  'worker',
  'index.html',
  'public',
  'vite.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
];
const allowedLockVersionFields = ['version', "packages[''].version"];
const routeModules = {
  operations: 'src/Operations.tsx',
  replay: 'src/ReplayRoute.tsx',
  observer: 'src/LabObserver.tsx',
  guide: 'src/Guide.tsx',
};
const deferredModules = [
  ...Object.values(routeModules),
  'src/LabReplay.tsx',
  'src/BriefExamples.tsx',
  'src/RuntimeEvidence.tsx',
  'src/brief-examples-data.json',
  'src/data/status-reuse-evidence.json',
  'src/data/lab-recording-example.json?raw',
];
const recordingPath = 'src/data/lab-recording-example.json';
const recordingContentHash = 'ee884cdcefaedcd23c22eed275ec5088852beec2b6dd8ed323381d2cc908a082';
const git = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = (value) => (typeof value === 'string' ? Buffer.from(value) : Buffer.from(value));
const read = (base, path) => readFile(resolve(base, path));
let stage = 'arguments';
let snapshot;

function safePath(path) {
  return (
    typeof path === 'string' &&
    /^[a-zA-Z0-9_./-]+$/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}
async function command(args, maxBuffer = maxFileBytes) {
  return (
    await git('git', args, {
      cwd: root,
      encoding: 'buffer',
      maxBuffer,
      timeout: 10000,
      windowsHide: true,
    })
  ).stdout;
}
async function inventory(base) {
  const paths = [];
  async function visit(path) {
    const entries = await readdir(resolve(base, path), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      assert(!entry.isSymbolicLink(), 'Source snapshot must not follow symbolic links');
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) paths.push(child);
      else assert.fail('Source snapshot contains an unsupported entry');
    }
  }
  for (const path of ['src', 'worker', 'public']) await visit(path);
  paths.push('index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json');
  paths.sort();
  assert(paths.length <= maxFiles);
  assert(paths.every(safePath));
  assert(paths.every((path) => !/(^|\/)\./.test(path) && !/\.env($|\.)/.test(path)));
  let totalBytes = 0;
  const sourceSHA256 = {};
  for (const path of paths) {
    const source = await read(base, path);
    assert(source.length <= maxFileBytes);
    totalBytes += source.length;
    assert(totalBytes <= maxSnapshotBytes);
    sourceSHA256[path] = hash(source);
  }
  return { sourceSHA256, fileCount: paths.length, totalBytes };
}
async function baselineSnapshot() {
  // CI must provide this local Git object (checkout fetch-depth:0). This recipe
  // never fetches missing history, changes HEAD, or exports env/credential files.
  await command(['cat-file', '-e', `${baselineCommit}^{commit}`]);
  const tree = (await command(['ls-tree', '-r', '-z', baselineCommit, '--', ...selections]))
    .toString()
    .split('\0')
    .filter(Boolean);
  assert(tree.length > 0 && tree.length <= maxFiles);
  await mkdir(resolve(root, directory), { recursive: true });
  snapshot = await mkdtemp(resolve(root, `${directory}/baseline-`));
  let totalBytes = 0;
  for (const entry of tree) {
    const match = /^([0-9]+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    assert(match && ['100644', '100755'].includes(match[1]));
    const path = match[3];
    assert(safePath(path));
    assert(selections.some((selected) => path === selected || path.startsWith(`${selected}/`)));
    assert(!/(^|\/)\./.test(path) && !/\.env($|\.)/.test(path));
    const source = await command(['show', `${baselineCommit}:${path}`]);
    assert(source.length <= maxFileBytes);
    totalBytes += source.length;
    assert(totalBytes <= maxSnapshotBytes);
    await mkdir(dirname(resolve(snapshot, path)), { recursive: true });
    await writeFile(resolve(snapshot, path), source);
  }
}
async function publishedBaseline() {
  const archiveBytes = await command(
    ['show', `${baselinePublicationCommit}:${baselineArchivePath}`],
    256 * 1024,
  );
  assert(archiveBytes.length <= 256 * 1024);
  const archive = JSON.parse(archiveBytes.toString());
  assert.equal(archive.releaseContext.sourceCommit, baselineCommit);
  assert(Array.isArray(archive.deployedAssets) && archive.deployedAssets.length === 3);
  const assets = archive.deployedAssets
    .map((asset) => {
      assert(typeof asset.path === 'string' && asset.path.startsWith('/'));
      const file = asset.path === '/' ? 'index.html' : asset.path.slice(1);
      assert(safePath(file));
      assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
      assert(typeof asset.sha256 === 'string' && /^[0-9a-f]{64}$/.test(asset.sha256));
      return { file, bytes: asset.bytes, sha256: asset.sha256 };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  assert.equal(new Set(assets.map((asset) => asset.file)).size, 3);
  assert.equal(assets.filter((asset) => asset.file === 'index.html').length, 1);
  assert.equal(assets.filter((asset) => asset.file.endsWith('.js')).length, 1);
  assert.equal(assets.filter((asset) => asset.file.endsWith('.css')).length, 1);
  return {
    publicationCommit: baselinePublicationCommit,
    archivePath: baselineArchivePath,
    archiveBytes: archiveBytes.length,
    archiveSHA256: hash(archiveBytes),
    sourceCommit: baselineCommit,
    archivedAssets: assets,
  };
}
function normalizedLock(lock) {
  const normalized = structuredClone(lock);
  assert(normalized.packages && normalized.packages['']);
  delete normalized.version;
  delete normalized.packages[''].version;
  return normalized;
}
function configTarget(source) {
  // Explicit same build settings, without executing a config or loading .env.
  // Keep this intentionally small: a future config/plugin change needs review.
  const compact = source.replace(/\s+/g, '').replace(/"/g, "'");
  assert.equal(
    compact,
    "import{defineConfig}from'vite';exportdefaultdefineConfig({build:{target:'es2022'}});",
  );
  return 'es2022';
}
async function assertDependencies(base) {
  const currentPackage = JSON.parse((await read(root, 'package.json')).toString());
  const oldPackage = JSON.parse((await read(base, 'package.json')).toString());
  const currentLockBytes = await read(root, 'package-lock.json');
  const oldLockBytes = await read(base, 'package-lock.json');
  const currentLock = JSON.parse(currentLockBytes.toString());
  const oldLock = JSON.parse(oldLockBytes.toString());
  assert.equal(oldPackage.version, '3.10.0');
  assert.equal(currentLock.version, currentPackage.version);
  assert.equal(currentLock.packages[''].version, currentPackage.version);
  assert.equal(oldLock.version, oldPackage.version);
  assert.equal(oldLock.packages[''].version, oldPackage.version);
  const currentWithoutMetadata = structuredClone(currentPackage);
  const oldWithoutMetadata = structuredClone(oldPackage);
  delete currentWithoutMetadata.version;
  delete oldWithoutMetadata.version;
  delete currentWithoutMetadata.scripts;
  delete oldWithoutMetadata.scripts;
  assert.deepEqual(currentWithoutMetadata, oldWithoutMetadata);
  const oldCheck = oldPackage.scripts.check;
  const checkMarker = 'npm test && npm run build';
  assert.equal(oldCheck.split(checkMarker).length, 2);
  const approvedCheck = oldCheck.replace(
    checkMarker,
    'npm test && npm run test:assets-unit && npm run test:operator && npm run build',
  );
  for (const [name, value] of Object.entries(oldPackage.scripts))
    assert.equal(currentPackage.scripts[name], name === 'check' ? approvedCheck : value);
  assert.deepEqual(normalizedLock(currentLock), normalizedLock(oldLock));
  assert.equal(
    configTarget((await read(root, 'vite.config.ts')).toString()),
    configTarget((await read(base, 'vite.config.ts')).toString()),
  );
  assert((await read(root, 'tsconfig.json')).equals(await read(base, 'tsconfig.json')));
  return {
    currentVersion: currentPackage.version,
    baselineVersion: oldPackage.version,
    currentRawLockSHA256: hash(currentLockBytes),
    baselineRawLockSHA256: hash(oldLockBytes),
    normalizedDependencyLockSHA256: hash(JSON.stringify(normalizedLock(currentLock))),
    allowedLockVersionFields,
    allOtherLockFieldsEqual: true,
    pinnedCompilerConfigIdentical: true,
    packageDependenciesAndOtherNonScriptMetadataEqual: true,
    existingPackageScriptsEqualExceptApprovedCheckAddition: true,
    approvedPackageScriptChanges: {
      check: {
        before: oldCheck,
        after: approvedCheck,
        inserted: 'npm run test:assets-unit && npm run test:operator',
      },
    },
    addedPackageScripts: Object.keys(currentPackage.scripts)
      .filter((name) => !Object.hasOwn(oldPackage.scripts, name))
      .sort(),
  };
}
function moduleName(id, base) {
  if (id.startsWith(`${base}${sep}`)) {
    const name = relative(base, id).split(sep).join('/');
    return name.startsWith('node_modules/') ? null : name;
  }
  if (id.startsWith('\0')) return `virtual:${id.slice(1).replaceAll(base, '<root>')}`;
  return null; // installed dependency sources are described by versions/lock
}
async function compile(base) {
  let moduleGraph = [];
  const result = await build({
    root: base,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'client-build-input-evidence',
        buildEnd(error) {
          if (error) return;
          moduleGraph = [...this.getModuleIds()]
            .map((id) => {
              const name = moduleName(id, base);
              if (!name) return null;
              const info = this.getModuleInfo(id);
              const names = (ids) =>
                ids
                  .map((item) => moduleName(item, base))
                  .filter(Boolean)
                  .sort();
              return {
                id: name,
                imports: names(info.importedIds),
                dynamicImports: names(info.dynamicallyImportedIds),
              };
            })
            .filter(Boolean)
            .sort((a, b) => a.id.localeCompare(b.id));
        },
      },
    ],
    build: { target: 'es2022', write: false, manifest: false, reportCompressedSize: false },
  });
  assert(!Array.isArray(result));
  const files = new Map();
  const chunks = result.output.filter((item) => item.type === 'chunk');
  for (const item of result.output) {
    assert(safePath(item.fileName));
    assert(!files.has(item.fileName));
    const content = bytes(item.type === 'chunk' ? item.code : item.source);
    files.set(item.fileName, {
      content,
      kind: item.type === 'chunk' ? 'javascript' : 'generated-asset',
    });
  }
  // Vite write:false does not copy publicDir. Include its unchanged byte streams
  // explicitly so the maintained dist comparison is complete, including favicon.
  const publicPaths = Object.keys((await inventory(base)).sourceSHA256).filter((path) =>
    path.startsWith('public/'),
  );
  for (const path of publicPaths) {
    const name = path.slice('public/'.length);
    assert(safePath(name) && !files.has(name));
    files.set(name, { content: await read(base, path), kind: 'public-asset' });
  }
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entries = chunks.filter((chunk) => chunk.isEntry);
  assert.equal(entries.length, 1);
  const entry = entries[0].fileName;
  const graph = chunks
    .map((chunk) => {
      assert(chunk.imports.every((path) => byName.has(path)));
      assert(chunk.dynamicImports.every((path) => byName.has(path)));
      const css = [...(chunk.viteMetadata?.importedCss ?? [])].sort();
      assert(css.every((path) => files.has(path) && path.endsWith('.css')));
      return {
        file: chunk.fileName,
        entry: chunk.isEntry,
        dynamicEntry: chunk.isDynamicEntry,
        imports: [...chunk.imports].sort(),
        dynamicImports: [...chunk.dynamicImports].sort(),
        css,
        modules: Object.keys(chunk.modules)
          .map((id) => moduleName(id, base))
          .filter(Boolean)
          .sort(),
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
  const graphByName = new Map(graph.map((chunk) => [chunk.file, chunk]));
  function closure(starts, includeDynamic = false) {
    const seen = new Set();
    const visit = (name) => {
      if (seen.has(name)) return;
      const chunk = graphByName.get(name);
      assert(chunk);
      seen.add(name);
      chunk.imports.forEach(visit);
      if (includeDynamic) chunk.dynamicImports.forEach(visit);
    };
    starts.forEach(visit);
    const javascript = [...seen].sort();
    const css = [...new Set(javascript.flatMap((name) => graphByName.get(name).css))].sort();
    const total = (names) => ({
      files: names,
      bytes: names.reduce((sum, name) => sum + files.get(name).content.length, 0),
      gzipBytes: names.reduce((sum, name) => sum + gzipSync(files.get(name).content).length, 0),
    });
    return {
      javascript: total(javascript),
      css: total(css),
      modules: [...new Set(javascript.flatMap((name) => graphByName.get(name).modules))].sort(),
    };
  }
  const full = closure([entry], true);
  assert.equal(full.javascript.files.length, chunks.length);
  const routes = {};
  for (const [name, module] of Object.entries(routeModules)) {
    // The pinned eager baseline predates ReplayRoute. Its LabReplay+sample were
    // directly in main; compare that actual route, never a transformed baseline.
    const marker = name === 'replay' && base !== root ? 'src/LabReplay.tsx' : module;
    const owners = graph.filter((chunk) => chunk.modules.includes(marker));
    assert.equal(owners.length, 1);
    routes[name] = {
      routeModule: marker,
      ownerChunk: owners[0].file,
      ...closure([entry, owners[0].file]),
    };
  }
  const outputFiles = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, value]) => ({
      file,
      kind: value.kind,
      bytes: value.content.length,
      gzipBytes: gzipSync(value.content).length,
      sha256: hash(value.content),
    }));
  return {
    files,
    evidence: {
      entry,
      initialStatic: closure([entry]),
      fullReachable: full,
      routes,
      graph,
      inputModuleGraph: moduleGraph,
      outputFiles,
    },
  };
}
async function distFiles() {
  const found = [];
  async function walk(path = '') {
    const entries = await readdir(resolve(root, 'dist', path), { withFileTypes: true });
    for (const entry of entries) {
      assert(!entry.isSymbolicLink());
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else {
        assert(entry.isFile() && safePath(child));
        found.push(child);
      }
    }
  }
  await walk();
  return found.sort();
}
async function verifyDist(generated) {
  const names = await distFiles();
  assert.deepEqual(names, [...generated.keys()].sort());
  const sourceSHA256 = {};
  for (const name of names) {
    const actual = await read(root, `dist/${name}`);
    assert(actual.equals(generated.get(name).content));
    sourceSHA256[name] = hash(actual);
  }
  const emittedJavaScriptAndCss = [...generated.keys()]
    .filter((name) => /\.(js|css)$/.test(name))
    .sort();
  assert.deepEqual(
    names.filter((name) => /\.(js|css)$/.test(name)),
    emittedJavaScriptAndCss,
  );
  return { allMaintainedBytesIdentical: true, exactJavaScriptAndCssSet: true, files: sourceSHA256 };
}

async function run() {
  assert.equal(process.argv.length, 2);
  stage = 'baseline-snapshot';
  await baselineSnapshot();
  stage = 'dependency-comparison';
  const dependencies = await assertDependencies(snapshot);
  stage = 'capture-sources';
  const currentBefore = await inventory(root);
  const baselineBefore = await inventory(snapshot);
  const additionalInputs = [recipe];
  for (const path of ['scripts/asset-verification.mjs', 'scripts/verify-assets.mjs']) {
    try {
      await access(resolve(root, path));
      additionalInputs.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const additionalSourceSHA256 = Object.fromEntries(
    await Promise.all(additionalInputs.map(async (path) => [path, hash(await read(root, path))])),
  );
  const inputsCapturedBeforeBuildAt = new Date().toISOString();
  stage = 'published-baseline-archive';
  const publication = await publishedBaseline();
  const recordingCurrent = await read(root, recordingPath);
  const recordingBaseline = await read(snapshot, recordingPath);
  assert(recordingCurrent.equals(recordingBaseline));
  const recording = JSON.parse(recordingCurrent.toString());
  assert.equal(recording.contentHash, recordingContentHash);
  assert.equal(recording.producerVersion, '3.6.0');
  assert.equal(recording.entries.length, 25);
  stage = 'baseline-build';
  const baseline = await compile(snapshot);
  stage = 'published-baseline-assets';
  for (const asset of publication.archivedAssets) {
    const output = baseline.files.get(asset.file);
    assert(output);
    assert.equal(output.content.length, asset.bytes);
    assert.equal(hash(output.content), asset.sha256);
  }
  stage = 'current-build';
  const current = await compile(root);
  stage = 'deferred-graph';
  const initialModules = current.evidence.initialStatic.modules;
  assert(deferredModules.every((module) => !initialModules.includes(module)));
  for (const route of Object.values(current.evidence.routes)) {
    assert(!current.evidence.initialStatic.javascript.files.includes(route.ownerChunk));
    assert(current.evidence.fullReachable.javascript.files.includes(route.ownerChunk));
  }
  assert(
    current.evidence.routes.replay.modules.includes('src/data/lab-recording-example.json?raw'),
  );
  assert(current.evidence.routes.guide.modules.includes('src/brief-examples-data.json'));
  assert(current.evidence.routes.guide.modules.includes('src/data/status-reuse-evidence.json'));
  stage = 'maintained-dist';
  const dist = await verifyDist(current.files);
  stage = 'source-stability';
  assert.deepEqual(await inventory(root), currentBefore);
  assert.deepEqual(await inventory(snapshot), baselineBefore);
  const additionalAfter = Object.fromEntries(
    await Promise.all(additionalInputs.map(async (path) => [path, hash(await read(root, path))])),
  );
  assert.deepEqual(additionalAfter, additionalSourceSHA256);
  // The source inventories are stronger than tree-shaken output membership;
  // separately prove every actual loaded project module's backing file is covered.
  for (const [evidence, source] of [
    [current.evidence, currentBefore],
    [baseline.evidence, baselineBefore],
  ])
    for (const module of evidence.inputModuleGraph) {
      if (module.id.startsWith('virtual:')) continue;
      assert(Object.hasOwn(source.sourceSHA256, module.id.split('?')[0]));
    }
  const comparison = Object.fromEntries(
    Object.keys(routeModules).map((name) => {
      const previous = baseline.evidence.routes[name];
      const next = current.evidence.routes[name];
      const difference = (before, after) => ({
        before,
        after,
        saved: before - after,
        reductionPercent: +(((before - after) / before) * 100).toFixed(2),
      });
      return [
        name,
        {
          javascriptBytes: difference(previous.javascript.bytes, next.javascript.bytes),
          javascriptGzipBytes: difference(previous.javascript.gzipBytes, next.javascript.gzipBytes),
          cssBytes: difference(previous.css.bytes, next.css.bytes),
          cssGzipBytes: difference(previous.css.gzipBytes, next.css.gzipBytes),
        },
      ];
    }),
  );
  assert(comparison.operations.javascriptGzipBytes.saved > 0);
  assert(comparison.replay.javascriptGzipBytes.saved > 0);
  return {
    currentBefore,
    additionalInputs,
    additionalSourceSHA256,
    report: {
      schemaVersion: 1,
      kind: 'edgelab-client-build-evidence',
      measuredAt: new Date().toISOString(),
      sourceProjectVersion: dependencies.currentVersion,
      environment: {
        node: process.version,
        vite: viteVersion,
        rolldown: JSON.parse((await read(root, 'node_modules/rolldown/package.json')).toString())
          .version,
        gzip: 'node:zlib.gzipSync default options, independently for each file',
        remoteCalls: 0,
        browserCalls: 0,
        applicationRuntimeCalls: 0,
        accountCalls: 0,
      },
      buildSettings: {
        target: 'es2022',
        write: false,
        configFile: false,
        envFile: false,
        manifest: false,
      },
      provenance: {
        baselineCommit,
        publishedBaseline: { ...publication, generatedAssetBytesAndHashesMatch: true },
        inputsCapturedBeforeBuildAt,
        dependencies,
        currentSource: currentBefore,
        baselineSource: baselineBefore,
        additionalSourceSHA256,
        additionalInputsBoundary:
          'Recipe and any asset-verifier source hashes identify release evidence tooling; they are not claimed as client build inputs.',
        sourceBoundary:
          'Complete bounded src/worker/public/index/config/package/lock inventories hashed before both builds and checked afterward; actual loaded project input graph is listed separately. Both builds use the same installed runtime/dependencies through normal parent resolution. Installed binaries are not independently hashed.',
      },
      pinnedRecording: {
        sourcePath: recordingPath,
        bytes: recordingCurrent.length,
        sourceSHA256: hash(recordingCurrent),
        contentHash: recordingContentHash,
        producerVersion: '3.6.0',
        frames: 25,
        byteIdenticalToBaseline: true,
      },
      baseline: baseline.evidence,
      current: current.evidence,
      comparison,
      maintainedDist: dist,
      gates: {
        deferredModulesExcludedFromInitialStaticClosure: true,
        completeStaticAndDynamicGraph: true,
        sharedJavaScriptAndCssIncluded: true,
        sourceStableBeforeAndAfterBuilds: true,
      },
      limitations: [
        'Actual pinned3.10 source versus actual current source, built locally under equal dependency content; not a hypothetical transform or a deployed baseline timing measurement.',
        'Baseline generated HTML/entry JavaScript/CSS reproduce the frozen publication archive bytes/hashes. No fresh production fetch occurs, and the archive did not independently verify favicon.',
        'Route totals include entry plus selected route and all recursive static JavaScript dependencies, and unique CSS. Gzip is calculated independently per file; not measured transport encoding/requests, load timing, CPU, or browser behavior.',
        'Combined Architecture/Notes share the Guide chunk. Entry-only size is not the initial Operations or Replay payload.',
        'This gate does not render React or prove cleanup, navigation, chunk-load recovery, API/socket traffic, or production asset MIME/cache behavior. Those require separate checks.',
        'Pinned recording byte identity is checked against Git plus declared content hash; canonical recording validation remains in the recording/tour tests.',
      ],
    },
  };
}

let result;
let failure;
try {
  result = await run();
} catch {
  failure = { stage, code: 'check-failed' };
} finally {
  if (snapshot) {
    try {
      await rm(snapshot, { recursive: true, force: true });
      try {
        await access(snapshot);
        throw new Error('Snapshot disposal failed');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    } catch {
      failure = { stage: 'dispose-snapshot', code: 'check-failed' };
    }
  }
}
if (!failure) {
  try {
    stage = 'post-disposal-stability';
    assert.deepEqual(await inventory(root), result.currentBefore);
    assert.deepEqual(
      Object.fromEntries(
        await Promise.all(
          result.additionalInputs.map(async (path) => [path, hash(await read(root, path))]),
        ),
      ),
      result.additionalSourceSHA256,
    );
    result.report.gates.currentSourceStableAfterSnapshotDisposal = true;
    result.report.gates.baselineSnapshotDisposed = true;
    stage = 'publish-evidence';
    const serialized = JSON.stringify(result.report, null, 2) + '\n';
    assert(!serialized.includes(root));
    const file = resolve(root, `${directory}/result.json`);
    const temporary = `${file}.tmp`;
    try {
      await writeFile(temporary, serialized);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log(
      JSON.stringify({
        passed: true,
        baseline: '3.10.0',
        current: result.report.sourceProjectVersion,
        routes: 4,
        distIdentical: true,
        snapshotDisposed: true,
      }),
    );
  } catch {
    failure = { stage, code: 'check-failed' };
  }
}
if (failure) {
  // Fixed stages only; no source bodies, exception values, secrets, remote URLs,
  // bundle/code payload or temporary absolute path is printed on failure.
  console.error(JSON.stringify({ ok: false, ...failure }));
  process.exitCode = 1;
}
