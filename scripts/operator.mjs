import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
const target = new URL(process.env.BASE_URL || 'http://localhost:8787');
if (
  !['http:', 'https:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.pathname !== '/' ||
  target.search ||
  target.hash
)
  throw new Error(
    'BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment',
  );
const base = target.origin;
const hostname = target.hostname.replace(/\.$/, '');
const local =
  hostname === 'localhost' ||
  (isIP(hostname) === 4 && hostname.startsWith('127.')) ||
  hostname === '[::1]';
const file = local ? '.dev.vars' : '.env.operator';
const token =
  process.env.OPERATOR_TOKEN || (await readFile(file, 'utf8')).match(/^OPERATOR_TOKEN=(.+)$/m)?.[1];
if (!token) throw new Error('Run operator:setup first');
const [command = 'audit', service, arg] = process.argv.slice(2);
const fetchJson = async (path, body) => {
  const r = await fetch(`${base}/api/ops/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || String(r.status));
  return data;
};
if (command === 'audit') console.log(JSON.stringify(await fetchJson('audit'), null, 2));
else if (command === 'pause' || command === 'resume') {
  const snapshot = await fetchJson('status');
  const s = snapshot.services.find((s) => s.id === service);
  if (!s) throw new Error('Unknown service');
  console.log(
    await fetchJson('policy', {
      service,
      revision: s.revision,
      policy: { paused: command === 'pause' },
    }),
  );
} else if (command === 'ack') {
  if (!service || !arg) throw new Error('Usage: operator ack <incident-id> <note>');
  console.log(await fetchJson('acknowledge', { incident: service, note: arg }));
} else
  throw new Error('Commands: audit | pause <service> | resume <service> | ack <incident> <note>');
