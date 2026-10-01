import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { importSamples, MAX_COUNTER_ARTIFACT_BYTES } from '../examples/counter-evidence/codec.mjs';
import { main } from '../examples/counter-evidence/inspect.mjs';
import { buildCounterInspector } from './build-counter-inspector.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = 'The local counter artifact could not be read or validated.\n';
const usage = 'Usage: node <inspector.mjs> <local-artifact.json>\n';
let buildPromise;

// These are instrumented Node API denials, not an OS sandbox. A denied call
// emits a static marker even if application code catches the thrown error.
const preload = `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => {
  process.stderr.write('Forbidden inspector API invocation.\\n');
  throw new Error('Forbidden inspector API invocation.');
};
globalThis.fetch = denied;
globalThis.WebSocket = denied;
globalThis[Symbol.for('edgelab.inspector.test-denied')] = denied;
for (const module of [http, https]) {
  module.request = denied;
  module.get = denied;
  module.createServer = denied;
}
net.connect = denied;
net.createConnection = denied;
net.createServer = denied;
net.Socket.prototype.connect = denied;
net.Server.prototype.listen = denied;
tls.connect = denied;
tls.createServer = denied;
dgram.createSocket = denied;
for (const method of ['bind', 'connect', 'send']) dgram.Socket.prototype[method] = denied;
const dnsMethods = [
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
  'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
];
for (const module of [dns, dnsPromises]) {
  for (const method of dnsMethods) if (typeof module[method] === 'function') module[method] = denied;
}
for (const Resolver of [dns.Resolver, dnsPromises.Resolver]) {
  for (const method of dnsMethods) {
    if (typeof Resolver.prototype[method] === 'function') Resolver.prototype[method] = denied;
  }
}
for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'])
  childProcess[method] = denied;
childProcess.ChildProcess.prototype.spawn = denied;
syncBuiltinESMExports();
`;

async function snapshot(directory, prefix = '') {
  const entries = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const key = prefix + name;
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      entries[key + '/'] = { kind: 'directory', mode: stat.mode };
      Object.assign(entries, await snapshot(path, key + '/'));
    } else if (stat.isSymbolicLink()) {
      entries[key] = { kind: 'symlink', mode: stat.mode, target: await readlink(path) };
    } else if (stat.isFIFO()) {
      // Snapshot metadata only: opening an unwritten FIFO could itself block.
      entries[key] = { kind: 'fifo', mode: stat.mode };
    } else {
      assert.ok(stat.isFile(), 'Only controlled regular fixture files are present');
      entries[key] = {
        kind: 'file',
        mode: stat.mode,
        bytes: stat.size,
        sha256: sha256(await readFile(path)),
      };
    }
  }
  return entries;
}

async function fixture(t) {
  const built = await (buildPromise ??= buildCounterInspector());
  assert.ok(built.code instanceof Uint8Array);
  assert.equal(built.code.byteLength, built.manifest.bundle.bytes);
  assert.equal(sha256(built.code), built.manifest.bundle.sha256);
  const directory = await mkdtemp(join(tmpdir(), 'edgelab-standalone-inspector-'));
  assert.ok(relative(root, directory).startsWith('..'), 'Fixture is outside the repository');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'inspector with spaces.mjs');
  const fence = join(directory, 'test-only-denials.mjs');
  await writeFile(binary, built.code);
  await writeFile(fence, preload);
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_REDIRECT_WARNINGS;
  return { directory, binary, fence, env, bundle: built.manifest.bundle, runs: 0 };
}

