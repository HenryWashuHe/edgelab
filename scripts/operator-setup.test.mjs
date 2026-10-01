import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./operator-setup.mjs', import.meta.url));
const oldToken = 'a'.repeat(64);
const otherToken = 'b'.repeat(64);
const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const activeFile = '.env.operator';
const pendingFile = `${activeFile}.pending`;
const lockFile = `${activeFile}.setup-lock`;
const childDeadlineMs = 5000;

// The fake executable's native shebang and the held-upload signal are POSIX
// controls. Never fall through to an installed Windows npx executable.
function test(name, optionsOrBody, body) {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  return nodeTest(
    name,
    {
      ...options,
      ...(process.platform === 'win32'
        ? { skip: 'POSIX-only fake executable and signal fixture' }
        : {}),
    },
    typeof optionsOrBody === 'function' ? optionsOrBody : body,
  );
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'edgelab-setup-'));
  const bin = join(directory, 'bin');
  const emptyBin = join(directory, 'empty-bin');
  await mkdir(bin);
  await mkdir(emptyBin);
  await writeFile(join(directory, activeFile), `OTHER=initial\nOPERATOR_TOKEN=${oldToken}\n`);
  await writeFile(join(directory, 'remote-token'), `${oldToken}\n`);
  const fake = join(bin, 'npx');
  await writeFile(
    fake,
    `#!${process.execPath}
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['wrangler', 'secret', 'put', 'OPERATOR_TOKEN'])) process.exit(70);
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!/^[a-f0-9]{64}\\n$/.test(input)) process.exit(71);
const directory = process.env.SETUP_TEST_DIRECTORY;
await writeFile(join(directory, 'upload-' + process.env.SETUP_TEST_ATTEMPT), input);
const mode = process.env.SETUP_TEST_MODE;
if (mode === 'hold') {
  await writeFile(join(directory, 'held-pid'), String(process.pid));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controlled barrier timed out')), 4000);
    process.once('SIGUSR2', () => {
      clearTimeout(timer);
      resolve();
    });
    console.log('CONTROLLED_UPLOAD_HELD');
  });
}
if (mode === 'definite-failure') process.exit(72);
await writeFile(join(directory, 'remote-token'), input);
if (mode === 'ambiguous-failure') process.exit(73);
`,
  );
  await chmod(fake, 0o700);
  const rejection = join(directory, 'reject-promotion.mjs');
  await writeFile(
    rejection,
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to === '.env.operator') throw new Error('Controlled promotion rename rejection');
  return rename(from, to);
};
syncBuiltinESMExports();
`,
  );
  let attempts = 0;
  const children = [];
  t.after(async () => {
    for (const child of children) child.stop();
    await Promise.all(children.map((child) => child.result));
    await rm(directory, { recursive: true, force: true });
  });
  function start(
    flags = [],
    { mode = 'success', missingExecutable = false, rejectPromotion = false } = {},
  ) {
    const env = {
      ...process.env,
      PATH: missingExecutable ? emptyBin : bin,
      SETUP_TEST_DIRECTORY: directory,
      SETUP_TEST_MODE: mode,
      SETUP_TEST_ATTEMPT: String(++attempts),
    };
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_V8_COVERAGE',
      'NODE_REDIRECT_WARNINGS',
      'OPERATOR_TOKEN',
      'BASE_URL',
    ])
      delete env[name];
    const args = [...(rejectPromotion ? ['--import', rejection] : []), script, ...flags];
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      complete = false,
      timedOut = false,
      overflow = false;
    const waiters = [];
    function stop() {
      if (complete) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    function checkOutput() {
      if (stdout.length + stderr.length > 64 * 1024) {
        overflow = true;
        stop();
      }
      for (const waiter of waiters) if (stdout.includes(waiter.marker)) waiter.resolve();
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      checkOutput();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      checkOutput();
    });
    const result = new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, childDeadlineMs);
      child.once('error', () => {});
      child.once('close', (code) => {
        complete = true;
        clearTimeout(timer);
        for (const waiter of waiters)
          if (!stdout.includes(waiter.marker))
            waiter.reject(new Error('Controlled barrier was not reached'));
        resolve({ code, stdout, stderr, timedOut, overflow });
      });
    });
    const control = {
      result,
      stop,
      wait(marker) {
        if (stdout.includes(marker)) return Promise.resolve();
        if (complete) return Promise.reject(new Error('Controlled barrier was not reached'));
        return new Promise((resolve, reject) => waiters.push({ marker, resolve, reject }));
      },
    };
    children.push(control);
    return control;
  }
  return {
    directory,
    start,
    invoke: async (flags, options) => start(flags, options).result,
    write: (path, value) => writeFile(join(directory, path), value),
    read: (path) => readFile(join(directory, path), 'utf8'),
    async release() {
      const pid = Number(await readFile(join(directory, 'held-pid'), 'utf8'));
      assert(Number.isSafeInteger(pid) && pid > 0, 'Controlled upload PID is valid');
      process.kill(pid, 'SIGUSR2');
    },
    async token(path = activeFile) {
      return (await readFile(join(directory, path), 'utf8')).match(
        /^OPERATOR_TOKEN=([^\r\n]+)$/m,
      )?.[1];
    },
    async uploads() {
      const paths = (await readdir(directory)).filter((path) => /^upload-\d+$/.test(path));
      return Promise.all(
        paths.sort().map(async (path) => (await readFile(join(directory, path), 'utf8')).trim()),
      );
    },
    async absent(path) {
      await assert.rejects(stat(join(directory, path)), { code: 'ENOENT' });
    },
    async privateMode(path) {
      if (process.platform !== 'win32')
        assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600);
    },
    async clean() {
      await this.absent(pendingFile);
      await this.absent(lockFile);
      assert(
        !(await readdir(directory)).some((path) => path.endsWith('.tmp')),
        'No staging file remains',
      );
    },
  };
}

function outcome(result, success, message) {
  assert(!result.timedOut && !result.overflow, 'Child completed within time and output bounds');
  assert((result.code === 0) === success, `${message} (exit ${result.code})`);
  assert(!/[a-f0-9]{64}/.test(result.stdout + result.stderr), 'Child output omits token bytes');
}

test('local setup creates, reuses and rotates only local credentials with unrelated settings preserved', async (t) => {
  const f = await fixture(t);
  await f.write('.dev.vars', 'LOCAL_SETTING=kept\n');
  const remoteBefore = await f.read(activeFile);
  outcome(await f.invoke(['--local']), true, 'Local initial setup succeeds');
  const first = await f.token('.dev.vars');
  const firstContent = await f.read('.dev.vars');
  assert(validToken(first), 'Local token has the supported format');
  outcome(await f.invoke(['--local']), true, 'Local reuse succeeds');
  assert((await f.token('.dev.vars')) === first, 'Ordinary local setup reuses its token');
  assert(
    (await f.read('.dev.vars')) === firstContent,
    'Repeated local setup does not grow or alter its file',
  );
  outcome(await f.invoke(['--local', '--rotate']), true, 'Local rotation succeeds');
  assert((await f.token('.dev.vars')) !== first, 'Explicit local rotation changes its token');
  assert(
    (await f.read('.dev.vars')).includes('LOCAL_SETTING=kept\n'),
    'Local unrelated settings remain',
  );
  assert((await f.read(activeFile)) === remoteBefore, 'Remote credentials remain untouched');
  assert.equal((await f.uploads()).length, 0);
  await f.privateMode('.dev.vars');
  await f.absent('.dev.vars.setup-lock');
  await f.clean();
  t.diagnostic(
    'Three actual local child invocations; zero fake upload calls; POSIX mode checked where supported.',
  );
  t.diagnostic(
    `Controlled runtime: ${process.version} on ${process.platform}; no Cloudflare upload calls.`,
  );
});

test('confirmed remote setup reuses its credential and atomically leaves a private active file without staging', async (t) => {
  const f = await fixture(t);
  outcome(await f.invoke([]), true, 'Remote setup succeeds');
  assert((await f.token()) === oldToken, 'Existing remote token is reused');
  assert(
    (await f.read('remote-token')).trim() === oldToken,
    'Uploaded token matches the active token',
  );
  assert((await f.read(activeFile)).includes('OTHER=initial\n'), 'Unrelated settings remain');
  const firstContent = await f.read(activeFile);
  outcome(await f.invoke([]), true, 'Repeated remote setup succeeds');
  assert(
    (await f.read(activeFile)) === firstContent,
    'Repeated remote setup does not grow or alter its file',
  );
  assert.equal((await f.uploads()).length, 2);
  await f.privateMode(activeFile);
  await f.clean();
});

test('first-time remote provisioning preserves absent credentials until ordinary retry promotes the retained candidate', async (t) => {
  const f = await fixture(t);
  await Promise.all([rm(join(f.directory, activeFile)), rm(join(f.directory, 'remote-token'))]);
  outcome(
    await f.invoke([], { mode: 'definite-failure' }),
    false,
    'Unconfirmed initial upload fails',
  );
  await f.absent(activeFile);
  await f.absent('remote-token');
  const candidate = await f.token(pendingFile);
  assert(validToken(candidate), 'A valid initial candidate remains available');
  await f.privateMode(pendingFile);
  await f.absent(lockFile);
  const firstUploads = await f.uploads();
  assert(
    firstUploads.length === 1 && firstUploads[0] === candidate,
    'Initial attempt uploads the retained candidate',
  );
  outcome(await f.invoke([]), true, 'Ordinary retry confirms initial provisioning');
  const uploads = await f.uploads();
  assert(
    uploads.length === 2 && uploads.every((value) => value === candidate),
    'Retry does not generate or upload another candidate',
  );
  assert((await f.token()) === candidate, 'Confirmed retry creates the active credential');
  assert(
    (await f.read('remote-token')).trim() === candidate,
    'Confirmed fake remote matches the active credential',
  );
  await f.privateMode(activeFile);
  await f.clean();
});

for (const mode of ['definite-failure', 'ambiguous-failure'])
  test(`${mode} preserves active and pending credentials; --rotate retry reuses the same candidate`, async (t) => {
    const f = await fixture(t);
    const before = await f.read(activeFile);
    outcome(await f.invoke(['--rotate'], { mode }), false, 'Unconfirmed upload fails');
    assert(
      (await f.read(activeFile)) === before,
      'Previous active credential remains byte-identical',
    );
    const candidate = await f.token(pendingFile);
    assert(
      validToken(candidate) && candidate !== oldToken,
      'A separate valid candidate is retained',
    );
    const remote = (await f.read('remote-token')).trim();
    assert(
      remote === (mode === 'definite-failure' ? oldToken : candidate),
      'Controlled remote state matches the failure stage',
    );
    await f.privateMode(pendingFile);
    await f.absent(lockFile);
    outcome(await f.invoke(['--rotate']), true, 'Explicit retry succeeds');
    const uploads = await f.uploads();
    assert(
      uploads.length === 2 && uploads.every((value) => value === candidate),
      'Both attempts upload one retained candidate',
    );
    assert((await f.token()) === candidate, 'Confirmed retry promotes that candidate');
    assert(
      (await f.read('remote-token')).trim() === candidate,
      'Confirmed fake remote matches active credential',
    );
    await f.privateMode(activeFile);
    await f.clean();
    t.diagnostic(
      'Failure stage is controlled in a fake upload command; no inference about real provider acknowledgement.',
    );
  });

test(
  'a held first rotation excludes a concurrent second rotation and preserves one upload',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const before = await f.read(activeFile);
    const first = f.start(['--rotate'], { mode: 'hold' });
    await first.wait('CONTROLLED_UPLOAD_HELD');
    outcome(await f.invoke(['--rotate']), false, 'Concurrent setup is refused');
    const candidate = await f.token(pendingFile);
    assert((await f.read(activeFile)) === before, 'Active file is unchanged during upload');
    assert(
      (await f.token(pendingFile)) === candidate,
      'Concurrent refusal does not replace the candidate',
    );
    assert.equal((await f.uploads()).length, 1);
    await f.release();
    outcome(await first.result, true, 'First upload completes');
    assert((await f.token()) === candidate, 'Only the first candidate is promoted');
    assert(
      (await f.read('remote-token')).trim() === candidate,
      'Remote and active credentials agree',
    );
    await f.clean();
    t.diagnostic(
      'Explicit POSIX signal and static stdout barrier control ordering; no sleep-based race.',
    );
  },
);

test('pre-existing locks fail closed without reclaiming the lock or making an upload', async (t) => {
  const f = await fixture(t);
  const before = await f.read(activeFile);
  await mkdir(join(f.directory, lockFile));
  outcome(await f.invoke(['--rotate']), false, 'Stale or active lock is refused');
  assert(
    (await stat(join(f.directory, lockFile))).isDirectory(),
    'Existing lock remains for explicit recovery',
  );
  assert((await f.read(activeFile)) === before, 'Active credential remains untouched');
  await f.absent(pendingFile);
  assert.equal((await f.uploads()).length, 0);
});

test('duplicate canonical and alternate token assignments fail before selecting or uploading either token', async (t) => {
  const f = await fixture(t);
  for (const second of [`OPERATOR_TOKEN=${otherToken}`, ` export OPERATOR_TOKEN =${otherToken}`]) {
    const content = `OPERATOR_TOKEN=${oldToken}\nOTHER=kept\n${second}\n`;
    for (const flags of [[], ['--rotate'], ['--local']]) {
      const path = flags.includes('--local') ? '.dev.vars' : activeFile;
      await f.write(path, content);
      outcome(await f.invoke(flags), false, 'Duplicate assignments are refused');
      assert((await f.read(path)) === content, 'Ambiguous file remains byte-identical');
    }
  }
  assert.equal((await f.uploads()).length, 0);
  await f.clean();
});

test('unknown and duplicated flags fail before credentials, staging or any remote upload', async (t) => {
  const f = await fixture(t);
  const before = await f.read(activeFile);
  for (const args of [
    ['--loacl'],
    ['--local=false'],
    ['--rotate', '--rotate'],
    ['--local', '--local'],
  ])
    outcome(await f.invoke(args), false, 'Unsupported argument list is refused');
  assert((await f.read(activeFile)) === before, 'Active credential remains unchanged');
  assert.equal((await f.uploads()).length, 0);
  await f.absent('.dev.vars');
  await f.clean();
});

test('empty, malformed and ambiguous pending files are preserved even with explicit rotation', async (t) => {
  const f = await fixture(t);
  const before = await f.read(activeFile);
  for (const pending of [
    '',
    'not-a-token\n',
    `OPERATOR_TOKEN=${otherToken}\nEXTRA=unexpected\n`,
    `OPERATOR_TOKEN=${otherToken}\nOPERATOR_TOKEN=${oldToken}\n`,
  ]) {
    await f.write(pendingFile, pending);
    outcome(await f.invoke(['--rotate']), false, 'Invalid pending credential is refused');
    assert((await f.read(pendingFile)) === pending, 'Invalid pending bytes are not overwritten');
    assert((await f.read(activeFile)) === before, 'Active credential remains unchanged');
    await f.absent(lockFile);
  }
  assert.equal((await f.uploads()).length, 0);
});

test('native executable lookup failure retains a retryable candidate and previous active credential', async (t) => {
  const f = await fixture(t);
  const before = await f.read(activeFile);
  outcome(
    await f.invoke(['--rotate'], { missingExecutable: true }),
    false,
    'Missing npx fails safely',
  );
  const candidate = await f.token(pendingFile);
  assert(
    validToken(candidate) && candidate !== oldToken,
    'Candidate remains available after spawn failure',
  );
  assert((await f.read(activeFile)) === before, 'Active file remains byte-identical');
  assert.equal((await f.uploads()).length, 0);
  await f.absent(lockFile);
  outcome(await f.invoke(['--rotate']), true, 'Explicit retry uses the retained candidate');
  assert((await f.token()) === candidate, 'Retry promotes the retained candidate');
  await f.clean();
});

test('controlled promotion rename rejection after successful upload retains both credentials for same-candidate recovery', async (t) => {
  const f = await fixture(t);
  const before = await f.read(activeFile);
  outcome(
    await f.invoke(['--rotate'], { rejectPromotion: true }),
    false,
    'Controlled promotion rejection fails setup',
  );
  const candidate = await f.token(pendingFile);
  assert(validToken(candidate), 'Pending candidate remains valid');
  assert((await f.read(activeFile)) === before, 'Earlier active file survives rejected promotion');
  assert(
    (await f.read('remote-token')).trim() === candidate,
    'Fake upload applied before promotion rejection',
  );
  await f.absent(lockFile);
  assert(
    !(await readdir(f.directory)).some((path) => path.endsWith('.tmp')),
    'Failed promotion removes its temporary file',
  );
  outcome(
    await f.invoke(['--rotate']),
    true,
    'Retry succeeds after removing the test-only rejection',
  );
  assert((await f.token()) === candidate, 'Retry preserves candidate identity');
  assert(
    (await f.uploads()).every((token) => token === candidate),
    'Retry never dispatches another candidate',
  );
  await f.clean();
  t.diagnostic(
    'Test-only builtin rename interposition rejects before native promotion; not evidence of a natural disk failure.',
  );
});

test(
  'unrelated settings edited during a held upload survive confirmed promotion',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const first = f.start(['--rotate'], { mode: 'hold' });
    await first.wait('CONTROLLED_UPLOAD_HELD');
    const candidate = await f.token(pendingFile);
    await f.write(activeFile, `OTHER=edited\nADDED=kept\nOPERATOR_TOKEN=${oldToken}\n`);
    await f.release();
    outcome(await first.result, true, 'Promotion succeeds after an unrelated edit');
    const content = await f.read(activeFile);
    assert(content.includes('OTHER=edited\nADDED=kept\n'), 'Current unrelated settings survive');
    assert(
      (await f.token()) === candidate,
      'Candidate is promoted without restoring stale settings',
    );
    await f.clean();
  },
);

test(
  'a duplicate introduced during upload refuses promotion and retains the candidate after remote application',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const first = f.start(['--rotate'], { mode: 'hold' });
    await first.wait('CONTROLLED_UPLOAD_HELD');
    const candidate = await f.token(pendingFile);
    const changed = `OPERATOR_TOKEN=${oldToken}\nOPERATOR_TOKEN=${otherToken}\n`;
    await f.write(activeFile, changed);
    await f.release();
    outcome(await first.result, false, 'Ambiguous current settings refuse promotion');
    assert((await f.read(activeFile)) === changed, 'Ambiguous active bytes remain untouched');
    assert((await f.token(pendingFile)) === candidate, 'Candidate remains for explicit recovery');
    assert(
      (await f.read('remote-token')).trim() === candidate,
      'Controlled remote application is not mistaken for local promotion',
    );
    await f.absent(lockFile);
  },
);

test('token-looking lines inside an unrelated multiline value are preserved and never selected for remote setup', async (t) => {
  const f = await fixture(t);
  const unrelated = `# synthetic fixture\nOTHER="first\nOPERATOR_TOKEN=${oldToken}\nlast"\nKEEP=yes\n`;
  await f.write(activeFile, unrelated);
  outcome(await f.invoke([]), true, 'Setup creates an actual token outside the quoted value');
  const uploads = await f.uploads();
  assert(uploads.length === 1 && validToken(uploads[0]), 'One valid token is uploaded');
  const candidate = uploads[0];
  assert(candidate !== oldToken, 'An embedded token-looking line is not reused');
  assert(
    (await f.read(activeFile)) === `${unrelated}OPERATOR_TOKEN=${candidate}\n`,
    'Multiline value stays byte-identical beside the new assignment',
  );
  assert(
    (await f.read('remote-token')).trim() === candidate,
    'Fake remote receives the generated token',
  );
  await f.clean();
});

