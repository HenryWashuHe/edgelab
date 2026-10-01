import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBuiltAssets, verifyBuiltAssets } from './asset-verification.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'edgelab-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  const files = {
    '/': '<html><script src="/assets/entry.js"></script></html>',
    '/assets/entry.js': 'import("./section.js");',
    '/assets/section.js': 'export default "historical replay";',
    '/assets/entry.css': 'body { color: black; }',
    '/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  };
  for (const [path, contents] of Object.entries(files))
    await writeFile(join(directory, path === '/' ? 'index.html' : path.slice(1)), contents);
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ path: url.pathname, options });
    const type =
      url.pathname === '/'
        ? 'text/html'
        : url.pathname.endsWith('.js')
          ? 'text/javascript'
          : url.pathname.endsWith('.css')
            ? 'text/css'
            : 'image/svg+xml';
    return new Response(files[url.pathname], {
      headers: {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    });
  };
  return { directory, files, calls, fetcher };
}

test('verifies deferred chunks and favicon beyond HTML references', async (t) => {
  const f = await fixture(t);
  const result = await verifyBuiltAssets('https://example.invalid/', f);
  assert.equal(result.length, 5);
  assert(result.some((asset) => asset.path === '/assets/section.js'));
  assert(result.some((asset) => asset.path === '/favicon.svg'));
  assert.deepEqual(
    result.map((asset) => asset.path),
    f.calls.map((call) => call.path),
  );
  for (const call of f.calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.signal.aborted, true, 'request scope is disposed');
  }
});

test('rejects HTML SPA fallback for a JavaScript chunk', async (t) => {
  const f = await fixture(t);
  const fetcher = async (url, options) =>
    url.pathname.endsWith('section.js')
      ? new Response(f.files['/'], {
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
        })
      : f.fetcher(url, options);
  await assert.rejects(
    verifyBuiltAssets('https://example.invalid/', { ...f, fetcher }),
    /Incorrect asset MIME type/,
  );
});

test('rejects changed chunk bytes even with the correct length and MIME', async (t) => {
  const f = await fixture(t);
  const fetcher = async (url, options) =>
    url.pathname.endsWith('section.js')
      ? new Response('x'.repeat(Buffer.byteLength(f.files[url.pathname])), {
          headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
        })
      : f.fetcher(url, options);
  await assert.rejects(
    verifyBuiltAssets('https://example.invalid/', { ...f, fetcher }),
    /Deployed\/build bytes/,
  );
});

test('rejects a missing deferred chunk and stops verification', async (t) => {
  const f = await fixture(t);
  const fetcher = async (url, options) =>
    url.pathname.endsWith('section.js')
      ? new Response('missing', { status: 404 })
      : f.fetcher(url, options);
  await assert.rejects(
    verifyBuiltAssets('https://example.invalid/', { ...f, fetcher }),
    /Deployed asset/,
  );
  assert(!f.calls.some((call) => call.path === '/favicon.svg'));
});

test('rejects stale-cache HTML instead of approving a mismatched deployment entry', async (t) => {
  const f = await fixture(t);
  const fetcher = async (url, options) => {
    const response = await f.fetcher(url, options);
    if (url.pathname === '/') response.headers.set('Cache-Control', 'public, max-age=86400');
    return response;
  };
  await assert.rejects(
    verifyBuiltAssets('https://example.invalid/', { ...f, fetcher }),
    /must require revalidation/,
  );
});

test('bounds oversized response bodies and aborts the request', async (t) => {
  const f = await fixture(t);
  let signal;
  const fetcher = async (url, options) => {
    signal = options.signal;
    return new Response('x'.repeat(Buffer.byteLength(f.files[url.pathname]) + 1), {
      headers: {
        'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
        'Cache-Control': 'no-cache',
      },
    });
  };
  await assert.rejects(
    verifyBuiltAssets('https://example.invalid/', { ...f, fetcher }),
    /Oversized deployed asset/,
  );
  assert.equal(signal.aborted, true);
});

test('rejects symlink and unexpected build files before issuing requests', async (t) => {
  const f = await fixture(t);
  await symlink(join(f.directory, 'index.html'), join(f.directory, 'assets', 'linked.js'));
  await assert.rejects(listBuiltAssets(f.directory), /cannot be symlinks/);
  await rm(join(f.directory, 'assets', 'linked.js'));
  await writeFile(join(f.directory, 'private.json'), '{}');
  await assert.rejects(
    verifyBuiltAssets('https://example.invalid/', f),
    /Unsupported production asset/,
  );
  assert.equal(f.calls.length, 0);
});

test('rejects credential, query, fragment and non-root verification targets', async (t) => {
  const f = await fixture(t);
  for (const url of [
    'https://u:p@example.invalid/',
    'https://example.invalid/?token=x',
    'https://example.invalid/#replay',
    'https://example.invalid/path',
  ])
    await assert.rejects(verifyBuiltAssets(url, f));
  assert.equal(f.calls.length, 0);
});