async function child(f, args, executable = f.binary) {
  const before = await snapshot(f.directory);
  assert.ok(!Object.keys(before).some((key) => key.split('/').includes('node_modules')));
  let result;
  try {
    const output = await execute(process.execPath, ['--import', f.fence, executable, ...args], {
      cwd: f.directory,
      env: f.env,
      timeout: 3000,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    result = { status: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    assert.ok(
      typeof error.code === 'number' && !error.signal && !error.killed,
      'Child finishes within fixed bounds',
    );
    result = { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  assert.deepEqual(
    await snapshot(f.directory),
    before,
    'Child leaves the complete fixture tree and bytes unchanged',
  );
  f.runs++;
  return result;
}

async function reference(args) {
  const stdout = [];
  const stderr = [];
  const log = console.log;
  const error = console.error;
  try {
    console.log = (...values) => stdout.push(values.join(' ') + '\n');
    console.error = (...values) => stderr.push(values.join(' ') + '\n');
    const status = await main(args);
    return { status, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function checked(f, args, expectedStatus, expectedStderr = '', executable = f.binary) {
  const before = await snapshot(f.directory);
  const expected = await reference(args);
  assert.deepEqual(await snapshot(f.directory), before, 'Reference inspection is read-only');
  assert.equal(expected.status, expectedStatus);
  assert.equal(
    expected.stderr === expectedStderr,
    true,
    'Reference returns only the expected static error',
  );
  const actual = await child(f, args, executable);
  assert.equal(actual.status, expectedStatus);
  assert.equal(
    actual.stdout === expected.stdout,
    true,
    'Copied entrypoint stdout exactly matches reference',
  );
  assert.equal(
    actual.stderr === expectedStderr,
    true,
    'Copied entrypoint exposes only the expected static error',
  );
  if (expectedStatus !== 0) assert.equal(actual.stdout.length, 0);
  else assert.ok(actual.stdout.length > 0, 'The copied entry guard really executes main');
  return actual;
}

const rpcArchive = 'docs/evidence/counter-portability/rpc/rpc-after-loss.json';
const readArchive = (path) => readFile(resolve(root, path));
const reverseKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseKeys(item)]),
  );
};
const duplicate = (text, key, escaped = false) =>
  text.replace(
    JSON.stringify(key) + ':',
    JSON.stringify(key) +
      ': {"private":"synthetic-private-content"},"' +
      (escaped ? '\\u' + key.charCodeAt(0).toString(16).padStart(4, '0') + key.slice(1) : key) +
      '":',
  );

test(
  'actual standalone entrypoint accepts frozen profiles without repository dependencies',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const archives = [
      'docs/evidence/counter-portability/before-loss.json',
      'docs/evidence/counter-portability/after-loss.json',
      'docs/evidence/counter-portability/rpc/before-loss.json',
      'docs/evidence/counter-portability/rpc/after-loss.json',
      'docs/evidence/counter-portability/rpc/rpc-before-loss.json',
      rpcArchive,
    ];
    const profiles = new Set();
    for (const [index, path] of archives.entries()) {
      const bytes = await readArchive(path);
      const artifact = await importSamples(bytes.toString('utf8'));
      profiles.add(artifact.source.adapterVersion);
      const copied = join(f.directory, `frozen artifact ${index}.json`);
      await writeFile(copied, bytes);
      const output = await checked(f, [copied], 0);
      assert.ok(output.stdout.includes(`Content SHA-256: ${artifact.contentHash}`));
      assert.ok(output.stdout.includes(`Adapter: ${artifact.source.adapterVersion};`));
    }
    assert.deepEqual([...profiles].sort(), [1, 2]);
    t.diagnostic(
      '6 actual frozen archives; profiles 1 and 2; filename with spaces; no node_modules; 6 unchanged-tree checks.',
    );
    t.diagnostic(`Actual child runtime: Node ${process.version}; platform ${process.platform}.`);
    t.diagnostic(`Inspected bundle: ${f.bundle.bytes} bytes; SHA-256 ${f.bundle.sha256}.`);
    t.diagnostic(
      'Network/process denials are instrumented Node API checks, not an OS sandbox; write checks cover the fixture tree.',
    );
  },
);

test(
  'renamed copied entrypoint preserves canonical stdout for pretty and reordered JSON',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const renamed = join(f.directory, 'renamed inspector.mjs');
    await rename(f.binary, renamed);
    const artifact = await importSamples((await readArchive(rpcArchive)).toString('utf8'));
    for (const [index, value] of [artifact, reverseKeys(artifact)].entries()) {
      const file = join(f.directory, `pretty artifact ${index}.json`);
      await writeFile(file, JSON.stringify(value, null, 2));
      await checked(f, [file], 0, '', renamed);
    }
    t.diagnostic(
      '2 pretty/reordered artifacts; renamed copied executable; matching canonical hashes/stdout; 2 unchanged-tree checks.',
    );
  },
);

test(
  'a copied inspector launched through a POSIX directory symlink executes main',
  { timeout: 20000, skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const alias = join(f.directory, 'directory alias with spaces');
    await symlink('.', alias);
    const artifact = join(f.directory, 'linked launch artifact.json');
    await writeFile(artifact, await readArchive(rpcArchive));
    const executable = join(alias, 'inspector with spaces.mjs');
    await checked(f, [artifact], 0, '', executable);
    t.diagnostic(
      'Actual POSIX directory symlink launch; execution path remains lexical; canonical stdout and unchanged-tree check.',
    );
  },
);

test(
  'raw duplicate and escaped aliases cannot hide private subtrees behind valid hashes',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const text = (await readArchive(rpcArchive)).toString('utf8');
    for (const [index, input] of [
      duplicate(text, 'producerVersion'),
      duplicate(text, 'producerVersion', true),
      duplicate(text, 'state'),
      duplicate(text, 'state', true),
    ].entries()) {
      const file = join(f.directory, `private duplicate ${index}.json`);
      await writeFile(file, input);
      // The old last-key-wins interpretation would retain the unchanged hash.
      assert.deepEqual(JSON.parse(input), JSON.parse(text));
      await checked(f, [file], 1, failure);
    }
    t.diagnostic(
      '4 duplicate root/nested/escaped private-alias cases; static failures only; 4 unchanged-tree checks.',
    );
  },
);

test(
  'unsupported profiles, source pins, fields and changed contents fail without echo',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const artifact = JSON.parse((await readArchive(rpcArchive)).toString('utf8'));
    const changes = [
      (value) => (value.source.adapterVersion = 3),
      (value) => (value.source.commit = '0'.repeat(40)),
      (value) => (value.source.fileSHA256 = '0'.repeat(64)),
      (value) => (value.payload = 'synthetic-private-content'),
      (value) => (value.samples[0].state.payload = 'synthetic-private-content'),
      (value) => (value.contentHash = '0'.repeat(64)),
      (value) => (value.samples[0].state.value = 999),
    ];
    for (const [index, mutate] of changes.entries()) {
      const input = structuredClone(artifact);
      mutate(input);
      const file = join(f.directory, `private invalid ${index}.json`);
      await writeFile(file, JSON.stringify(input));
      await checked(f, [file], 1, failure);
    }
    t.diagnostic(
      '7 profile/pin/extra-field/hash/content cases; no raw input or path echoed; 7 unchanged-tree checks.',
    );
  },
);

