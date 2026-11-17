// Progressive enhancement only: every page works without this file.
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const input = document.querySelector('[data-filter]');
const live = document.getElementById('live');

function rel(d) {
  const s = (Date.now() - d) / 1000;
  return s < 45 ? 'just now' : s < 5400 ? `${Math.round(s / 60)}m ago`
    : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}
// Server renders its own timezone; show the viewer's instead and keep the age ticking.
function times() {
  for (const t of $$('time[datetime]')) {
    const d = new Date(t.dateTime);
    t.title = d.toISOString();
    t.children[0].textContent = d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    t.children[1].textContent = rel(d);
  }
}

function filter() {
  if (!input) return;
  const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = $$('[data-row]');
  for (const r of rows) r.hidden = !terms.every((t) => r.dataset.text.toLowerCase().includes(t));
  for (const g of $$('[data-group]')) g.hidden = !g.querySelector('[data-row]:not([hidden])');
  const shown = rows.filter((r) => !r.hidden).length;
  for (const c of $$('[data-count]')) c.textContent = terms.length ? `${shown} of ${rows.length}` : '';
  for (const e of $$('[data-nomatch]')) e.hidden = shown > 0 || !rows.length;
  const url = new URL(location);
  terms.length ? url.searchParams.set('q', input.value) : url.searchParams.delete('q');
  history.replaceState(null, '', url);
}

// Open a linked resource (#address) together with its collapsed parents.
function openTarget() {
  const el = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  for (let n = el; n; n = n.parentElement) {
    n.hidden = false;
    if (n.tagName === 'DETAILS') n.open = true;
  }
  el?.scrollIntoView({ block: 'center' });
}

document.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    e.preventDefault();
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
      copy.textContent = 'copied';
      setTimeout(() => { copy.textContent = 'copy'; }, 1200);
    });
  }
  const all = e.target.closest('[data-all]');
  if (all) for (const d of $$('details[data-row]:not([hidden]), details[data-group]')) d.open = d.matches('[data-group]') || all.dataset.all === 'open';
});
document.addEventListener('keydown', (e) => {
  if (!input) return;
  if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); input.select(); }
  if (e.key === 'Escape' && document.activeElement === input) { input.value = ''; filter(); input.blur(); }
});
input?.addEventListener('input', filter);
addEventListener('hashchange', openTarget);

if (input) input.value = new URL(location).searchParams.get('q') ?? '';
times(); filter(); openTarget();
setInterval(times, 30_000);

// Overview refreshes itself while the tab is visible.
if (live) setInterval(async () => {
  if (document.hidden) return;
  try {
    const res = await fetch(location.pathname);
    if (!res.ok) return;
    const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('live');
    live.replaceChildren(...fresh.childNodes);
    times(); filter();
  } catch { /* keep the stale view, next tick retries */ }
}, 30_000);