test('a real assignment after an embedded multiline token is reused without altering the unrelated value', async (t) => {
  const f = await fixture(t);
  const unrelated = `OTHER='first\nOPERATOR_TOKEN=${oldToken}\nlast'\nKEEP=yes\n`;
  const content = `${unrelated}OPERATOR_TOKEN=${otherToken}\n`;
  await f.write(activeFile, content);
  outcome(await f.invoke([]), true, 'Only the actual outside assignment is reused');
  const uploads = await f.uploads();
  assert(uploads.length === 1 && uploads[0] === otherToken, 'The outside token is uploaded');
  assert(
    (await f.read(activeFile)) === content,
    'Unrelated multiline bytes and the actual token remain intact',
  );
  await f.clean();
});

test('two real assignments outside a multiline value still fail closed with every file byte preserved', async (t) => {
  const f = await fixture(t);
  const content = `OTHER="first\nOPERATOR_TOKEN=${oldToken}\nlast"\nOPERATOR_TOKEN=${otherToken}\nexport OPERATOR_TOKEN="${oldToken}" # actual duplicate\n`;
  await f.write(activeFile, content);
  for (const args of [[], ['--rotate']]) {
    outcome(await f.invoke(args), false, 'Actual duplicate assignments are refused');
    assert((await f.read(activeFile)) === content, 'Ambiguous source bytes remain intact');
  }
  assert.equal((await f.uploads()).length, 0);
  await f.clean();
});