test(
  'UTF-8 and exact 32 KiB file bounds are enforced by the copied CLI',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const bytes = await readArchive(rpcArchive);
    const exact = join(f.directory, 'exact byte cap.json');
    await writeFile(
      exact,
      Buffer.concat([bytes, Buffer.alloc(MAX_COUNTER_ARTIFACT_BYTES - bytes.length, 0x20)]),
    );
    await checked(f, [exact], 0);
    for (const [name, input] of [
      ['oversized private.json', Buffer.alloc(MAX_COUNTER_ARTIFACT_BYTES + 1, 0x20)],
      ['invalid UTF-8 private.json', Buffer.from([0xff, 0xfe, 0x7b])],
    ]) {
      const file = join(f.directory, name);
      await writeFile(file, input);
      await checked(f, [file], 1, failure);
    }
    t.diagnostic(
      '32 KiB accepted; 32 KiB + 1 byte and malformed UTF-8 rejected; 3 unchanged-tree checks.',
    );
  },
);

test(
  'missing files, directory inputs and wrong arguments reveal only static errors',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const missing = join(f.directory, 'private missing artifact.json');
    const directory = join(f.directory, 'private directory');
    await mkdir(directory);
    await checked(f, [missing], 1, failure);
    await checked(f, [directory], 1, failure);
    await checked(f, [], 1, usage);
    await checked(f, [missing, 'synthetic-private-argument'], 1, usage);
    t.diagnostic(
      '4 missing/directory/argument cases; generic static usage/failure; 4 unchanged-tree checks.',
    );
  },
);

test(
  'an unwritten POSIX FIFO is rejected without waiting for a writer',
  { timeout: 20000, skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const fifo = join(f.directory, 'unwritten private FIFO');
    await execute('mkfifo', [fifo], { timeout: 3000, maxBuffer: 1024 });
    assert.ok((await lstat(fifo)).isFIFO());
    // Do not call the reference reader here: a regression must be bounded in
    // the child, rather than leaving the parent blocked on the same FIFO.
    const output = await child(f, [fifo]);
    assert.equal(output.status, 1);
    assert.equal(output.stdout.length, 0);
    assert.equal(output.stderr === failure, true, 'FIFO rejection has only the static error');
    t.diagnostic(
      'Actual unwritten POSIX FIFO; no peer writer; static rejection within the 3 s child bound; unchanged-tree check.',
    );
  },
);

test(
  'test-only preload denies named Node network and child-process entrypoints',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const control = `
import http, { request as httpRequest } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import childProcess, { spawn } from 'node:child_process';
const denied = globalThis[Symbol.for('edgelab.inspector.test-denied')];
const APIs = [fetch, WebSocket, http.request, httpRequest, https.get, net.connect,
  net.Socket.prototype.connect, tls.connect, dgram.createSocket,
  dgram.Socket.prototype.send, dns.lookup, dnsLookup, dns.Resolver.prototype.resolve,
  childProcess.exec, childProcess.execSync, childProcess.execFile, childProcess.execFileSync,
  spawn, childProcess.spawnSync, childProcess.fork, childProcess.ChildProcess.prototype.spawn];
if (typeof denied !== 'function' || APIs.some(method => method !== denied))
  throw new Error('Test-only denial preload is incomplete.');
let rejected = 0;
for (const method of APIs) {
  try { method(); } catch { rejected++; }
}
if (rejected !== APIs.length) throw new Error('Test-only denial preload did not reject.');
console.log('Verified test-only API denials: ' + rejected);
`;
    const output = await child(f, ['--eval', control], '--input-type=module');
    assert.equal(output.status, 0);
    assert.equal(output.stdout, 'Verified test-only API denials: 21\n');
    assert.equal(output.stderr, 'Forbidden inspector API invocation.\n'.repeat(21));
    t.diagnostic(
      '21 named network/process API controls rejected before I/O; ESM named exports synchronized; no OS sandbox claim.',
    );
  },
);
