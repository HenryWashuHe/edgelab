import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mediaTypes = {
  '.js': ['text/javascript', 'application/javascript'],
  '.css': ['text/css'],
  '.svg': ['image/svg+xml'],
  '.html': ['text/html'],
};
const expectedMediaTypes = (path) => {
  const extension = path.slice(path.lastIndexOf('.'));
  assert(mediaTypes[extension], `Unsupported production asset: ${path}`);
  return mediaTypes[extension];
};

export async function listBuiltAssets(directory = 'dist') {
  const files = [];
  async function visit(relative = '') {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Production assets cannot be symlinks');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else {
        assert(entry.isFile(), 'Production asset must be a regular file');
        expectedMediaTypes(path);
        files.push(path);
        assert(files.length <= 128, 'Production asset count exceeds verification limit');
      }
    }
  }
  await visit();
  assert(files.includes('index.html'), 'Missing production HTML');
  assert(
    files.some((path) => path.endsWith('.js')),
    'Missing production JavaScript',
  );
  assert(
    files.some((path) => path.endsWith('.css')),
    'Missing production stylesheet',
  );
  const assets = [];
  let totalBytes = 0;
  for (const file of files.sort()) {
    const bytes = await readFile(join(directory, file));
    assert(bytes.byteLength <= 5 * 1024 * 1024, 'Production asset exceeds verification byte limit');
    totalBytes += bytes.byteLength;
    assert(
      totalBytes <= 16 * 1024 * 1024,
      'Production assets exceed verification total byte limit',
    );
    assets.push({
      path: file === 'index.html' ? '/' : `/${file}`,
      file,
      bytes,
      sha256: hash(bytes),
      mediaTypes: expectedMediaTypes(file),
    });
  }
  return assets;
}

export async function verifyBuiltAssets(base, { directory = 'dist', fetcher = fetch } = {}) {
  const url = new URL(base);
  assert(['http:', 'https:'].includes(url.protocol), 'Asset verification requires HTTP');
  assert(
    !url.username && !url.password && !url.search && !url.hash,
    'Invalid asset verification URL',
  );
  assert(url.pathname === '/', 'Asset verification requires the deployment root');
  const assets = await listBuiltAssets(directory);
  const deadline = AbortSignal.timeout(60_000);
  const verified = [];
  for (const asset of assets) {
    const controller = new AbortController();
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(10_000), controller.signal]);
    try {
      const response = await fetcher(new URL(asset.path, url), { signal, redirect: 'error' });
      assert.equal(response.status, 200, `Deployed asset ${asset.path}`);
      const contentType = (response.headers.get('Content-Type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      assert(asset.mediaTypes.includes(contentType), `Incorrect asset MIME type: ${asset.path}`);
      const cacheControl = response.headers.get('Cache-Control') ?? '';
      const directives = cacheControl
        .toLowerCase()
        .split(',')
        .map((part) => part.trim());
      assert(
        directives.includes('no-cache') ||
          directives.includes('no-store') ||
          (directives.includes('max-age=0') && directives.includes('must-revalidate')),
        `Asset must require revalidation: ${asset.path}`,
      );
      const reader = response.body?.getReader();
      assert(reader, `Missing asset body: ${asset.path}`);
      const chunks = [];
      let byteLength = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          byteLength += value.byteLength;
          assert(byteLength <= asset.bytes.byteLength, `Oversized deployed asset: ${asset.path}`);
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      assert.equal(byteLength, asset.bytes.byteLength, `Deployed asset size: ${asset.path}`);
      const served = Buffer.concat(chunks, byteLength);
      assert.equal(hash(served), asset.sha256, `Deployed/build bytes ${asset.path}`);
      verified.push({
        path: asset.path,
        bytes: byteLength,
        sha256: asset.sha256,
        contentType,
        cacheControl,
      });
    } finally {
      controller.abort();
    }
  }
  return verified;
}
