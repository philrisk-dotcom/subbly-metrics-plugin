#!/usr/bin/env node
// Fills the dashboard template with one store's details and writes a ready-to-publish
// copy. No network access, no dependencies.
//
//   node prepare.mjs --name "Tinned Fish Club" --connector "subbly-tinned-fish-club" --out ./subbly-dashboard-tinned-fish-club
//   node prepare.mjs --out ./subbly-dashboard-tinned-fish-club --record-url https://claude.ai/artifact/...
//
// Optional lock screen: set SUBBLY_DASHBOARD_PASSWORD in the environment. Only a salted
// SHA-256 hash is written into the page. Pass --no-lock to remove an existing lock.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = ['list_customers', 'list_subscriptions', 'list_invoices', 'list_transactions', 'get_invoice'];
const here = dirname(fileURLToPath(import.meta.url));
const templateDir = join(here, '..', 'template');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

const a = args(process.argv.slice(2));
if (!a.out || a.out === true) fail('--out <directory> is required');
const outDir = resolve(a.out);
const statePath = join(outDir, 'dashboard.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

// record the published link so later runs update the same dashboard
if (a['record-url']) {
  if (!/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+/.test(a['record-url'])) fail('--record-url must be a claude.ai artifact link');
  writeFileSync(statePath, JSON.stringify({ ...state, url: a['record-url'] }, null, 2) + '\n');
  console.log(JSON.stringify({ recorded: a['record-url'], state: statePath }));
  process.exit(0);
}

const name = String(a.name || state.name || '').trim();
const connector = String(a.connector || state.connector || '').trim();
if (!name) fail('--name "<store name>" is required');
if (!connector) fail('--connector "<connector display name>" is required');
if (name.length > 80) fail('store name is longer than 80 characters');

// storage key: the dashboard's database namespace; keep it stable once published
const key = String(a.key || state.key || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60));
if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(key)) fail(`could not make a storage key from "${name}"; pass --key with lowercase letters, digits and dashes`);

let lockHash = state.lockHash || '';
if (a['no-lock']) lockHash = '';
const pw = process.env.SUBBLY_DASHBOARD_PASSWORD;
if (pw) {
  if (pw.length < 6) fail('SUBBLY_DASHBOARD_PASSWORD must be at least 6 characters');
  lockHash = createHash('sha256').update(`${key}:${pw}`).digest('hex');
}

const html = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const js = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c');

let page = readFileSync(join(templateDir, 'index.html'), 'utf8');
// JS string fields first (inside <script>), then the HTML text fields
page = page.replace("const MERCHANT = { key: '__STORE_KEY__', server: '__CONNECTOR__', name: '__STORE_NAME__' };",
  `const MERCHANT = { key: '${js(key)}', server: '${js(connector)}', name: '${js(name)}' };`);
page = page.replace("const LOCK_HASH = '__LOCK_HASH__';", `const LOCK_HASH = '${lockHash}';`);
page = page.replaceAll('__STORE_NAME__', html(name)).replaceAll('__CONNECTOR__', html(connector));
if (/__(STORE_NAME|STORE_KEY|CONNECTOR|LOCK_HASH)__/.test(page)) fail('template field left unfilled; the template and this script are out of step');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), page);
writeFileSync(join(outDir, 'engine.js'), readFileSync(join(templateDir, 'engine.js')));
const next = { name, connector, key, lockHash, url: state.url || null };
writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n');

console.log(JSON.stringify({
  title: `${name} Metrics`,
  file_path: join(outDir, 'index.html'),
  files: { 'engine.js': join(outDir, 'engine.js') },
  capabilities: { db: {}, mcp: { servers: [{ server: connector, tools: TOOLS }] } },
  existing_url: next.url,
  lock: Boolean(lockHash),
  state: statePath,
}, null, 2));