test('valid quoted, exported and commented token assignments reuse their decoded value', async (t) => {
  const f = await fixture(t);
  const unrelated = 'OTHER="literal # comment marker = kept"\n';
  const entries = [
    `OPERATOR_TOKEN="${otherToken}" # token comment`,
    `export OPERATOR_TOKEN='${otherToken}' # token comment`,
    ` OPERATOR_TOKEN = ${otherToken} # token comment`,
  ];
  for (const entry of entries) {
    await f.write(activeFile, `${unrelated}${entry}\n`);
    outcome(await f.invoke([]), true, 'Supported dotenv token syntax is reused');
    const uploads = await f.uploads();
    assert(
      uploads.at(-1) === otherToken,
      'Decoded token value is uploaded without quotes or comments',
    );
    assert(
      (await f.read(activeFile)) === `${unrelated}OPERATOR_TOKEN=${otherToken}\n`,
      'Only the actual token assignment is normalized',
    );
    await f.privateMode(activeFile);
    await f.clean();
  }
  assert.equal((await f.uploads()).length, entries.length);
});

test('local setup preserves embedded multiline token text while creating a distinct actual assignment', async (t) => {
  const f = await fixture(t);
  const unrelated = `OTHER="first\nOPERATOR_TOKEN=${otherToken}\nlast"\n`;
  const remoteBefore = await f.read(activeFile);
  await f.write('.dev.vars', unrelated);
  outcome(await f.invoke(['--local']), true, 'Local setup creates an outside assignment');
  const content = await f.read('.dev.vars');
  const actual = content.slice(unrelated.length).match(/^OPERATOR_TOKEN=([a-f0-9]{64})\n$/)?.[1];
  assert(
    content.startsWith(unrelated) && validToken(actual),
    'Multiline bytes remain intact with a valid real assignment',
  );
  assert(actual !== otherToken, 'Embedded text is not the local credential');
  assert((await f.read(activeFile)) === remoteBefore, 'Remote active file is untouched');
  assert.equal((await f.uploads()).length, 0);
  await f.privateMode('.dev.vars');
  await f.absent('.dev.vars.setup-lock');
});

test('normalizing a token preserves following standalone comments and blank lines exactly', async (t) => {
  const f = await fixture(t);
  const unrelated = `# Keep this standalone comment\n# OPERATOR_TOKEN=${otherToken}\n\nAFTER="literal # value"\n`;
  await f.write(activeFile, `OPERATOR_TOKEN=${oldToken}\n${unrelated}`);
  outcome(
    await f.invoke([]),
    true,
    'Actual assignment is normalized independently of later comments',
  );
  const expected = `${unrelated}OPERATOR_TOKEN=${oldToken}\n`;
  assert(
    (await f.read(activeFile)) === expected,
    'Following comments and blank lines remain byte-identical',
  );
  outcome(await f.invoke([]), true, 'Normalized setup remains repeatable');
  assert((await f.read(activeFile)) === expected, 'Repeating normalization preserves every byte');
  assert(
    (await f.uploads()).every((token) => token === oldToken),
    'Only the actual token is uploaded',
  );
  await f.clean();
});
