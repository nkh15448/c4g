#!/usr/bin/env node
// Builds the site into dist/:
//   1. pulls the text out of every PDF under lesson-plans/ (cached by file
//      hash; scanned pages get OCR'd when pdftoppm + tesseract are installed)
//   2. builds the search index the page loads
//   3. copies the page, the index and the PDFs into dist/
//
//   npm run build                       index ./lesson-plans
//   npm run build -- --plans <folder>   index another folder (e.g. test PDFs)

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { INDEX_OPTIONS } from '../site/search-config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const PLANS = resolve(args.plans ?? join(ROOT, 'lesson-plans'));
const OUT = resolve(args.out ?? join(ROOT, 'dist'));
const CACHE = join(ROOT, '.cache', 'text');
const CACHE_VERSION = 1;   // bump when extraction changes, to re-read every PDF
const MIN_PAGE_LETTERS = 25; // fewer than this and a page is treated as scanned
const HAS_OCR = hasCommand('pdftoppm') && hasCommand('tesseract');
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

const files = findPdfs(PLANS).sort((a, b) => a.localeCompare(b));
const addedDates = gitAddedDates(PLANS);
const docs = [];

for (const [id, file] of files.entries()) {
  const rel = relative(PLANS, file).split(sep).join('/');
  const { pages, ocrPages, unreadPages, error } = await readPdf(file);
  docs.push({
    id,
    path: `lesson-plans/${rel}`,
    ...describe(rel),
    added: addedDates.get(file) ?? statSync(file).mtime.toISOString().slice(0, 10),
    pageCount: error ? 0 : pages.length,
    pages,
    ocr: ocrPages.length > 0,
    noText: !error && unreadPages.length === pages.length,
    error: error ?? null,
  });
}

const index = new MiniSearch(INDEX_OPTIONS);
index.addAll(docs.map((d) => ({
  id: d.id,
  title: d.title,
  folders: d.folders.join(' '),
  text: d.pages.join('\n\n'),
})));

