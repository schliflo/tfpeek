import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { PassThroughClient } from 'google-auth-library';
import { maskState, diffStates, matchRuns } from './core.js';
import { overviewPage, envPage, historyPage, messagePage } from './pages.js';

const buckets = (process.env.STATE_BUCKETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!buckets.length) {
  console.error('STATE_BUCKETS is required (comma-separated bucket names)');
  process.exit(1);
}
// Reading objects needs no project. A fixed id skips auto-detection, which fails outside GCP.
// The emulator takes no credentials, but the library would still go looking for some.
const storage = new Storage({
  projectId: 'tfpeek',
  ...(process.env.STORAGE_EMULATOR_HOST && { authClient: new PassThroughClient() }),
});
const assets = Object.fromEntries(Object.entries({
  '/favicon.svg': 'image/svg+xml', '/assets/app.css': 'text/css', '/assets/app.js': 'text/javascript',
}).map(([url, type]) => [url, { type, body: readFileSync(new URL(`./assets/${url.split('/').pop()}`, import.meta.url)) }]));
const TTL = 30_000;
const GENERATIONS = 30; // state versions on the history page
const RUNS = 50;

// shortcut: no size limit beyond a full clear, switch to an LRU if memory matters
const cache = new Map();
function cached(key, ttl, fn) {
  if (cache.has(key)) return cache.get(key);
  if (cache.size > 5000) cache.clear();
  const value = fn();
  cache.set(key, value);
  const drop = () => cache.get(key) === value && cache.delete(key);
  value.catch(drop);
  if (ttl !== Infinity) setTimeout(drop, ttl).unref();
  return value;
}

// shortcut: bare envelope without stack frames, switch to @sentry/node if grouping gets poor
const dsn = process.env.SENTRY_DSN && new URL(process.env.SENTRY_DSN);
function report(err, where) {
  console.error(where, err);
  if (!dsn) return;
  const event_id = randomUUID().replaceAll('-', '');
  const event = {
    event_id, timestamp: Date.now() / 1000, platform: 'node', level: 'error', transaction: where,
    exception: { values: [{ type: err.name, value: err.message }] }, extra: { stack: err.stack },
  };
  fetch(`${dsn.protocol}//${dsn.host}/api${dsn.pathname}/envelope/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=tfpeek/0.1`,
    },
    body: [{ event_id, sent_at: new Date().toISOString() }, { type: 'event' }, event].map((x) => JSON.stringify(x)).join('\n'),
  }).catch((e) => console.error('sentry:', e.message));
}

async function readJson(bucket, name, generation) {
  const [buf] = await storage.bucket(bucket).file(name, { generation }).download();
  // JSON.parse errors quote the input, which may be raw state: never let that message out.
  try { return JSON.parse(buf); } catch { throw new Error(`invalid JSON in gs://${bucket}/${name}`); }
}

// The only place raw state exists; it is masked before it leaves.
const fetchState = async (env, generation) => maskState(await readJson(env.bucket, `${env.id}.tfstate`, generation));
const loadState = (env) => cached(`state:${env.bucket}:${env.id}:${env.generation}`, TTL, () => fetchState(env, env.generation));

// A generation never changes, so its overview numbers are kept and the state is not read again.
const loadSummary = (env) => cached(`summary:${env.bucket}:${env.id}:${env.generation}`, Infinity, async () => {
  const state = await loadState(env);
  return { serial: state.serial, terraform_version: state.terraform_version, resources: state.resources.length };
});

const listEnvs = () => cached('envs', TTL, async () => {
  const envs = [];
  for (const bucket of buckets) {
    const [files] = await storage.bucket(bucket).getFiles({ matchGlob: '**.tf{state,lock}' });
    const locks = new Set(files.map((f) => f.name).filter((n) => n.endsWith('.tflock')));
    for (const f of files) {
      if (!f.name.endsWith('.tfstate') || f.name.startsWith('runs/')) continue;
      const id = f.name.slice(0, -'.tfstate'.length);
      envs.push({ bucket, id, generation: f.metadata.generation, updated: f.metadata.updated, locked: locks.has(`${id}.tflock`) });
    }
  }
  return envs.sort((a, b) => a.id.localeCompare(b.id));
});

