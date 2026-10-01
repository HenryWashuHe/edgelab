import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('./operator.mjs', import.meta.url));
const localToken = 'synthetic-local-token';
const remoteToken = 'synthetic-remote-token';

async function fixture(t, { credentials = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'edgelab-operator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (credentials) {
    await writeFile(join(directory, '.dev.vars'), `OPERATOR_TOKEN=${localToken}\n`);
    await writeFile(join(directory, '.env.operator'), `OPERATOR_TOKEN=${remoteToken}\n`);
  }
  const capture = join(directory, 'request.json');
  const interceptor = join(directory, 'capture.mjs');
  await writeFile(
    interceptor,
    `import { writeFile } from 'node:fs/promises';
globalThis.fetch = async (url, options) => {
  await writeFile(process.env.OPERATOR_TEST_CAPTURE, JSON.stringify({ url, ...options, signal: undefined }));
  return new Response('{"events":[]}', { headers: { 'Content-Type': 'application/json' } });
};
`,
  );
  return {
    writeLocal(content) {
      return writeFile(join(directory, '.dev.vars'), content);
    },
    async invoke(base, { token, native = false } = {}) {
      const env = { ...process.env, OPERATOR_TEST_CAPTURE: capture };
      delete env.BASE_URL;
      delete env.OPERATOR_TOKEN;
      if (base !== undefined) env.BASE_URL = base;
      if (token !== undefined) env.OPERATOR_TOKEN = token;
      const args = [...(native ? [] : ['--import', interceptor]), script, 'audit'];
      return run(process.execPath, args, {
        cwd: directory,
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    },
    async request() {
      return JSON.parse(await readFile(capture, 'utf8'));
    },
    async noRequest() {
      await assert.rejects(readFile(capture, 'utf8'), { code: 'ENOENT' });
    },
  };
}

test('actual IPv4 loopback HTTP requests use the local token and one API path separator', async (t) => {
  const f = await fixture(t);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"events":[]}');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const suffix of ['', '/']) {
    const result = await f.invoke(base + suffix, { native: true });
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { events: [] });
  }
  assert.deepEqual(requests, [
    { path: '/api/ops/audit', authorization: `Bearer ${localToken}` },
    { path: '/api/ops/audit', authorization: `Bearer ${localToken}` },
  ]);
});

test('CLI credential selection uses the parsed hostname, including normalized loopback forms', async (t) => {
  const f = await fixture(t);
  const cases = [
    [undefined, 'http://localhost:8787', localToken],
    ['http://LOCALHOST.:8787/', 'http://localhost.:8787', localToken],
    ['http://127.6.7.8:8787', 'http://127.6.7.8:8787', localToken],
    ['http://127.1:8787', 'http://127.0.0.1:8787', localToken],
    ['http://[::1]:8787/', 'http://[::1]:8787', localToken],
    ['https://localhost.example.invalid/', 'https://localhost.example.invalid', remoteToken],
    ['https://127.example.invalid/', 'https://127.example.invalid', remoteToken],
    ['https://worker.example.invalid/', 'https://worker.example.invalid', remoteToken],
  ];
  for (const [input, origin, token] of cases) {
    await f.invoke(input);
    const request = await f.request();
    assert.equal(request.url, `${origin}/api/ops/audit`);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.body, undefined);
  }
});

test('explicit OPERATOR_TOKEN overrides both credential files without reading either', async (t) => {
  const f = await fixture(t, { credentials: false });
  for (const base of ['http://127.0.0.1:8787/', 'https://worker.example.invalid/']) {
    await f.invoke(base, { token: 'synthetic-explicit-token' });
    assert.equal((await f.request()).headers.Authorization, 'Bearer synthetic-explicit-token');
  }
});

test('CLI selects the real dotenv assignment outside unrelated multiline quoted values', async (t) => {
  const f = await fixture(t);
  for (const quote of ['"', "'", '`']) {
    await f.writeLocal(
      `OTHER=${quote}first\nOPERATOR_TOKEN=synthetic-embedded-token\nlast${quote}\nexport OPERATOR_TOKEN="${localToken}" # real assignment\n`,
    );
    await f.invoke(undefined);
    assert.equal((await f.request()).headers.Authorization, `Bearer ${localToken}`);
  }
});

test('CLI refuses true duplicate dotenv assignments before requesting operator data', async (t) => {
  const f = await fixture(t);
  await f.writeLocal(`OPERATOR_TOKEN=${localToken}\nexport OPERATOR_TOKEN='${remoteToken}'\n`);
  await assert.rejects(f.invoke(undefined), (error) => {
    assert.match(error.stderr, /Multiple OPERATOR_TOKEN assignments/);
    return true;
  });
  await f.noRequest();
});

test('token-looking text inside an unrelated value does not provide operator access', async (t) => {
  const f = await fixture(t);
  await f.writeLocal('OTHER="first\nOPERATOR_TOKEN=synthetic-embedded-token\nlast"\n');
  await assert.rejects(f.invoke(undefined), (error) => {
    assert.match(error.stderr, /Run operator:setup first/);
    return true;
  });
  await f.noRequest();
});

test('non-origin targets fail before credential lookup or any request', async (t) => {
  const f = await fixture(t, { credentials: false });
  for (const base of [
    'ftp://worker.example.invalid/',
    'https://user:password@worker.example.invalid/',
    'https://worker.example.invalid/prefix',
    'https://worker.example.invalid/?host=localhost',
    'https://worker.example.invalid/#localhost',
  ]) {
    await assert.rejects(f.invoke(base), (error) => {
      assert.match(error.stderr, /BASE_URL must be an HTTP\(S\) origin/);
      assert.doesNotMatch(error.stderr, /ENOENT/);
      return true;
    });
  }
  await assert.rejects(f.invoke('not a URL'), (error) => {
    assert.match(error.stderr, /Invalid URL/);
    assert.doesNotMatch(error.stderr, /ENOENT/);
    return true;
  });
  await f.noRequest();
});
