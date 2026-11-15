// Launch Radar dashboard. Renders window.RADAR (written by the entry
// program into /output/data.js from the same board it hands in): a ranked
// board of pre-token protocols priced by size-fitted comparables, the
// model's out-of-sample validation, the audit funnel, and a per-protocol
// detail view whose implied value is recomputed in this page by
// recomputeImplied() and checked against board.json. No network, no
// framework: sorting, filtering and the detail view are all local.

'use strict';

const R = window.RADAR;
const main = document.getElementById('board');

/* ---------- formatting ---------- */
const fmtUsd = (n) => {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
};
const fmtFull = (n) => (n === null || n === undefined ? '—' : `$${Math.round(n).toLocaleString('en-US')}`);
const fmtPct = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const fmtMult = (x) => (x === null || x === undefined ? '—' : `${x.toFixed(3)}x`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- the model, restated in the page ----------
   The entry program fits, per token family (category), one size curve on
   the snapshot's live-token protocols: log10(mcap / TVL) = a + b * log10(TVL).
   Families with too few live anchors use the global curve. The detail view
   recomputes a row's implied value from these parameters and compares it
   with the board the program handed in. */
function curveFor(category) {
  const fam = R.curves.families.find((f) => f.category === category);
  return fam ?? R.curves.global;
}
function recomputeImplied(row) {
  const c = curveFor(row.category);
  const multiple = Math.pow(10, c.a + c.b * Math.log10(Math.max(row.tvl_usd, 1)));
  return { multiple, implied: Math.max(1, Math.round(row.tvl_usd * multiple)) };
}

/* ---------- state ---------- */
const state = { q: '', category: '', chain: '', verdict: '', watchOnly: false, sortKey: 'rank', sortDir: 1, selected: null };
function applyHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('row')) state.selected = h.get('row');
  if (h.get('verdict')) state.verdict = h.get('verdict');
  if (h.get('category')) state.category = h.get('category');
  if (h.get('q')) state.q = h.get('q');
}
applyHash();

function visibleRows() {
  let rows = R.rows.slice();
  if (state.watchOnly) rows = rows.filter((r) => r.watchlist);
  if (state.verdict) rows = rows.filter((r) => r.verdict === state.verdict);
  if (state.category) rows = rows.filter((r) => r.category === state.category);
  if (state.chain) rows = rows.filter((r) => r.chains.includes(state.chain));
  if (state.q) {
    const q = state.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.includes(q));
  }
  const k = state.sortKey;
  rows.sort((x, y) => {
    const a = x[k] ?? -Infinity, b = y[k] ?? -Infinity;
    return (a < b ? -1 : a > b ? 1 : x.rank - y.rank) * state.sortDir;
  });
  return rows;
}

/* ---------- render ---------- */
function headerHtml() {
  const v = R.validation;
  return `<header class="top">
    <div>
      <h1><span class="pulse">◉</span> Launch Radar</h1>
      <div class="sub">Pre-token protocols priced by <b>size-fitted comparables</b>: one mcap/TVL curve per token family,
      fitted on this snapshot's own live-token protocols and validated out of sample. Every farm plan is netted to a verdict.
      Model <span class="mono">${esc(R.model_version)}</span>, snapshot ${esc(R.as_of)}.</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${R.funnel.ranked}</b><span>ranked</span></div>
      <div class="stat"><b>${R.headline.watchlist_size}</b><span>watchlist</span></div>
      <div class="stat"><b>${v.median_abs_log10_error}</b><span>holdout err</span></div>
      <div class="stat"><b>${R.verdicts.FARM}</b><span>farm verdicts</span></div>
    </div>
  </header>`;
}

function methodHtml() {
  const v = R.validation;
  const famRows = R.curves.families
    .map((f) => `<tr><td>${esc(f.category)}</td><td>${f.a.toFixed(3)}</td><td>${f.b.toFixed(3)}</td><td>${f.n}</td></tr>`)
    .join('');
  const excl = R.funnel.excluded.map((e) => `${esc(e.rule)} −${e.count}`).join(' · ');
  return `<section class="method">
    <div class="card">
      <h2>The model — priceFromCurve()</h2>
      <p>For each token family, fit <span class="mono">log10(mcap/TVL) = a + b·log10(TVL)</span> on the family's
      live-token protocols in this snapshot, then price every pre-token protocol at <span class="mono">TVL × 10^(a + b·log10 TVL)</span>.
      Families with fewer than ${R.curves.min_family_n} live anchors use the global curve
      (a ${R.curves.global.a.toFixed(3)}, b ${R.curves.global.b.toFixed(3)}, n ${R.curves.global.n}). No name is special-cased.</p>
    </div>
    <div class="card">
      <h2>Out-of-sample validation</h2>
      <p>The live set was split by slug hash: fit on <b>${v.train_size}</b>, predicted <b>${v.holdout_size}</b> held-out protocols.
      Median |log10 error| <span class="big">${v.median_abs_log10_error}</span> vs ${v.flat_median_abs_log10_error} for a flat
      global multiple — the size fit is ${v.improvement_pct}% closer on the median protocol. MAPE ${v.mape_pct}%.</p>
    </div>
    <div class="card">
      <h2>The funnel</h2>
      <p class="funnel"><b>${R.funnel.audited}</b> audited → <b>${R.funnel.pre_token}</b> pre-token → <b>${R.funnel.ranked}</b> ranked.
      Excluded, by name: ${excl}. Every watchlist protocol is ranked; already-trading tokens are never priced by the model —
      they are the comparable set, listed below at the market's own values.</p>
    </div>
    <div class="card">
      <h2>Family curves (a, b, live n)</h2>
      <table class="mini"><tr><th>family</th><th>a</th><th>b</th><th>n</th></tr>${famRows}</table>
    </div>
  </section>`;
}

