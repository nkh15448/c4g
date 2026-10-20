// Lesson Plan Finder: loads the index the build made and searches it in the browser.
import MiniSearch from './vendor/minisearch.js';
import { INDEX_OPTIONS, fold } from './search-config.js';

const PAGE_SIZE = 20;        // plans shown before "Show more"
const NEW_DAYS = 14;         // plans added this recently get a "New" tag
const SNIPPET_CHARS = 220;   // length of each text excerpt
const SNIPPETS_PER_PLAN = 2;

const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'), clear: $('clear'), subjects: $('subjects'), grades: $('grades'),
  status: $('status'), results: $('results'), more: $('more'), stats: $('stats'), guide: $('guide'),
};
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const foldedCache = new WeakMap();

const state = { q: '', subject: '', grade: '', limit: PAGE_SIZE };
let docs = [];
let index;

async function init() {
  readUrl();
  let data;
  try {
    const [docsRes, indexRes] = await Promise.all([fetchOk('data/docs.json'), fetchOk('data/index.json')]);
    data = await docsRes.json();
    index = await MiniSearch.loadJSONAsync(await indexRes.text(), INDEX_OPTIONS);
  } catch (err) {
    console.error(err);
    els.status.textContent = 'Couldn’t load the lesson plans. Refresh the page to try again.';
    return;
  }
  docs = data.docs;
  if (!docs.some((d) => d.subjectKey === state.subject)) state.subject = '';
  if (!docs.some((d) => d.gradeKey === state.grade)) state.grade = '';

  renderFooter(data);
  els.q.disabled = false;
  els.q.value = state.q;
  bindEvents();
  update();
  if (!matchMedia('(pointer: coarse)').matches) els.q.focus();
}

function bindEvents() {
  let timer;
  els.q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => setQuery(els.q.value), 60);
  });
  els.q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.q.value) {
      e.preventDefault();
      els.q.value = '';
      setQuery('');
    }
    // On phones, Enter tucks the keyboard away so the results are visible.
    if (e.key === 'Enter' && matchMedia('(pointer: coarse)').matches) els.q.blur();
  });
  els.clear.addEventListener('click', () => {
    els.q.value = '';
    setQuery('');
    els.q.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    els.q.focus();
    els.q.select();
  });
  els.subjects.addEventListener('click', (e) => onChip(e, 'subject'));
  els.grades.addEventListener('click', (e) => onChip(e, 'grade'));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="clear-filters"]')) return;
    state.subject = state.grade = '';
    state.limit = PAGE_SIZE;
    update();
  });
  els.more.addEventListener('click', () => {
    state.limit += PAGE_SIZE;
    update();
  });

  const bar = document.querySelector('.searchbar');
  new IntersectionObserver(([entry]) => bar.classList.toggle('stuck', !entry.isIntersecting))
    .observe($('sentinel'));
}

function setQuery(q) {
  state.q = q;
  state.limit = PAGE_SIZE;
  update();
}

function onChip(e, key) {
  const chip = e.target.closest('button[data-key]');
  if (!chip) return;
  // Clicking the selected chip again goes back to "All".
  state[key] = state[key] === chip.dataset.key ? '' : chip.dataset.key;
  if (key === 'subject' && state.grade && !docs.some((d) => d.gradeKey === state.grade && inSubject(d))) {
    state.grade = '';
  }
  state.limit = PAGE_SIZE;
  update();
  e.currentTarget.querySelector(`button[data-key="${CSS.escape(state[key])}"]`)?.focus();
}

function update() {
  const result = search();
  renderChips(result);
  renderStatus(result);
  renderResults(result);
  els.clear.hidden = !els.q.value;
  writeUrl();
}

// Search ---------------------------------------------------------------------

const inSubject = (d) => !state.subject || d.subjectKey === state.subject;
const inGrade = (d) => !state.grade || d.gradeKey === state.grade;

