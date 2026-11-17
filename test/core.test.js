import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { maskState, diffStates, matchRuns } from '../src/core.js';
import { envPage, historyPage, overviewPage } from '../src/pages.js';

const raw = () => JSON.parse(readFileSync(new URL('./fixtures/state.json', import.meta.url)));
const env = { bucket: 'b', id: 'demo/main/default', updated: '2026-01-01T00:00:00Z' };

test('no secret value reaches the rendered HTML', () => {
  const before = maskState(raw());
  const rotated = raw();
  rotated.serial = 8;
  rotated.resources[0].instances[0].attributes.result = 'SECRET-rotated';
  const after = maskState(rotated);
  const gens = [{ updated: env.updated, serial: 8, diff: diffStates(before, after) },
    { updated: env.updated, serial: 7, diff: diffStates(null, before) }];

  const pages = [envPage(env, after), historyPage(env, gens, []), overviewPage([{ ...env, state: after }])].join('');
  assert.doesNotMatch(pages, /SECRET-/);
  assert.match(pages, /class="masked"/);
  // non-secrets stay readable
  assert.match(pages, /public-pem/);
  assert.match(pages, /LOG_LEVEL/);
  assert.match(pages, /module\.api\.google_cloud_run_v2_service\.api\[&#34;eu&#34;\]/);
});

test('diff reports added, changed and removed resources', () => {
  const a = maskState(raw());
  const next = raw();
  next.resources[0].instances[0].attributes.length = 32;
  next.resources[0].instances[0].attributes.result = 'SECRET-rotated';
  next.resources.splice(1, 1);
  next.resources.push({ mode: 'data', type: 'google_project', name: 'this', instances: [{ attributes: { id: 'p' } }] });
  const d = diffStates(a, maskState(next));

  assert.deepEqual(d.added, ['data.google_project.this']);
  assert.deepEqual(d.removed, ['tls_private_key.oauth']);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].address, 'random_password.db');
  // a rotated secret shows up as changed even though both sides are masked
  assert.deepEqual(d.changed[0].attrs.map((x) => x.path), ['length', 'result']);
  assert.deepEqual(diffStates(a, maskState(raw())), { added: [], changed: [], removed: [] });
});

test('runs are matched to the state versions they wrote', () => {
  const runs = [
    { run_url: 'c', serial_before: 42, serial_after: 42 }, // no-op apply
    { run_url: 'b', serial_before: 40, serial_after: 42 }, // wrote twice
    { run_url: 'x', serial_before: null, serial_after: null }, // failed before any state access
    { run_url: 'a', serial_before: 39, serial_after: 40 },
  ];
  const { generations, unmatched } = matchRuns([{ serial: 42 }, { serial: 41 }, { serial: 40 }, { serial: 39 }], runs);
  assert.deepEqual(generations.map((g) => g.run?.run_url), ['b', 'b', 'a', undefined]);
  assert.deepEqual(unmatched.map((r) => r.run_url), ['c', 'x']);
});