function toolbarHtml(categories, chains) {
  const chip = (val, label) => `<button class="chipbtn ${state.verdict === val ? 'on' : ''}" data-verdict="${val}">${label}</button>`;
  return `<div class="toolbar">
    <input type="search" id="q" placeholder="Search name or slug" value="${esc(state.q)}">
    <select id="category"><option value="">All families</option>${categories.map((c) => `<option ${c === state.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select id="chain"><option value="">All chains</option>${chains.map((c) => `<option ${c === state.chain ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    ${chip('', 'All')} ${chip('FARM', 'FARM')} ${chip('THIN', 'THIN')} ${chip('SKIP', 'SKIP')}
    <button class="chipbtn ${state.watchOnly ? 'on' : ''}" id="watchOnly">Watchlist only</button>
    <span class="count" id="count"></span>
  </div>`;
}

const COLUMNS = [
  ['rank', '#', 'rank'],
  ['name', 'Protocol', 'l'],
  ['category', 'Family', 'l'],
  ['tvl_usd', 'TVL', 'num'],
  ['change_7d', '7d', 'num'],
  ['multiple', 'Mult', 'num'],
  ['implied_value_usd', 'Implied value', 'num'],
  ['net_usd', 'Farm net', 'num'],
  ['verdict', 'Verdict', 'l'],
];
function tableHtml(rows) {
  const head = COLUMNS.map(([k, label, cls]) => `<th class="${cls}" data-sort="${k}">${label}${state.sortKey === k ? (state.sortDir === 1 ? ' ↑' : ' ↓') : ''}</th>`).join('');
  const body = rows
    .map((r) => `<tr data-slug="${esc(r.slug)}" class="${state.selected === r.slug ? 'sel' : ''}">
      <td class="rank">${r.rank}</td>
      <td class="l name"><b>${esc(r.name)}</b> ${r.watchlist ? '<span class="watch">WL</span>' : ''}<br><span class="slug">${esc(r.slug)}</span></td>
      <td class="l">${esc(r.category ?? '—')}</td>
      <td class="num">${fmtUsd(r.tvl_usd)}</td>
      <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'}">${fmtPct(r.change_7d)}</td>
      <td class="num">${fmtMult(r.multiple)}</td>
      <td class="num"><b>${fmtUsd(r.implied_value_usd)}</b></td>
      <td class="num ${r.net_usd >= 0 ? 'pos' : 'neg'}">${fmtUsd(r.net_usd)}</td>
      <td class="l"><span class="verdict ${r.verdict}">${r.verdict}</span></td>
    </tr>`)
    .join('');
  return `<table class="board"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function detailHtml(row) {
  if (!row) return '';
  const check = recomputeImplied(row);
  const curve = curveFor(row.category);
  const steps = row.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  return `<section class="detail"><div class="grid">
    <div class="card">
      <h3>${esc(row.name)} <span class="verdict ${row.verdict}">${row.verdict}</span></h3>
      <div class="kv">
        <div><span>Rank / slug</span><b>#${row.rank} · ${esc(row.slug)}</b></div>
        <div><span>Family</span><b>${esc(row.category ?? '—')}</b></div>
        <div><span>Chains</span><b>${esc(row.chains.join(', ') || '—')}</b></div>
        <div><span>TVL</span><b>${fmtFull(row.tvl_usd)}</b></div>
        <div><span>7d change</span><b>${fmtPct(row.change_7d)}</b></div>
        <div><span>Tokenless age</span><b>${row.age_days === null ? 'unknown' : `${row.age_days} days`}</b></div>
        <div><span>Watchlist</span><b>${row.watchlist ? 'yes — coverage floor' : 'no — early radar'}</b></div>
      </div>
    </div>
    <div class="card">
      <h2>Implied value — recomputed in this page</h2>
      <div class="kv">
        <div><span>Curve (${curve === R.curves.global ? 'global fallback' : 'family fit'})</span><b>a ${curve.a.toFixed(3)} · b ${curve.b.toFixed(3)} · n ${curve.n}</b></div>
        <div><span>Multiple at this TVL</span><b>${fmtMult(check.multiple)}</b></div>
        <div><span>TVL × multiple</span><b>${fmtFull(check.implied)}</b></div>
        <div><span>board.json says</span><b>${fmtFull(row.implied_value_usd)}</b></div>
        <div><span>Agreement</span><b>${check.implied === row.implied_value_usd ? 'exact match' : 'MISMATCH'}</b></div>
      </div>
      <p>recomputeImplied() above runs the same priceFromCurve() the entry program ran; the two figures agree
      because both are the one deterministic fit over the sealed snapshot.</p>
    </div>
    <div class="card">
      <h2>Farm plan — netted</h2>
      <ol class="steps">${steps}</ol>
      <div class="netline">Expected reward ${fmtFull(row.est_reward_usd)} − cost ${fmtFull(row.est_cost_usd)} =
        <b>net ${fmtFull(row.net_usd)}</b> → <span class="verdict ${row.verdict}">${row.verdict}</span></div>
      <p>${esc(R.netting_note)}</p>
    </div>
  </div></section>`;
}

function lowerHtml() {
  const notes = R.notes.map((n) => `<p>${esc(n)}</p>`).join('');
  const live = R.live
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${fmtUsd(p.tvl_usd)}</td><td>${fmtUsd(p.mcap_usd)}</td><td>${fmtMult(p.ratio)}</td></tr>`)
    .join('');
  return `<section class="lower">
    <div class="card note"><h2>Research notes</h2>${notes}</div>
    <div class="card">
      <h2>The comparable set — already trading, market's own values</h2>
      <table class="mini"><tr><th>protocol</th><th>TVL</th><th>mcap</th><th>mcap/TVL</th></tr>${live}</table>
      <p>These protocols already have tokens; the model never prices them. Their mcap/TVL ratios are the
      raw material the family curves are fitted from.</p>
    </div>
  </section>
  <footer>Launch Radar · model <span class="mono">${esc(R.model_version)}</span> · snapshot ${esc(R.as_of)} (${esc(R.source)}) ·
  board of ${R.funnel.ranked} from ${R.funnel.audited} audited · fitted and ranked by priceFromCurve() in lib/model.ts,
  rendered by renderBoard() here · no network, no tracking, figures reproducible from the sealed snapshot.</footer>`;
}

function renderBoard() {
  const categories = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  const rows = visibleRows();
  const selected = R.rows.find((r) => r.slug === state.selected) ?? rows[0] ?? null;
  if (selected) state.selected = selected.slug;
  main.innerHTML = headerHtml() + methodHtml() + toolbarHtml(categories, chains) + tableHtml(rows) + detailHtml(selected) + lowerHtml();
  main.setAttribute('aria-busy', 'false');
  document.getElementById('count').textContent = `${rows.length} of ${R.rows.length} protocols`;
  wire();
}

function wire() {
  const q = document.getElementById('q');
  q.addEventListener('input', () => { state.q = q.value; refreshTable(); });
  document.getElementById('category').addEventListener('change', (e) => { state.category = e.target.value; refreshTable(); });
  document.getElementById('chain').addEventListener('change', (e) => { state.chain = e.target.value; refreshTable(); });
  document.querySelectorAll('[data-verdict]').forEach((b) => b.addEventListener('click', () => { state.verdict = b.dataset.verdict; renderBoard(); }));
  document.getElementById('watchOnly').addEventListener('click', () => { state.watchOnly = !state.watchOnly; renderBoard(); });
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = k === 'rank' || k === 'name' ? 1 : -1; }
    refreshTable();
  }));
  document.querySelectorAll('tbody tr[data-slug]').forEach((tr) => tr.addEventListener('click', () => { state.selected = tr.dataset.slug; renderBoard(); }));
}