// Write dist/
rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'site'), OUT, { recursive: true });
mkdirSync(join(OUT, 'vendor'));
writeFileSync(
  join(OUT, 'vendor', 'minisearch.js'),
  readFileSync(fileURLToPath(import.meta.resolve('minisearch')), 'utf8')
    .replace(/^\/\/# sourceMappingURL=.*$/m, ''),
);
mkdirSync(join(OUT, 'data'));
writeFileSync(join(OUT, 'data', 'index.json'), JSON.stringify(index));
writeFileSync(join(OUT, 'data', 'docs.json'), JSON.stringify({
  generated: new Date().toISOString(),
  repo: repoUrl(),
  docs,
}));
for (const [i, file] of files.entries()) cpSync(file, join(OUT, docs[i].path));

report();

// ---------------------------------------------------------------------------

async function readPdf(file) {
  const bytes = readFileSync(file);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const cacheFile = join(CACHE, `v${CACHE_VERSION}-${hash}.json`);
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    // Scanned pages skipped on a machine without OCR get another try here.
    if (!(cached.unreadPages.length && HAS_OCR && !cached.ocrTried)) return cached;
  }
  const result = await extract(file, bytes);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

async function extract(file, bytes) {
  const result = { pages: [], ocrPages: [], unreadPages: [], ocrTried: HAS_OCR };
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    await task.destroy();
    result.error = err.name === 'PasswordException' ? 'PDF is password-protected' : err.message;
    return result;
  }
  for (let n = 1; n <= pdf.numPages; n++) {
    let text = '';
    try {
      const page = await pdf.getPage(n);
      for (const item of (await page.getTextContent()).items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      page.cleanup();
    } catch { /* unreadable page: falls through to OCR */ }
    text = clean(text);
    if (countLetters(text) < MIN_PAGE_LETTERS) {
      const ocr = HAS_OCR ? clean(ocrPage(file, n)) : '';
      if (countLetters(ocr) >= MIN_PAGE_LETTERS) {
        text = ocr;
        result.ocrPages.push(n);
      } else {
        result.unreadPages.push(n);
      }
    }
    result.pages.push(text);
  }
  await task.destroy();
  return result;
}

function ocrPage(file, n) {
  const dir = mkdtempSync(join(tmpdir(), 'c4g-ocr-'));
  try {
    const png = join(dir, 'page');
    execFileSync('pdftoppm', ['-f', `${n}`, '-l', `${n}`, '-r', '300', '-gray', '-png', '-singlefile', file, png], { stdio: 'ignore' });
    return execFileSync('tesseract', [`${png}.png`, 'stdout'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function clean(text) {
  return text
    .normalize('NFKC')                         // ligatures (ﬁ → fi), full-width chars
    .replace(/­/g, '')                    // soft hyphens
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')  // words hyphenated across lines
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countLetters(text) {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/** "math/grade-3/Week_6.pdf" → title, subject and grade for the filters. */
function describe(rel) {
  const parts = rel.split('/');
  const name = parts.pop();
  const folders = parts.map(pretty);
  return {
    title: titleFromFile(name),
    subject: folders[0] ?? 'Other',
    subjectKey: slug(parts[0] ?? 'other'),
    grade: folders[1] ?? '',
    gradeKey: parts[1] ? slug(parts[1]) : '',
    folders,
  };
}

function titleFromFile(name) {
  let base = name.replace(/\.pdf$/i, '');
  base = /\s/.test(base) ? base.replace(/_+/g, ' ') : base.replace(/[-_]+/g, ' ');
  return base.replace(/\s+/g, ' ').trim();
}

function slug(s) {
  return s.toLowerCase().trim().replace(/[\s_-]+/g, '-');
}

/** "grade-3" → "Grade 3", "jhs_1" → "JHS 1" */
function pretty(folder) {
  return folder.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
    .map((w) => (/^(kg|jhs|shs|[pb]\d+)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** When each PDF was first committed, from git history (newest add wins). */
function gitAddedDates(dir) {
  const dates = new Map();
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (top.status !== 0) return dates;
  const root = top.stdout.trim();
  const log = spawnSync(
    'git',
    ['-c', 'core.quotePath=false', 'log', '--diff-filter=A', '--format=@%cs', '--name-only', '--', relative(root, dir) || '.'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  let date = null;
  for (const line of log.stdout?.split('\n') ?? []) {
    if (line.startsWith('@')) date = line.slice(1);
    else if (line) {
      const file = resolve(root, line);
      if (!dates.has(file)) dates.set(file, date);
    }
  }
  return dates;
}

function repoUrl() {
  if (process.env.GITHUB_REPOSITORY) {
    return `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`;
  }
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' });
  const m = origin.stdout?.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}` : null;
}

function findPdfs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPdfs(full));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) out.push(full);
  }
  return out;
}

function hasCommand(cmd) {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(plans|out)(?:=(.*))?$/);
    if (!m) throw new Error(`Unknown argument: ${argv[i]}`);
    out[m[1]] = m[2] ?? argv[++i];
  }
  return out;
}

function report() {
  const pageTotal = docs.reduce((n, d) => n + d.pageCount, 0);
  const ocrd = docs.filter((d) => d.ocr);
  console.log(`Indexed ${docs.length} lesson plans (${pageTotal} pages) → ${relative(process.cwd(), OUT) || '.'}/`);
  if (ocrd.length) console.log(`  OCR'd scanned pages in ${ocrd.length} PDF(s)`);
  const warn = (doc, msg) => {
    if (IN_ACTIONS) console.log(`::warning file=${doc.path}::${msg}`);
    else console.warn(`  ⚠ ${doc.path}: ${msg}`);
  };
  for (const d of docs) {
    if (d.error) warn(d, `couldn't open this PDF (${d.error}). Only its title is searchable.`);
    else if (d.noText) {
      warn(d, HAS_OCR
        ? 'no readable text, even with OCR. Only its title is searchable.'
        : 'looks scanned (no text). It will be OCR\'d on GitHub; locally only its title is searchable.');
    }
  }
}
