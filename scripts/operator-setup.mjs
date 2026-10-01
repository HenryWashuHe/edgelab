import { randomBytes } from 'node:crypto';
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { operatorAssignment, replaceOperatorToken } from './operator-env.mjs';

const args = process.argv.slice(2);
if (
  args.some((arg) => !['--local', '--rotate'].includes(arg)) ||
  new Set(args).size !== args.length
)
  throw new Error('Usage: operator:setup [--local] [--rotate]');
const local = args.includes('--local');
const rotate = args.includes('--rotate');
const file = local ? '.dev.vars' : '.env.operator';
const pending = `${file}.pending`;
const lock = `${file}.setup-lock`;
const validToken = (token) => /^[a-f0-9]{64}$/.test(token);

async function contents(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function upload(token) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', 'OPERATOR_TOKEN'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    let inputFailed = false;
    child.stdin.on('error', () => {
      inputFailed = true;
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0 && !inputFailed));
    child.stdin.end(`${token}\n`);
  });
}

try {
  await mkdir(lock, { mode: 0o700 });
} catch (error) {
  if (error.code === 'EEXIST')
    throw new Error(
      `Setup is already running or was interrupted. Verify all setup/upload processes have stopped before removing ${lock}, then rerun setup.`,
    );
  throw error;
}

try {
  const content = (await contents(file)) ?? '';
  const entry = operatorAssignment(content);
  const existing = validToken(entry?.value) ? entry.value : null;
  const staged = local ? null : await contents(pending);
  let token;
  if (staged !== null) {
    const stagedEntry = operatorAssignment(staged);
    token = stagedEntry?.value;
    if (!validToken(token) || staged !== `OPERATOR_TOKEN=${token}\n`)
      throw new Error(
        'Pending token format unexpected; preserve both credential files and inspect privately',
      );
    console.log(
      'Retrying the existing pending token; --rotate does not generate another candidate.',
    );
  } else {
    if (!rotate && entry && !existing)
      throw new Error(
        'Existing token format unexpected; preserve the file and use an explicit --rotate to replace it',
      );
    token = !rotate && existing ? existing : randomBytes(32).toString('hex');
    if (!local) await atomicWrite(pending, `OPERATOR_TOKEN=${token}\n`);
  }

  if (!local && !(await upload(token)))
    throw new Error(
      'Cloudflare secret upload was not confirmed. The active local file and pending token are preserved; remote state may have changed. Rerun setup to upload the same candidate.',
    );

  // Preserve unrelated settings if edited while an upload was running. A new
  // duplicate assignment refuses promotion and keeps the pending candidate.
  const current = local ? content : ((await contents(file)) ?? '');
  await atomicWrite(file, replaceOperatorToken(current, token));
  if (!local) await rm(pending);
  console.log(
    local
      ? 'Local operator token saved in .dev.vars (mode 600). Restart Wrangler to load it.'
      : 'Cloudflare operator token configured. Local copy: .env.operator (mode 600, Git-ignored). Never commit or share it.',
  );
} finally {
  await rm(lock, { recursive: true });
}
