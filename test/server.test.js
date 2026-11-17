// Smoke test of the real server against fake-gcs-server. Skipped unless STORAGE_EMULATOR_HOST is set:
//   docker run -d -p 4443:4443 fsouza/fake-gcs-server -scheme http -backend memory
//   STORAGE_EMULATOR_HOST=http://localhost:4443/storage/v1 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const emulator = process.env.STORAGE_EMULATOR_HOST;

test('pages render from a bucket', { skip: !emulator && 'STORAGE_EMULATOR_HOST not set' }, async (t) => {
  const gcs = new URL(emulator).origin;
  const bucket = `tfpeek-test-${Date.now()}`;
  const post = async (path, body) => {
    const res = await fetch(gcs + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.ok(res.ok, `${path}: ${res.status}`);
  };
  const put = (name, body) => post(`/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`, body);

  const state = JSON.parse(readFileSync(new URL('./fixtures/state.json', import.meta.url)));
  const now = new Date().toISOString();
  await post('/storage/v1/b?project=test', JSON.stringify({ name: bucket, versioning: { enabled: true } }));
  await put('shop/main/default.tfstate', JSON.stringify({ ...state, serial: 6, resources: state.resources.slice(1) }));
  await put('shop/main/default.tfstate', JSON.stringify(state)); // serial 7
  await put('shop/main/default.tflock', JSON.stringify({ ID: 'x', Operation: 'OperationTypeApply', Who: 'ci', Created: now }));
  await put('runs/shop/main/20260101T000000Z-1.json', JSON.stringify({
    run_url: 'https://github.com/example/shop/actions/runs/1/attempts/1', outcome: 'success', serial_before: 6, serial_after: 7,
  }));
  await put('default.tfstate', JSON.stringify(state)); // no backend prefix
  await put('shop/main/notes.json', '"SECRET-unlisted"');

  const port = 18000 + (process.pid % 1000);
  const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: port, STATE_BUCKETS: bucket }, stdio: 'inherit' });
  t.after(() => server.kill());
  const get = async (path) => {
    for (let i = 0; ; i++) {
      try { const res = await fetch(`http://localhost:${port}${path}`); return { status: res.status, body: await res.text() }; }
      catch (err) { if (i > 50) throw err; await new Promise((r) => setTimeout(r, 100)); } // server still starting
    }
  };

  const overview = await get('/');
  assert.equal(overview.status, 200);
  assert.match(overview.body, /class="badge locked"/);
  assert.match(overview.body, new RegExp(`href="/env/${bucket}/default"`)); // root-level state is listed and linked

  const env = await get(`/env/${bucket}/shop/main/default`);
  assert.equal(env.status, 200);
  assert.match(env.body, /tls_private_key\.oauth/);

  const history = await get(`/history/${bucket}/shop/main/default`);
  assert.equal(history.status, 200);
  assert.match(history.body, /actions\/runs\/1\/attempts\/1/); // run linked to the version it wrote
  assert.match(history.body, /\+ random_password\.db/);

  assert.doesNotMatch(overview.body + env.body + history.body, /SECRET-/);
  // only listed state objects are reachable
  assert.equal((await get(`/env/${bucket}/shop/main/notes`)).status, 404);
  assert.equal((await get('/env/other-bucket/shop/main/default')).status, 404);
  assert.equal((await get('/env/%E0%A4%A')).status, 404);
});
