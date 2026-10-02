import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const root = fileURLToPath(new URL('.', import.meta.url));
const commit = '1ef6020a42fbabb6d27dd1063db3a075ba95c974';
const pins = {
  'overseer.ts': [503604, '673fa94a612b886ac38aebbe41478d69a7f77f47e62105129ba2ce0f21cfebdc'],
  'typed-storage.ts': [21120, '852ebbf6a279bb77829b05e6d7ee0672db89ffcfde3f9a63b70c5a3495de0d73'],
  LICENSE: [10174, '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'],
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

// These reviewed whole-member/schema byte spans are hardcoded for the independently pinned file.
// A changed boundary, body, encoding or line terminator fails before any runtime is started.
const fragmentPins = [
  {
    name: 'streamGeneration',
    startLine: 1357,
    endLine: 1357,
    byteStart: 62523,
    byteEnd: 62565,
    bytes: 42,
    sha256: '585034c6ed38e69bd2e43307014c412c824b7b429ec2813e166c5958002acf9c',
  },
  {
    name: '#chatSubscribers',
    startLine: 1379,
    endLine: 1379,
    byteStart: 63422,
    byteEnd: 63486,
    bytes: 64,
    sha256: 'c3b7577153f44a3bcd1696ae165d0ac62d6f1982d3c138e203d3271d6e95d4c4',
  },
  {
    name: '#chatContentCache',
    startLine: 2448,
    endLine: 2449,
    byteStart: 114131,
    byteEnd: 114273,
    bytes: 142,
    sha256: '295df26dbe866373b11b1056fcea770370f5fa8003ad1e27b4db80db91788ddf',
  },
  {
    name: '#lastChatTimestamp',
    startLine: 4917,
    endLine: 4917,
    byteStart: 233607,
    byteEnd: 233636,
    bytes: 29,
    sha256: '03a859acf315a401a07ea19a1b8992b0fa268b4c9f41f9ba4b577250da63b240',
  },
  {
    name: 'chatCodeBase',
    startLine: 2377,
    endLine: 2379,
    byteStart: 110389,
    byteEnd: 110514,
    bytes: 125,
    sha256: 'a5ad1aa582350419c445a983b1fdc1257a2758a5ebea6dacfab5701c3b6a1849',
  },
  {
    name: 'addChatSubscriber',
    startLine: 1400,
    endLine: 1402,
    byteStart: 64504,
    byteEnd: 64612,
    bytes: 108,
    sha256: 'b92d1d6b2756b11b0b84ce89b5ffebca754e0f84e3e43287bd60fbacb3797dd3',
  },
  {
    name: 'removeChatSubscriber',
    startLine: 1404,
    endLine: 1406,
    byteStart: 64613,
    byteEnd: 64727,
    bytes: 114,
    sha256: 'e58aac5ee79452251363ded692d87e24db7ed2160b3568998ed7722e53921933',
  },
  {
    name: 'listLiveChatChanges',
    startLine: 2517,
    endLine: 2521,
    byteStart: 117679,
    byteEnd: 117911,
    bytes: 232,
    sha256: 'cd503fe3d2a47dada25ba721a2f8d89e39f662be7454270baa556b74efb8fa00',
  },
  {
    name: 'emitChatChangeApplied',
    startLine: 2524,
    endLine: 2532,
    byteStart: 118002,
    byteEnd: 118375,
    bytes: 373,
    sha256: '67c0f1a5ea49e56bec6ac3e803cf34c4f521cb7ae1891427bea30475bd6cc82b',
  },
  {
    name: '#appendChatChangeRow',
    startLine: 2539,
    endLine: 2573,
    byteStart: 118831,
    byteEnd: 120047,
    bytes: 1216,
    sha256: '467f6e230725f45fd7959f31e11fbc3f10a0f70fbcb8c74f9dffbb57479993b7',
  },
  {
    name: '#retireChatChanges',
    startLine: 2578,
    endLine: 2583,
    byteStart: 120258,
    byteEnd: 120418,
    bytes: 160,
    sha256: 'dd60bc9f32f418e7b079cd4097a2529f2d1b2496b9a64b98147122144b177c97',
  },
  {
    name: 'getChatTimestamp',
    startLine: 4921,
    endLine: 4951,
    byteStart: 233761,
    byteEnd: 234971,
    bytes: 1210,
    sha256: '24a95236090b32b2f528a38576108e834c4eed8ac0b8dec306a5f8a6c5959171',
  },
  {
    name: 'subscribeToChat',
    startLine: 9874,
    endLine: 9974,
    byteStart: 449867,
    byteEnd: 453820,
    bytes: 3953,
    sha256: 'dc48eb5b001538e38e11cb3648b0a774536fcad62294ab43a54abfeef98d8936',
  },
  {
    name: 'actions',
    startLine: 1078,
    endLine: 1080,
    byteStart: 50395,
    byteEnd: 50474,
    bytes: 79,
    sha256: 'bd13e88eb4d3988ff74427aaf7d09d0c3a3c0d6d60a8ac6d44648ce7f8177fa7',
  },
  {
    name: 'chatMeta',
    startLine: 1093,
    endLine: 1100,
    byteStart: 50914,
    byteEnd: 51175,
    bytes: 261,
    sha256: '9f4611d0354195de60a958e172a8349bed7a4f038504f69ee6d9f7b501cbb263',
  },
  {
    name: 'chats',
    startLine: 1143,
    endLine: 1150,
    byteStart: 52933,
    byteEnd: 53223,
    bytes: 290,
    sha256: '5cd11c222d4848a315366ce8dfda4b7f6650fac83b7859842062a4f448b15bad',
  },
  {
    name: 'chatChanges',
    startLine: 1163,
    endLine: 1168,
    byteStart: 53828,
    byteEnd: 54071,
    bytes: 243,
    sha256: 'a67470653e866f832cd589ee5bd00465c6bb43b2f09f583cba0ce51162236e60',
  },
];
function extract(source) {
  const bytes = Buffer.from(source, 'utf8');
  const fragments = fragmentPins.map((item) => {
    const fragment = bytes.subarray(item.byteStart, item.byteEnd);
    assert.equal(fragment.length, item.bytes, 'Pinned fragment length differs');
    assert.equal(hash(fragment), item.sha256, 'Pinned fragment bytes differ');
    assert.equal(
      bytes.subarray(0, item.byteStart).toString('utf8').split('\n').length,
      item.startLine,
    );
    assert.equal(
      bytes.subarray(0, item.byteEnd).toString('utf8').split('\n').length - 1,
      item.endLine,
    );
    return { ...item };
  });
  const select = (name) => {
    const matches = fragments.filter((item) => item.name === name);
    assert.equal(matches.length, 1);
    const item = matches[0];
    return bytes.subarray(item.byteStart, item.byteEnd).toString('utf8');
  };
  const implMembers = fragments.slice(0, 12).map((item) => select(item.name));
  const subscribe = select('subscribeToChat');
  const schemas = ['actions', 'chatMeta', 'chats', 'chatChanges'].map(select);
  const generated = `
// Generated fixture context, not an upstream source file. Checked byte-selected bodies below are exact.
import { createTypedStorage, collection, keyString } from './upstream/typed-storage.ts';
class NativeRpcStub {
  constructor(target) { this.target = target; }
  [Symbol.dispose]() { this.target[Symbol.dispose](); }
}
function actionRecordToLog() { throw new Error('Action hydration is outside this controlled code-row proof'); }
export class ExtractedImpl {
  constructor(ctx) { this.ctx = ctx; this.storage = createTypedStorage(ctx.storage, { collections: { ${schemas.join('\n')} } }); }
  bumpLastActive(_now) {} // External user-DO activity propagation is not executed.
  hydrateChatMessageForClient(record) {
    if (record.type === 'action') throw new Error('Action hydration is outside this controlled code-row proof');
    return structuredClone(record);
  }
  ${implMembers.join('\n')}
  appendControlled() {
    const meta = this.storage.chatMeta.get(1);
    const revision = meta.codeBase.revision + 1;
    return this.#appendChatChangeRow(1, meta,
      { type: 'agent', id: 'controlled-fixture', name: 'Controlled fixture' },
      { 1: [['index.txt', { set: 'row-' + revision }]] }, 'agent', [], undefined);
  }
  retireControlled(throughRevision) {
    this.#retireChatChanges([...this.storage.chatChanges.list()].filter(row => row.revision <= throughRevision));
  }
  subscriberCount() { return this.#chatSubscribers.size; }
}
export class ExtractedClient {
  constructor(impl) { this.impl = impl; }
  ${subscribe}
}
`;
  return { generated, fragments };
}

export async function buildServerFixture() {
  const captured = new Map();
  const remember = async (file) => {
    const bytes = await readFile(file);
    captured.set(file, bytes);
    return bytes;
  };
  const unchangedSource = [];
  for (const [name, [bytes, sha256]] of Object.entries(pins)) {
    const file = path.join(root, 'upstream', name);
    const original = await remember(file);
    assert.equal(original.length, bytes);
    assert.equal(hash(original), sha256);
    unchangedSource.push({ path: relative(file), bytes, sha256 });
  }
  const inputFiles = [
    'fixture.mjs',
    'controller.ts',
    'server.test.mjs',
    'paired.test.mjs',
    'README.md',
    'package.json',
    'upstream/provenance.json',
  ];
  const inputs = [];
  for (const name of [...inputFiles, '../../package.json', '../../package-lock.json']) {
    const file = path.resolve(root, name);
    const bytes = await remember(file);
    inputs.push({ path: relative(file), bytes: bytes.length, sha256: hash(bytes) });
  }
  const provenance = JSON.parse(captured.get(path.join(root, 'upstream/provenance.json')));
  assert.equal(provenance.commit, commit);
  for (const [name, [bytes, sha256]] of Object.entries(pins)) {
    const declared = provenance.files.find((item) => item.path === name);
    assert.equal(declared?.bytes, bytes);
    assert.equal(declared?.sha256, sha256);
  }
  const rootLock = JSON.parse(captured.get(path.resolve(root, '../../package-lock.json')));
  const runtimePackages = [];
  for (const name of ['miniflare', 'workerd', 'esbuild']) {
    const file = path.resolve(root, '../../node_modules', name, 'package.json');
    const bytes = await remember(file);
    const metadata = JSON.parse(bytes);
    const locked = rootLock.packages[`node_modules/${name}`];
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, locked.version);
    runtimePackages.push({
      name,
      version: metadata.version,
      integrity: locked.integrity,
      path: relative(file),
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  }
  const source = captured.get(path.join(root, 'upstream/overseer.ts')).toString('utf8');
  const { generated, fragments } = extract(source);
  const generatedFile = path.join(root, 'extracted.ts');
  const originalInputs = new Map();
  const buildOptions = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    minify: false,
    sourcemap: false,
    write: false,
    external: ['cloudflare:workers'],
    tsconfigRaw: { compilerOptions: {} },
  };
  const built = await esbuild.build({
    ...buildOptions,
    absWorkingDir: root,
    entryPoints: [path.join(root, 'controller.ts')],
    outfile: 'server-bundle.mjs',
    metafile: true,
    plugins: [
      {
        name: 'exact-ast-server-fixture',
        setup(build) {
          build.onResolve({ filter: /^\.\/extracted\.ts$/ }, (args) => {
            assert.equal(args.importer, path.join(root, 'controller.ts'));
            return { path: generatedFile };
          });
          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            assert.ok(
              [
                generatedFile,
                path.join(root, 'controller.ts'),
                path.join(root, 'upstream/typed-storage.ts'),
              ].includes(args.path),
              'Unexpected executable input',
            );
            const bytes =
              args.path === generatedFile ? Buffer.from(generated) : captured.get(args.path);
            assert.ok(bytes);
            originalInputs.set(relative(args.path), {
              path: relative(args.path),
              bytes: bytes.length,
              sha256: hash(bytes),
              generated: args.path === generatedFile,
            });
            return { contents: bytes.toString('utf8'), loader: 'ts' };
          });
        },
      },
    ],
  });
  assert.deepEqual(Object.keys(built.metafile.inputs).sort(), [
    'controller.ts',
    'extracted.ts',
    'upstream/typed-storage.ts',
  ]);
  assert.equal(built.outputFiles.length, 1);
  const externalImports = Object.values(built.metafile.outputs).flatMap((item) => item.imports);
  assert.deepEqual(
    externalImports.map((item) => item.path),
    ['cloudflare:workers'],
  );
  const graph = Object.entries(built.metafile.inputs).map(([name, item]) => ({
    ...originalInputs.get(name),
    imports: item.imports,
  }));
  const code = built.outputFiles[0].contents;
  const assertStable = async () => {
    for (const [file, bytes] of captured)
      assert.deepEqual(await readFile(file), bytes, 'Fixture input changed during execution');
  };
  const evidence = {
    kind: 'controlled-native-sqlite-accepted-producer-replay',
    upstreamCommit: commit,
    environment: {
      node: process.versions.node,
      platform: process.platform,
      esbuild: esbuild.version,
      miniflare: runtimePackages.find((item) => item.name === 'miniflare').version,
      workerd: runtimePackages.find((item) => item.name === 'workerd').version,
    },
    runtimePackages,
    unchangedSource,
    inputs,
    extraction: fragments,
    generated: { bytes: Buffer.byteLength(generated), sha256: hash(generated) },
    graph,
    buildOptions,
    bundle: { bytes: code.length, sha256: hash(code) },
    runtimeOptions: {
      host: '127.0.0.1',
      port: 0,
      cf: false,
      telemetryEnabled: false,
      compatibilityDate: '2026-09-01',
      useSQLite: true,
      startupDeadlineMs: 15000,
      requestDeadlineMs: 10000,
    },
    storage: {
      implementation: 'Pinned typed-storage.ts over native SQLite DurableObjectStorage.kv',
      transactionSync: 'Native; not wrapped or substituted',
      synchronization: 'Native storage.sync before responses and before actual eviction',
      persistence: 'Ephemeral per fixture',
      eviction: 'Miniflare.unsafeEvictDurableObject',
      instanceProof:
        'Constructor-only native-KV fixture instanceOrdinal; independent of streamGeneration timestamp',
    },
    substitutions: [
      'Checked byte-selected class members and collection schemas are assembled in fixture classes; unrelated application members are omitted.',
      'appendControlled supplies fixed synthetic already-accepted rows, with no agent/tool entry point, Git reads, API validation, authorization or submission idempotency validation.',
      'Synthetic initial metadata uses chat 1, durable generation 1, revision 0 and one fixed pin.',
      'NativeRpcStub and subscriber are controlled in-process facades, not Capn Web or native RPC.',
      'Callback fulfill/reject outcomes precede the separate Node bridge into the actual OT consumer; they do not acknowledge consumer completion.',
      'External bumpLastActive user-DO propagation is a no-op; original monotonic getChatTimestamp is preserved.',
      'Message hydration is a fixed non-action identity delegate; unsupported action hydration throws.',
      'Retire/message commands exercise controlled retained-row and catch-up semantics, not actual materialization or generation transition.',
      'Constructor instanceOrdinal and subscriber-count sampler are fixture instrumentation. No extracted body or typed-storage algorithm is modified.',
    ],
    limits: [
      'No full upstream app, actual RPC transport, browser, Cloudflare account or production operation.',
      'Successful accepted-row persistence is tested, not every error/rollback/output-gate failure or full producer validation.',
      'Code-row positions do not prove editor/render completion or chat/tool delivery.',
      'No issue305 reproduction, novel diagnostic answer, demand or speed improvement is established.',
    ],
  };
  await assertStable();
  const directory = await mkdtemp(path.join(tmpdir(), 'edgelab-subscription-server-'));
  let mf;
  try {
    const bundleFile = path.join(directory, 'server.js');
    await writeFile(bundleFile, code, { flag: 'wx' });
    const script = Buffer.from(code).toString('utf8');
    assert.deepEqual(Buffer.from(script, 'utf8'), Buffer.from(code));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        telemetry: { enabled: false },
        log: new Log(LogLevel.NONE),
        host: '127.0.0.1',
        port: 0,
        unsafeInspectDurableObjects: true,
        durableObjectsPersist: path.join(directory, 'state'),
        workers: [
          {
            name: 'subscription-fixture',
            modules: true,
            script,
            compatibilityDate: '2026-09-01',
            durableObjects: { FIXTURE: { className: 'SubscriptionFixture', useSQLite: true } },
          },
        ],
      }),
    );
    let startupTimer;
    let baseUrl;
    try {
      baseUrl = await Promise.race([
        mf.ready,
        new Promise((_, reject) => {
          startupTimer = setTimeout(
            () => reject(new Error('Owned native fixture startup deadline exceeded')),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(startupTimer);
    }
    assert.equal(baseUrl.hostname, '127.0.0.1');
    assert.equal(baseUrl.protocol, 'http:');
    let disposed = false;
    const call = async (route, body, expectedStatus = 200) => {
      assert.equal(disposed, false);
      assert.ok(/^[a-z]+$/.test(route));
      const response = await fetch(new URL(route, baseUrl), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      assert.equal(
        response.status,
        expectedStatus,
        `Controlled route ${route} returned ${response.status}`,
      );
      return data;
    };
    return {
      evidence,
      call,
      assertStable,
      async evict() {
        await call('sync');
        await mf.unsafeEvictDurableObject('subscription-fixture', 'SubscriptionFixture', {
          name: 'controlled-instance',
        });
      },
      async dispose() {
        if (!disposed) {
          try {
            await mf.dispose();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
          disposed = true;
        }
        await assertStable();
        return { ...evidence, sourceStableAfterRunAndDisposal: true, tempRuntimeDisposed: true };
      },
    };
  } catch (error) {
    try {
      if (mf) await mf.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
