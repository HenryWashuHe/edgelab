import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const local = process.argv.includes('--local');
const rotate = process.argv.includes('--rotate');
const file = local ? '.dev.vars' : '.env.operator';
let content = '';
try {
  content = await readFile(file, 'utf8');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const existing = content.match(/^OPERATOR_TOKEN=(.+)$/m)?.[1];
const token = !rotate && existing ? existing : randomBytes(32).toString('hex');
if (!/^[a-f0-9]{64}$/.test(token))
  throw new Error(
    'Existing token format unexpected; preserve the file and use an explicit --rotate to replace it',
  );
content = content.replace(/^OPERATOR_TOKEN=.*\n?/m, '');
await writeFile(
  file,
  `${content}${content && !content.endsWith('\n') ? '\n' : ''}OPERATOR_TOKEN=${token}\n`,
  { mode: 0o600 },
);
await chmod(file, 0o600);
if (local) {
  console.log('Local operator token saved in .dev.vars (mode 600). Restart Wrangler to load it.');
} else {
  const child = spawn('npx', ['wrangler', 'secret', 'put', 'OPERATOR_TOKEN'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.end(token + '\n');
  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', resolve);
  });
  if (code !== 0)
    throw new Error(
      'Cloudflare secret upload failed. The local token file is preserved; rerun setup.',
    );
  console.log(
    'Cloudflare operator token configured. Local copy: .env.operator (mode 600, Git-ignored). Never commit or share it.',
  );
}