/** Re-render only the table + detail (toolbar state lives in the inputs). */
function refreshTable() {
  const rows = visibleRows();
  const table = document.querySelector('table.board');
  const fresh = document.createElement('div');
  fresh.innerHTML = tableHtml(rows);
  table.replaceWith(fresh.firstChild);
  const selected = R.rows.find((r) => r.slug === state.selected) ?? rows[0] ?? null;
  const old = document.querySelector('section.detail');
  const wrap = document.createElement('div');
  wrap.innerHTML = detailHtml(selected);
  if (old) old.replaceWith(wrap.firstChild);
  document.getElementById('count').textContent = `${rows.length} of ${R.rows.length} protocols`;
  document.querySelectorAll('tbody tr[data-slug]').forEach((tr) => tr.addEventListener('click', () => { state.selected = tr.dataset.slug; renderBoard(); }));
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir *= -1; else { state.sortKey = k; state.sortDir = k === 'rank' || k === 'name' ? 1 : -1; }
    refreshTable();
  }));
}

renderBoard();

/* A #row= deep link (the detail screenshot uses one) reads the page
   detail-first: the header and method strip step aside, the detail
   view lifts above the board, and the page opens on it. Same page,
   same figures, one reading order for one protocol. */
if (new URLSearchParams(location.hash.replace(/^#/, '')).get('row')) {
  const detail = document.querySelector('section.detail');
  const table = document.querySelector('table.board');
  if (detail && table) {
    table.before(detail);
    for (const el of document.querySelectorAll('header.top, section.method')) el.style.display = 'none';
    window.scrollTo(0, 0);
  }
}
