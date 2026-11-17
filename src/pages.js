// HTML pages. Every interpolated value is escaped unless it is itself html`...`.
import { Masked } from './core.js';

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const render = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('')
  : v == null || v === false ? '' : esc(v));
export const html = (strings, ...vals) =>
  new Raw(strings.reduce((out, s, i) => out + render(vals[i - 1]) + s));

const layout = (title, crumbs, body, live) => '<!doctype html>' + html`<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · tfpeek</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script></head><body>
<header class="top"><a class="brand" href="/"><img src="/favicon.svg" alt="" width="22" height="22">tfpeek</a>
<nav class="crumbs" aria-label="Breadcrumb">${crumbs}</nav>${live && html`<span class="live" title="Refreshes every 30 s">● live</span>`}</header>
<main>${body}</main><footer>read-only · secrets masked</footer></body></html>`;

function age(t) {
  const s = Math.max(0, (Date.now() - new Date(t)) / 1000);
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m`
    : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
}
// app.js rewrites both children in the viewer's timezone.
function time(t, compact) {
  const d = new Date(t);
  if (!t || isNaN(d)) return t ?? '';
  return html`<time class="${compact && 'compact'}" datetime="${d.toISOString()}"><span>${d.toLocaleString('sv-SE')}</span> <small>${age(d)} ago</small></time>`;
}

// `<prefix>/<workspace>` -> project (first segment) and branch (the rest).
function names(id) {
  const parts = id.split('/');
  const workspace = parts.pop();
  const project = parts.shift() ?? '';
  const branch = [parts.join('/'), workspace !== 'default' && `[${workspace}]`].filter(Boolean).join(' ');
  return { project, branch };
}
const path = (env) => new Raw(`${env.bucket}/${env.id}`.split('/').map(encodeURIComponent).join('/'));

const lockBadge = (lock) => lock && html`<span class="badge locked">${String(lock.Operation ?? 'locked').replace('OperationType', '').toLowerCase()}
 ${lock.Created && html`· ${age(lock.Created)}`}</span>`;
const OUTCOMES = ['success', 'failure', 'cancelled'];
const runCell = (r, compact) => r && html`<span class="badge ${OUTCOMES.includes(r.outcome) && r.outcome}">${r.outcome ?? 'unknown'}</span>
 ${/^https:\/\//.test(r.run_url) && html`<a href="${r.run_url}" rel="noreferrer" target="_blank">log ↗</a>`}
 ${compact ? time(r.finished_at, true) : html`<small>${r.actor} ${r.commit && html`· <code>${String(r.commit).slice(0, 7)}</code>`}</small>`}`;

function json(v, pad = '') {
  if (v instanceof Masked) return html`<span class="masked" title="Masked by tfpeek">sensitive</span>`;
  if (v === null || typeof v !== 'object') return html`<span class="j-${v === null ? 'null' : typeof v}">${JSON.stringify(v)}</span>`;
  const entries = Object.entries(v), isArray = Array.isArray(v), inner = `${pad}  `;
  if (!entries.length) return isArray ? '[]' : '{}';
  return html`${isArray ? '[' : '{'}\n${entries.map(([k, x], i) => html`${inner}${!isArray &&
    html`<span class="j-key">${JSON.stringify(k)}</span>: `}${json(x, inner)}${i < entries.length - 1 && ','}\n`)}${pad}${isArray ? ']' : '}'}`;
}

const filterBar = (what, extra) => html`<div class="toolbar">
<input type="search" data-filter placeholder="Filter ${what}… ( / )" aria-label="Filter ${what}" autocomplete="off">
<small data-count></small>${extra}</div>`;

export function overviewPage(envs) {
  const multi = new Set(envs.map((e) => e.bucket)).size > 1;
  const locked = envs.filter((e) => e.lock).length;
  const failed = envs.filter((e) => e.error || e.runs?.[0]?.outcome === 'failure').length;
  const stat = (n, label, bad) => html`<div class="stat ${bad && n > 0 && 'bad'}"><b>${n}</b><span>${label}</span></div>`;
  return layout('Overview', '', html`<div class="head"><h1>Environments</h1></div>
${filterBar('environments')}<div id="live">
<div class="stats">${stat(envs.length, 'environments')}${stat(locked, 'locked', true)}${stat(failed, 'failing', true)}
${stat(envs.reduce((n, e) => n + (e.state?.resources.length ?? 0), 0), 'resources')}</div>
<div class="card scroll"><table class="rows">
<tr><th>Project</th><th>Branch</th>${multi && html`<th>Bucket</th>`}<th>Lock</th><th>Serial</th><th>Terraform</th>
<th>Resources</th><th>Last write</th><th>Last run</th></tr>
${envs.map((e) => { const n = names(e.id); return html`<tr data-row data-text="${n.project} ${n.branch} ${e.bucket}">
<td>${n.project}</td><td><a class="rowlink" href="/env/${path(e)}">${n.branch}</a></td>
${multi && html`<td><small>${e.bucket}</small></td>`}<td>${lockBadge(e.lock) || html`<small>–</small>`}</td>
${e.error ? html`<td colspan="3"><span class="badge error">${e.error}</span></td>`
    : html`<td class="num">${e.state.serial}</td><td class="num">${e.state.terraform_version}</td><td class="num">${e.state.resources.length}</td>`}
<td>${time(e.updated)}</td><td>${runCell(e.runs?.[0], true)}</td></tr>`; })}
</table>${!envs.length && html`<p class="empty">No <code>*.tfstate</code> objects found in the configured buckets.</p>`}
<p class="empty" data-nomatch hidden>No environment matches the filter.</p></div></div>`, true);
}

const envHead = (env, current, meta) => { const n = names(env.id); return html`<div class="head"><div><h1>${n.project} <small>/</small> ${n.branch}</h1>
<p class="meta">${meta}</p></div><nav class="tabs">
<a href="/env/${path(env)}" ${current === 'env' && new Raw('aria-current="page"')}>State</a>
<a href="/history/${path(env)}" ${current === 'history' && new Raw('aria-current="page"')}>History</a></nav></div>`; };
const crumbs = (env, tail) => html`<a href="/env/${path(env)}">${names(env.id).project} / ${names(env.id).branch}</a>${tail && html`<span>${tail}</span>`}`;

export function envPage(env, state) {
  const anchor = (dep) => state.resources.find((r) => r.address === dep || r.address.startsWith(`${dep}[`))?.address;
  const modules = [...Map.groupBy(state.resources, (r) => r.module)];
  const outputs = Object.entries(state.outputs);
  return layout(`${names(env.id).project} / ${names(env.id).branch}`, crumbs(env), html`
${envHead(env, 'env', html`serial ${state.serial} · Terraform ${state.terraform_version} · ${state.resources.length} resources · written ${time(env.updated)}
<br>gs://${env.bucket}/${env.id}.tfstate · lineage ${state.lineage}`)}
${env.lock && html`<h2>${lockBadge(env.lock)} State is locked</h2><div class="card lockbox scroll"><table class="kv">
${['Operation', 'Who', 'Created', 'ID', 'Version', 'Info'].filter((k) => env.lock[k]).map((k) =>
    html`<tr><th>${k}</th><td>${k === 'Created' ? time(env.lock[k]) : env.lock[k]}</td></tr>`)}</table></div>`}
<h2>Outputs <small>${outputs.length}</small></h2><div class="card scroll">${outputs.length ? html`<table class="kv">${outputs.map(([k, v]) =>
    html`<tr><th>${k}</th><td><pre>${json(v)}</pre></td></tr>`)}</table>` : html`<p class="empty">No outputs.</p>`}</div>
<h2>Resources <small>${state.resources.length}</small></h2>
${filterBar('resources', html`<button type="button" data-all="open">Expand all</button><button type="button" data-all="close">Collapse all</button>`)}
${modules.map(([module, rs]) => html`<section class="card module" data-group><h3>${module || 'root module'} <small>${rs.length}</small></h3>
${[...Map.groupBy(rs, (r) => r.type)].map(([type, list]) => html`<details class="type" data-group open><summary>${type} <small>${list.length}</small></summary>
${list.map((r) => html`<details class="res" id="${r.address}" data-row data-text="${r.address}"><summary><code>${r.address}</code>
<button type="button" class="copy" data-copy="${r.address}" title="Copy address">copy</button></summary>
<div class="body"><pre>${json(r.attributes)}</pre>${r.dependencies.length > 0 && html`<p class="deps">depends on ${r.dependencies.map((d, i) =>
    html`${i > 0 && ', '}${anchor(d) ? html`<a href="#${encodeURIComponent(anchor(d))}">${d}</a>` : d}`)}</p>`}</div></details>`)}</details>`)}</section>`)}
${!state.resources.length && html`<div class="card"><p class="empty">This state has no resources.</p></div>`}
<div class="card" data-nomatch hidden><p class="empty">No resource matches the filter.</p></div>`);
}

const chip = (n, sign, cls) => html`<span class="${n ? cls : 'zero'}">${sign}${n}</span>`;
const side = (v, sign, cls) => v !== undefined && html`<div class="${cls}">${sign} ${json(v)}</div>`;

export function historyPage(env, generations, otherRuns) {
  return layout(`${names(env.id).project} / ${names(env.id).branch} history`, crumbs(env, 'history'), html`
${envHead(env, 'history', html`newest ${generations.length} state versions · gs://${env.bucket}/${env.id}.tfstate`)}
<div class="card scroll"><table>
<tr><th>Written</th><th>Serial</th><th>Changes</th><th>Run</th></tr>
${generations.map(({ updated, serial, diff: d, run }, i) => html`<tr><td>${time(updated)}</td>
<td class="num">${serial} ${i === 0 && html`<span class="badge">current</span>`}</td>
<td>${d.added.length + d.changed.length + d.removed.length === 0 ? html`<small>no resource changes</small>` : html`<details>
<summary><span class="chips">${chip(d.added.length, '+', 'add')}${chip(d.changed.length, '~', 'chg')}${chip(d.removed.length, '−', 'del')}</span></summary>
<div class="diff">${d.added.map((a) => html`<div class="add">+ ${a}</div>`)}
${d.changed.map((c) => html`<details><summary class="chg">~ ${c.address}</summary>${c.attrs.map((a) =>
    html`<div class="attr"><code>${a.path}</code>${side(a.before, '−', 'del')}${side(a.after, '+', 'add')}</div>`)}</details>`)}
${d.removed.map((a) => html`<div class="del">− ${a}</div>`)}</div></details>`}</td>
<td>${runCell(run)}</td></tr>`)}
</table>${!generations.length && html`<p class="empty">No state versions found.</p>`}</div>
<h2>Runs without a listed state version <small>${otherRuns.length}</small></h2>
<div class="card scroll">${otherRuns.length ? html`<table><tr><th>Started</th><th>Run</th></tr>${otherRuns.map((r) =>
    html`<tr><td>${time(r.started_at)}</td><td>${runCell(r)}</td></tr>`)}</table>`
    : html`<p class="empty">None. Failed or no-op runs show up here.</p>`}</div>`);
}

export const messagePage = (text) => layout(text, '', html`<div class="card"><p class="empty">${text}<br><a href="/">Back to overview</a></p></div>`);