// Gone between list and read (404) means unlocked. Any other error still counts as locked.
const loadLock = (env) => env.locked
  ? cached(`lock:${env.bucket}:${env.id}`, TTL, () => readJson(env.bucket, `${env.id}.tflock`).catch((err) => (err.code === 404 ? null : {})))
  : null;

// Newest first. Records live in runs/<prefix>/ (default workspace) or runs/<prefix>/<workspace>/.
// shortcut: lists every record of the environment, add a lifecycle rule or date prefix if that gets slow
const loadRuns = (env, limit) => cached(`runs:${env.bucket}:${env.id}:${limit}`, TTL, async () => {
  const bucket = process.env.RUNS_BUCKET || env.bucket;
  const prefix = env.id === 'default' ? 'runs/' : `runs/${env.id.replace(/\/default$/, '')}/`;
  const [files] = await storage.bucket(bucket).getFiles({ prefix, delimiter: '/' });
  const names = files.map((f) => f.name).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, limit);
  const runs = await Promise.all(names.map((n) => readJson(bucket, n).catch(() => null)));
  return runs.filter((r) => r && typeof r === 'object');
});

async function overview() {
  return Promise.all((await listEnvs()).map(async (env) => {
    try {
      const [summary, lock, runs] = await Promise.all([loadSummary(env), loadLock(env), loadRuns(env, 1)]);
      return { ...env, summary, lock, runs };
    } catch (err) {
      report(err, `${env.bucket}/${env.id}`);
      return { ...env, error: err.message };
    }
  }));
}

async function history(env) {
  const name = `${env.id}.tfstate`;
  const [files] = await storage.bucket(env.bucket).getFiles({ prefix: name, versions: true });
  const gens = files.filter((f) => f.name === name)
    .map((f) => ({ generation: f.metadata.generation, updated: f.metadata.timeCreated }))
    .sort((a, b) => (BigInt(a.generation) < BigInt(b.generation) ? 1 : -1))
    .slice(0, GENERATIONS + 1);
  // One at a time, holding the last state for the next diff: never more than two states in memory.
  let held = {};
  const get = async (generation) => (held.generation === generation ? held
    : (held = { generation, state: await fetchState(env, generation) })).state;
  const rows = [];
  for (const [i, g] of gens.slice(0, GENERATIONS).entries()) {
    const prev = gens[i + 1]?.generation;
    // Generations are immutable, so a diff never expires.
    rows.push(await cached(`diff:${env.bucket}:${env.id}:${g.generation}:${prev}`, Infinity, async () => {
      const after = await get(g.generation);
      return { ...g, serial: after.serial, diff: diffStates(prev ? await get(prev) : null, after) };
    }));
  }
  return matchRuns(rows, await loadRuns(env, RUNS));
}

async function route(url) {
  if (url.pathname === '/') return overviewPage(await overview());
  let parts;
  try { parts = url.pathname.split('/').map(decodeURIComponent); } catch { return null; } // malformed %-escape
  const [, page, bucket, ...rest] = parts;
  const env = (await listEnvs()).find((e) => e.bucket === bucket && e.id === rest.join('/'));
  if (!env || !['env', 'history'].includes(page)) return null;
  if (page === 'env') return envPage({ ...env, lock: await loadLock(env) }, await loadState(env));
  const { generations, unmatched } = await history(env);
  return historyPage(env, generations, unmatched);
}

createServer(async (req, res) => {
  const send = (status, body) => res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }).end(String(body));
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, messagePage('Method not allowed'));
  if (req.url === '/health') return res.end('ok');
  const asset = assets[req.url];
  if (asset) return res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }).end(asset.body);
  try {
    const body = await route(new URL(req.url, 'http://localhost'));
    body ? send(200, body) : send(404, messagePage('Not found'));
  } catch (err) {
    report(err, req.url);
    send(500, messagePage(`Error: ${err.message}`));
  }
}).listen(process.env.PORT || 8080, () => console.log(`tfpeek on :${process.env.PORT || 8080}, buckets: ${buckets}`));

// As PID 1 in a container Node ignores SIGTERM unless told otherwise.
process.on('SIGTERM', () => process.exit(0));
