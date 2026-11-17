// Pure logic: masking, diffing, run matching. No I/O.
import { createHash } from 'node:crypto';

// Stands in for a secret. Keeps only a digest, so diffs still see a rotation.
export class Masked {
  constructor(value) {
    this.digest = createHash('sha256').update(JSON.stringify(value)).digest('base64');
  }
  toJSON() { return '(sensitive)'; }
  toString() { return '(sensitive)'; }
}

const SECRET_NAME = /secret|password|private_key|token|credential|api_?key/i;
const ALWAYS = { random_password: ['result', 'bcrypt_hash'] };

const isEmpty = (v) => v == null || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);
const mask = (v) => (isEmpty(v) || v instanceof Masked ? v : new Masked(v));

// Masks values under secret-looking keys, and `value` next to a secret-looking `name` (env vars).
function maskByName(v) {
  if (Array.isArray(v)) return v.map(maskByName);
  if (!v || typeof v !== 'object' || v instanceof Masked) return v;
  const named = typeof v.name === 'string' && SECRET_NAME.test(v.name);
  return Object.fromEntries(Object.entries(v).map(([k, x]) =>
    [k, SECRET_NAME.test(k) || (named && k === 'value') ? mask(x) : maskByName(x)]));
}

// path: [{type: 'get_attr', value: 'name'} | {type: 'index', value: {value: 0}}]
function maskPath(node, path) {
  if (!Array.isArray(path)) throw new Error('unknown sensitive_attributes format');
  if (!node || typeof node !== 'object' || node instanceof Masked) return;
  const [step, ...rest] = path;
  const key = step.type === 'index' ? (step.value?.value ?? step.value) : step.value;
  if (!(key in node)) return;
  if (rest.length) maskPath(node[key], rest);
  else node[key] = mask(node[key]);
}

const address = (r, i) =>
  (r.module ? `${r.module}.` : '') + (r.mode === 'data' ? 'data.' : '') + `${r.type}.${r.name}` +
  (i.index_key === undefined ? '' : `[${JSON.stringify(i.index_key)}]`);

// Raw state v4 in, slim secret-free state out. Mutates the input; nothing else may see raw state.
export function maskState(state) {
  const resources = [];
  for (const r of state.resources ?? []) {
    for (const i of r.instances ?? []) {
      const attrs = i.attributes ?? {};
      for (const path of i.sensitive_attributes ?? []) maskPath(attrs, path);
      for (const k of ALWAYS[r.type] ?? []) if (k in attrs) attrs[k] = mask(attrs[k]);
      resources.push({
        address: address(r, i),
        module: r.module ?? '',
        type: (r.mode === 'data' ? 'data.' : '') + r.type,
        attributes: maskByName(attrs),
        dependencies: i.dependencies ?? [],
      });
    }
  }
  const outputs = Object.fromEntries(Object.entries(state.outputs ?? {}).map(([k, o]) =>
    [k, o.sensitive || SECRET_NAME.test(k) ? mask(o.value) : maskByName(o.value)]));
  return {
    serial: state.serial,
    lineage: state.lineage,
    terraform_version: state.terraform_version,
    outputs,
    resources,
  };
}

function flatten(v, path = '', out = new Map()) {
  if (v && typeof v === 'object' && !(v instanceof Masked) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) flatten(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, v);
  return out;
}
const sig = (v) => (v instanceof Masked ? `M${v.digest}` : JSON.stringify(v));

// Both arguments are masked states; `before` may be null (first generation).
export function diffStates(before, after) {
  const old = new Map((before?.resources ?? []).map((r) => [r.address, r]));
  const added = [], changed = [];
  for (const r of after.resources) {
    const o = old.get(r.address);
    if (!o) { added.push(r.address); continue; }
    old.delete(r.address);
    const a = flatten(o.attributes), b = flatten(r.attributes);
    const attrs = [...new Set([...a.keys(), ...b.keys()])]
      .filter((k) => sig(a.get(k)) !== sig(b.get(k)))
      .map((k) => ({ path: k, before: a.get(k), after: b.get(k) }));
    if (attrs.length) changed.push({ address: r.address, attrs });
  }
  return { added, changed, removed: [...old.keys()] };
}

// A run owns every serial in (serial_before, serial_after]: one apply can write state more than once.
export function matchRuns(generations, runs) {
  const owns = (r, serial) => r.serial_after != null && serial <= r.serial_after &&
    serial > (r.serial_before ?? r.serial_after - 1);
  const used = new Set();
  const matched = generations.map((g) => {
    const run = runs.find((r) => owns(r, g.serial));
    if (run) used.add(run);
    return { ...g, run };
  });
  return { generations: matched, unmatched: runs.filter((r) => !used.has(r)) };
}