function search() {
  const q = state.q.trim();
  let hits;
  let partial = false;
  if (q.length < 2) {
    hits = docs
      .map((doc) => ({ doc, terms: [] }))
      .sort((a, b) => b.doc.added.localeCompare(a.doc.added) || collator.compare(a.doc.title, b.doc.title));
  } else {
    let found = index.search(q);
    // Nothing has every word? Fall back to plans with any of them.
    if (!found.length) {
      found = index.search(q, { combineWith: 'OR' });
      partial = found.length > 0;
    }
    hits = found.map((r) => ({ doc: docs[r.id], terms: r.terms }));
  }
  return {
    q: q.length < 2 ? '' : q,
    partial,
    hits: hits.filter((h) => inSubject(h.doc) && inGrade(h.doc)),
    subjectCounts: countBy(hits.filter((h) => inGrade(h.doc)), 'subjectKey'),
    gradeCounts: countBy(hits.filter((h) => inSubject(h.doc)), 'gradeKey'),
  };
}

function countBy(hits, key) {
  const counts = new Map();
  for (const { doc } of hits) counts.set(doc[key], (counts.get(doc[key]) ?? 0) + 1);
  return counts;
}

/** Pages of a plan that contain the matched words, best first. */
function pageMatches(doc, terms) {
  const out = [];
  foldedPages(doc).forEach((text, i) => {
    const hits = findHits(text, terms);
    if (hits.length) out.push({ page: i + 1, hits, score: distinct(hits) * 1000 + hits.length });
  });
  return out.sort((a, b) => b.score - a.score || a.page - b.page);
}

function foldedPages(doc) {
  let pages = foldedCache.get(doc);
  if (!pages) foldedCache.set(doc, (pages = doc.pages.map(fold)));
  return pages;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whole-word positions of each term in (already folded) text. */
function findHits(text, terms) {
  const hits = [];
  for (const term of terms) {
    for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + term.length)) {
      const end = i + term.length;
      if (!WORD_CHAR.test(text[i - 1] ?? '') && !WORD_CHAR.test(text[end] ?? '')) hits.push({ start: i, end, term });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

const distinct = (hits) => new Set(hits.map((h) => h.term)).size;

/** The stretch of a page where the most different search words appear together. */
function excerptWindow(text, hits) {
  let best = { a: 0, b: 1, score: -1 };
  for (let a = 0, b = 1; a < hits.length; a++) {
    b = Math.max(b, a + 1);
    while (b < hits.length && hits[b].end - hits[a].start <= SNIPPET_CHARS) b++;
    const score = distinct(hits.slice(a, b)) * 1000 + (b - a);
    if (score > best.score) best = { a, b, score };
  }
  const first = hits[best.a].start;
  const last = hits[best.b - 1].end;
  const pad = Math.max(0, SNIPPET_CHARS - (last - first)) / 2;
  let start = Math.max(0, Math.round(first - pad));
  let end = Math.min(text.length, Math.round(last + pad));
  if (start === 0) end = Math.min(text.length, Math.max(end, SNIPPET_CHARS));
  if (end === text.length) start = Math.max(0, Math.min(start, text.length - SNIPPET_CHARS));
  // Don't cut words in half.
  if (start > 0 && !/\s/.test(text[start - 1])) {
    const i = text.slice(start, first).search(/\s/);
    start = i === -1 ? first : start + i + 1;
  }
  if (end < text.length && !/\s/.test(text[end])) {
    const i = text.slice(last, end).search(/\s\S*$/);
    end = i === -1 ? last : last + i;
  }
  return { start, end };
}

// Rendering ------------------------------------------------------------------

function renderChips({ subjectCounts, gradeCounts }) {
  if (!docs.length) return;
  const total = (counts) => [...counts.values()].reduce((a, b) => a + b, 0);

  const subjects = facet('subjectKey', 'subject', () => true);
  els.subjects.innerHTML = chip('', 'All subjects', total(subjectCounts), !state.subject)
    + subjects.map(([key, label]) => chip(key, label, subjectCounts.get(key) ?? 0, state.subject === key, tone(key))).join('');

  const grades = facet('gradeKey', 'grade', inSubject);
  els.grades.hidden = !grades.length;
  els.grades.innerHTML = chip('', 'All grades', total(gradeCounts), !state.grade)
    + grades.map(([key, label]) => chip(key, label, gradeCounts.get(key) ?? 0, state.grade === key)).join('');
}

/** Distinct [key, label] pairs among the plans, in a sensible order. */
function facet(key, labelKey, keep) {
  const seen = new Map();
  for (const d of docs) if (d[key] && keep(d) && !seen.has(d[key])) seen.set(d[key], d[labelKey]);
  // KG first, JHS/SHS last, everything else (Grade 1, Basic 4…) by number
  const rank = (label) => (/^kg/i.test(label) ? 0 : /^jhs/i.test(label) ? 2 : /^shs/i.test(label) ? 3 : 1);
  return [...seen].sort((a, b) => rank(a[1]) - rank(b[1]) || collator.compare(a[1], b[1]));
}

function chip(key, label, count, active, cls = '') {
  return `<button type="button" class="chip ${cls}" data-key="${esc(key)}" aria-pressed="${active}"${count || active ? '' : ' data-empty'}>`
    + `${esc(label)}<span class="count">${count}</span></button>`;
}

function tone(subjectKey) {
  if (/math/.test(subjectKey)) return 'tone-green';
  if (/sci/.test(subjectKey)) return 'tone-red';
  if (/lit|read|english|writ|phonic|lang/.test(subjectKey)) return 'tone-gold';
  return '';
}

function renderStatus({ q, hits, partial }) {
  const where = [docs.find((d) => d.subjectKey === state.subject)?.subject, docs.find((d) => d.gradeKey === state.grade)?.grade]
    .filter(Boolean).join(' · ');
  const n = hits.length;
  const plans = (k) => `${k} lesson plan${k === 1 ? '' : 's'}`;
  let html = '';
  if (!docs.length) html = '';
  else if (!q) html = `${where ? `<b>${esc(where)}</b>: ` : ''}${plans(n)}, newest first`;
  else if (!n) html = `No lesson plans match <b>“${esc(q)}”</b>${where ? ` in ${esc(where)}` : ''}.`;
  else if (partial) html = `No plan has every word of <b>“${esc(q)}”</b>. Showing ${n === 1 ? 'the 1 plan' : `${n} plans`} with some of them.`;
  else html = `<b>${n}</b> ${n === 1 ? 'plan matches' : 'plans match'} <b>“${esc(q)}”</b>${where ? ` in ${esc(where)}` : ''}`;
  els.status.innerHTML = html;
}

function renderResults({ q, hits }) {
  els.more.hidden = true;
  if (!docs.length) {
    els.results.innerHTML = '<div class="empty"><p><b>No lesson plans yet.</b></p><p>Once lesson plan makers upload PDFs, they’ll show up here.</p></div>';
    return;
  }
  if (!hits.length) {
    const filtered = state.subject || state.grade;
    els.results.innerHTML = `<div class="empty">${q ? '<p>Check the spelling, or try a shorter or different word.</p>' : '<p>No lesson plans here yet.</p>'}`
      + `${filtered ? '<p><button type="button" class="linkish" data-action="clear-filters">Search all subjects and grades</button></p>' : ''}</div>`;
    return;
  }
  const shown = hits.slice(0, state.limit);
  els.results.innerHTML = shown.map(card).join('');
  const left = hits.length - shown.length;
  if (left > 0) {
    els.more.hidden = false;
    els.more.textContent = `Show ${Math.min(left, PAGE_SIZE)} more`;
  }
}

function card({ doc, terms }) {
  const url = pdfUrl(doc);
  const matches = terms.length ? pageMatches(doc, terms) : [];
  const top = matches.slice(0, SNIPPETS_PER_PLAN);
  const rest = matches.slice(SNIPPETS_PER_PLAN).map((m) => m.page).sort((a, b) => a - b);

  let snips = top.map((m) => snipLink(url, m.page, snippet(doc.pages[m.page - 1], m.hits))).join('');
  if (!snips && doc.pages[0]) snips = snipLink(url, 1, esc(squash(doc.pages[0].slice(0, 300))), 'preview');

  const isNew = Date.now() - Date.parse(doc.added) < NEW_DAYS * 864e5;
  const flag = doc.error ? '<span class="warn">Couldn’t read this PDF, so only its title is searchable</span>'
    : doc.noText ? '<span class="warn">Scanned PDF, so only its title is searchable</span>' : '';

  return `<article class="card">
    <div class="tags">
      <span class="tag ${tone(doc.subjectKey)}">${esc(doc.subject)}</span>
      ${doc.grade ? `<span class="tag">${esc(doc.grade)}</span>` : ''}
      ${isNew ? '<span class="tag new">New</span>' : ''}
    </div>
    <h2 class="card-title"><a href="${url}" target="_blank" rel="noopener">${highlight(doc.title, terms)}</a></h2>
    ${snips ? `<div class="snips">${snips}</div>` : ''}
    ${rest.length ? `<p class="also">Also on ${pageLinks(url, rest)}</p>` : ''}
    <div class="card-foot">
      ${doc.pageCount ? `<span>${doc.pageCount} page${doc.pageCount === 1 ? '' : 's'}</span>` : ''}
      <span>Added ${fmtDate(doc.added)}</span>
      ${flag}
      <a class="open" href="${url}" target="_blank" rel="noopener">Open PDF ↗</a>
    </div>
  </article>`;
}

function snipLink(url, page, html, cls = '') {
  return `<a class="snip ${cls}" href="${url}#page=${page}" target="_blank" rel="noopener">`
    + `<span class="pg">p. ${page}</span><span class="snip-text">${html}</span></a>`;
}

function pageLinks(url, pages) {
  const links = pages.slice(0, 12).map((p) => `<a href="${url}#page=${p}" target="_blank" rel="noopener">p. ${p}</a>`).join(', ');
  return pages.length > 12 ? `${links} and ${pages.length - 12} more` : links;
}

function snippet(text, hits) {
  const { start, end } = excerptWindow(text, hits);
  return (start > 0 ? '…' : '') + markup(text, hits, start, end).trim() + (end < text.length ? '…' : '');
}

function highlight(text, terms) {
  return terms.length ? markup(text, findHits(fold(text), terms), 0, text.length) : esc(text);
}

/** text[start..end) as HTML, with the hits wrapped in <mark>. */
function markup(text, hits, start, end) {
  let html = '';
  let pos = start;
  for (const h of hits) {
    if (h.start < pos || h.end > end) continue;
    html += `${esc(squash(text.slice(pos, h.start)))}<mark>${esc(text.slice(h.start, h.end))}</mark>`;
    pos = h.end;
  }
  return html + esc(squash(text.slice(pos, end)));
}

function renderFooter(data) {
  const pages = data.docs.reduce((n, d) => n + d.pageCount, 0);
  const num = (n) => n.toLocaleString('en-US');
  els.stats.textContent = `${num(data.docs.length)} lesson plans · ${num(pages)} pages searchable · updated ${fmtDate(data.generated.slice(0, 10))}`;
  if (data.repo) {
    els.guide.href = `${data.repo}#adding-a-lesson-plan`;
    els.guide.hidden = false;
  }
}

// Helpers --------------------------------------------------------------------

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') ?? '';
  state.subject = p.get('subject') ?? '';
  state.grade = p.get('grade') ?? '';
}

/** Keeps the address bar in sync so a search can be shared as a link. */
function writeUrl() {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set('q', state.q.trim());
  if (state.subject) p.set('subject', state.subject);
  if (state.grade) p.set('grade', state.grade);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

async function fetchOk(url) {
  const res = await fetch(url, { cache: 'no-cache' }); // revalidate so new uploads show up right away
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const pdfUrl = (doc) => doc.path.split('/').map(encodeURIComponent).join('/');
const squash = (s) => s.replace(/\s+/g, ' ');

function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

init();
