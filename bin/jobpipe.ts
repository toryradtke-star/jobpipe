#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * jobpipe — poll job boards, screen them against your own rules, judge what
 * survives, and track what you applied to.
 *
 * Each command does one thing:
 *   init     create starter profile files
 *   verify   check every board in the registry still answers
 *   poll     fetch every board and store what is new
 *   screen   apply the deterministic rule-outs to everything unscreened
 *   judge    send survivors to Claude, newest first
 *   report   write the triage markdown
 *   queue    the next few postings worth applying to
 *   stats    what the store holds right now
 *   autoapply   tailor, fill and submit the best queued postings, unattended
 *   ready       Greenhouse applications prepared and waiting for you to submit
 *   applied     record an application against a posting
 *   import-csv  load the tracker CSV into the store
 *   export-csv  write the store's applications back out as that CSV
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, APPLICATION_COLUMNS } from '../src/db.ts';
import { detectEol, parseCsvRecords, toCsv } from '../src/csv.ts';
import { fetchAll, probe } from '../src/sources/index.ts';
import { DEFAULT_RULES, screenPosting, type Rules } from '../src/screen.ts';
import { fingerprint, preferred, SOURCE_RANK } from '../src/dedupe.ts';
import { judgePosting, type Profile } from '../src/judge.ts';
import type { Company, Posting } from '../src/types.ts';
import { LANE_ATS, applyPrompt, applyUrl, claude, confirmedSubmission, factCheck, matchTitle, parseApplyResult,
  probeTargets, tailorPrompt } from '../src/autoapply.ts';

// ROOT is the code (and the bundled registry). HOME is your data: beside the
// code in a git checkout, ~/.jobpipe for an npm install, which has nowhere
// else to write.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = (name: string) => process.env[`JOBPIPE_${name}`] ?? process.env[`JOBFEED_${name}`];
const HOME = env('HOME') ?? (existsSync(join(ROOT, '.git')) ? ROOT : join(homedir(), '.jobpipe'));
const DB_PATH = env('DB') ?? join(HOME, 'data', 'jobpipe.db');
const PROFILE_DIR = env('PROFILE') ?? join(HOME, 'profile');
const REGISTRY = env('REGISTRY') ?? [join(HOME, 'companies.json'), join(ROOT, 'companies.json')].find(existsSync)!;
const BULK_REGISTRY = env('BULK_REGISTRY') ?? join(HOME, 'data', 'companies-bulk.json');
const OUT = join(HOME, 'out');

/** Where the files outside the store live, from profile/config.json; a leading ~ is your home directory. */
const config = (() => {
  const path = join(PROFILE_DIR, 'config.json');
  const own = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, string> : {};
  return (key: string, fallback: string) => (own[key] ?? fallback).replace(/^~(?=\/|$)/, homedir());
})();
const TRACKER = env('TRACKER') ?? config('tracker', join(HOME, 'applications.csv'));
const RESUMES = env('RESUMES') ?? config('resumes', join(HOME, 'resume'));
const APPLICATIONS = env('APPLICATIONS') ?? config('applications', join(HOME, 'applications'));
const ANSWERS = env('ANSWERS') ?? config('answers', join(PROFILE_DIR, 'answers.md'));

/**
 * The curated registry, plus the bulk one when `--bulk` is passed. Bulk is
 * the tens of thousands of boards scripts/import-slugs.ts probed alive; too
 * many to poll every run, worth a sweep now and then.
 */
function companies(): Company[] {
  const list = JSON.parse(readFileSync(REGISTRY, 'utf8')) as Company[];
  if (has('bulk') && existsSync(BULK_REGISTRY)) list.push(...JSON.parse(readFileSync(BULK_REGISTRY, 'utf8')) as Company[]);
  const ats = flag('ats')?.split(',');
  const tag = flag('tag');
  // Scraped sites (JobSpy) are slow and rate-limited; they run only when asked for.
  const scrape = has('scrape') || tag === 'scrape';
  return list.filter((c) => (!ats || ats.includes(c.ats)) && (!tag || (c.tags ?? []).includes(tag))
    && (scrape || !(c.tags ?? []).includes('scrape')));
}

/** The screen's rules, with personal numbers (the pay floor) from profile/rules.json. */
let cachedRules: Rules | undefined;
function rules(): Rules {
  if (cachedRules) return cachedRules;
  const path = join(PROFILE_DIR, 'rules.json');
  const own = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Partial<Pick<Rules, 'payFloor'>> : {};
  return (cachedRules = { ...DEFAULT_RULES, ...(typeof own.payFloor === 'number' ? { payFloor: own.payFloor } : {}) });
}

function profile(): Profile {
  const read = (name: string) => {
    const path = join(PROFILE_DIR, name);
    if (!existsSync(path)) {
      console.error(`Missing ${path}. Put your rule-outs in constraints.md and your background in background.md.`);
      process.exit(1);
    }
    return readFileSync(path, 'utf8').trim();
  };
  return { constraints: read('constraints.md'), background: read('background.md') };
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const money = (n: number | null) => (n === null ? '—' : `$${Math.round(n / 1000)}k`);

async function cmdVerify(): Promise<void> {
  const list = companies();
  let dead = 0;
  const queue = [...list];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const r = await probe(c);
      if (!r.ok || r.count === 0) { dead++; console.log(`  DEAD  ${c.ats}:${c.slug}  ${c.name}  (${r.error ?? 'empty'})`); }
    }
  }));
  console.log(`${list.length - dead}/${list.length} boards answering.`);
}

async function cmdPoll(): Promise<void> {
  const store = new Store(DB_PATH);
  const list = companies();
  const startedAt = new Date().toISOString();
  console.log(`Polling ${list.length} boards…`);
  let ok = 0, failed = 0, seen = 0, added = 0;
  const errors: string[] = [];
  const results = await fetchAll(list, {
    concurrency: Number(flag('concurrency', '4')),
    onResult: (r) => {
      if (r.ok) { ok++; } else { failed++; errors.push(`${r.company.ats}:${r.company.slug} ${r.error}`); }
      if (list.length > 200 && (ok + failed) % 200 === 0) console.log(`  ${ok + failed}/${list.length} boards…`);
    },
  });
  for (const r of results) {
    if (!r.ok) continue;
    const n = store.upsertPostings(r.postings);
    seen += n.seen; added += n.added;
  }
  store.db.prepare(`INSERT INTO polls (started_at, finished_at, boards_ok, boards_failed, postings_seen, postings_new, errors)
    VALUES (?,?,?,?,?,?,?)`).run(startedAt, new Date().toISOString(), ok, failed, seen, added, JSON.stringify(errors));
  console.log(`${ok}/${list.length} boards answered. ${seen} postings seen, ${added} new.`);
  for (const e of errors.slice(0, 30)) console.log(`  failed: ${e}`);
  if (errors.length > 30) console.log(`  …and ${errors.length - 30} more (polls table has them all)`);
  store.close();
}

function cmdScreen(): void {
  const store = new Store(DB_PATH);
  const pending = has('all')
    ? store.query('SELECT * FROM postings').map((r) => r as any as Posting)
    : store.unscreened();
  if (!pending.length) { console.log('Nothing to screen.'); store.close(); return; }
  const tally = new Map<string, number>();
  const touched = new Set<string>();
  const flagged = new Map<string, number>();
  let passed = 0;
  for (const raw of pending) {
    const p = has('all') ? rehydrate(raw as any) : raw;
    const s = screenPosting(p, rules());
    touched.add(fingerprint(p.company, p.title));
    store.putScreen(s);
    if (s.verdict === 'pass') passed++;
    for (const r of s.reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
    if (s.verdict === 'pass') for (const f of s.flags) flagged.set(f, (flagged.get(f) ?? 0) + 1);
  }
  // Dedupe last, among copies that passed everything else, so the copy kept
  // is one that can actually be applied to. The judge then reads each job once.
  for (const fp of touched) {
    const copies = store.passingCopies(fp);
    if (copies.length < 2) continue;
    const keep = preferred(copies).id;
    for (const c of copies) if (c.id !== keep) { store.markDuplicate(c.id); passed--; tally.set('duplicate', (tally.get('duplicate') ?? 0) + 1); }
  }
  console.log(`Screened ${pending.length}. ${passed} passed, ${pending.length - passed} ruled out.`);
  for (const [reason, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }
  for (const [f, n] of flagged) console.log(`  passed with a flag for the judge: ${n} ${f}`);
  store.close();
}

/** SQL rows come back snake_case; the screen wants the Posting shape. */
function rehydrate(r: Record<string, any>): Posting {
  return { ...r, externalId: r.external_id, employmentType: r.employment_type,
    postedAt: r.posted_at, salaryMin: r.salary_min, salaryMax: r.salary_max,
    salarySource: r.salary_source, firstSeen: r.first_seen, lastSeen: r.last_seen } as Posting;
}

async function cmdJudge(): Promise<void> {
  const store = new Store(DB_PATH);
  const limit = Number(flag('limit', '20'));
  const queue = store.unjudged(limit, flag('id'));
  if (!queue.length) { console.log('Nothing left to judge.'); store.close(); return; }
  const prof = profile();
  const model = flag('model');
  const concurrency = Number(flag('concurrency', '4'));
  console.log(`Judging ${queue.length} postings, ${concurrency} at a time…`);
  const counts = new Map<string, number>();
  let done = 0;
  const pending = [...queue];
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    for (let p = pending.shift(); p; p = pending.shift()) {
      const source = SOURCE_RANK[p.ats] === 0 ? `employer board (${p.ats})` : `aggregator (${p.ats})`;
      const r = await judgePosting(p, prof, { ...store.context(p), source }, model ? { model } : {});
      done++;
      if ('error' in r) { console.log(`  [${done}/${queue.length}] FAILED ${p.company} — ${p.title}: ${r.error}`); continue; }
      store.putJudgment(r);
      counts.set(r.rating, (counts.get(r.rating) ?? 0) + 1);
      const ghost = r.ghostRisk && r.ghostRisk !== 'low' ? ` ghost:${r.ghostRisk}` : '';
      console.log(`  [${done}/${queue.length}] ${r.rating.padEnd(6)} ${r.score ?? '?'}/5 ${r.remoteTruth}${ghost}  ${p.company} — ${p.title}`);
    }
  }));
  console.log([...counts].map(([k, v]) => `${k} ${v}`).join(', '));
  store.close();
}

/** One posting as a report entry. */
function entry(r: Record<string, any>): string[] {
  const blockers = JSON.parse(r.blockers ?? '[]') as string[];
  const sub = JSON.parse(r.subscores ?? '{}') as Record<string, number>;
  const subLine = Object.keys(sub).length ? ` · ${Object.entries(sub).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ')}` : '';
  const ghost = r.ghost_risk && r.ghost_risk !== 'low' ? ` · ⚠ ghost risk ${r.ghost_risk}` : '';
  const out = [`### ${r.closed ? '~~' : ''}${r.company} — ${r.title}${r.closed ? `~~ (gone from the board since ${String(r.last_seen).slice(0, 10)})` : ''}`,
    `**${r.score ? `${r.score}/5 ` : ''}${r.rating}** · **${money(r.salary_min)}–${money(r.salary_max)}** · ${r.location ?? 'location not stated'} · posted ${String(r.posted_at ?? '').slice(0, 10) || 'unknown'} · ${r.ats}${ghost}`];
  if (r.remote_truth) out.push(`Remote: ${r.remote_truth}${r.remote_evidence ? ` — ${r.remote_evidence}` : ''}`);
  out.push(r.reasoning + (subLine ? `\n<sub>${subLine.slice(3)}</sub>` : ''));
  if (blockers.length) out.push(`Blockers: ${blockers.join('; ')}`);
  out.push(`\`${r.id}\` · <${r.url}>`, '');
  return out;
}

function cmdReport(): void {
  const store = new Store(DB_PATH);
  const rows = store.query(`
    SELECT p.*, j.rating, j.reasoning, j.blockers, j.score, j.subscores, j.remote_truth,
      j.remote_evidence, j.ghost_risk, j.judged_at,
      p.last_seen < (SELECT datetime(MAX(last_seen), '-1 day') FROM postings q WHERE q.ats = p.ats AND q.slug = p.slug) AS closed
    FROM postings p JOIN judgments j ON j.posting_id = p.id
    JOIN screens s ON s.posting_id = p.id AND s.verdict = 'pass'
    WHERE j.rating IN ('STRONG','FAIR','WEAK')
    ORDER BY CASE j.rating WHEN 'STRONG' THEN 0 WHEN 'FAIR' THEN 1 ELSE 2 END,
             COALESCE(j.score, 0) DESC, COALESCE(p.posted_at, p.first_seen) DESC`);
  const since = store.getMeta('last_report');
  const fresh = since ? rows.filter((r) => r.judged_at > since) : [];
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [`# jobpipe — ${today}`, ''];
  const totals = store.query(`SELECT COUNT(*) n FROM postings`)[0]?.n ?? 0;
  const passed = store.query(`SELECT COUNT(*) n FROM screens WHERE verdict='pass'`)[0]?.n ?? 0;
  out.push(`${totals} postings held · ${passed} passed the screen · ${rows.length} rated worth a look.`, '');
  if (since) {
    out.push(`## New since last report (${since.slice(0, 16).replace('T', ' ')})`, '');
    if (!fresh.length) out.push('Nothing new.', '');
    for (const r of fresh.filter((x) => x.rating !== 'WEAK')) out.push(...entry(r));
    const weak = fresh.filter((x) => x.rating === 'WEAK').length;
    if (weak) out.push(`…plus ${weak} new WEAK, listed below.`, '');
  }
  let heading = '';
  for (const r of rows) {
    if (r.rating !== heading) { heading = r.rating; out.push(`## All ${heading}`, ''); }
    out.push(...entry(r));
  }
  const path = flag('out', join(OUT, `${today}.md`))!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out.join('\n'));
  if (!has('out')) store.setMeta('last_report', new Date().toISOString());
  console.log(`${rows.length} rated postings (${fresh.length} new) → ${path}`);
  store.close();
}

/** What to apply to next: the best judged postings not yet applied to. */
function cmdQueue(): void {
  const store = new Store(DB_PATH);
  const rows = store.queue(Number(flag('limit', '5')));
  if (!rows.length) { console.log('Queue is empty. Poll, screen and judge to fill it.'); store.close(); return; }
  for (const [i, r] of rows.entries()) {
    console.log(`${i + 1}. ${r.score ?? '?'}/5 ${r.rating.padEnd(6)} ${r.company} — ${r.title}`);
    console.log(`   ${money(r.salary_min)}–${money(r.salary_max)} · ${r.remote_truth ?? 'remote?'} · ${r.ats} · ${r.id}`);
    console.log(`   ${r.url}`);
  }
  store.close();
}

function cmdStats(): void {
  const store = new Store(DB_PATH);
  const one = (sql: string) => store.query(sql)[0]?.n ?? 0;
  console.log(`postings   ${one('SELECT COUNT(*) n FROM postings')}`);
  console.log(`companies  ${one('SELECT COUNT(DISTINCT company) n FROM postings')}`);
  console.log(`screened   ${one('SELECT COUNT(*) n FROM screens')} (${one("SELECT COUNT(*) n FROM screens WHERE verdict='pass'")} passed)`);
  console.log(`judged     ${one('SELECT COUNT(*) n FROM judgments')}`);
  for (const r of store.query(`SELECT rating, COUNT(*) n FROM judgments GROUP BY rating ORDER BY n DESC`)) {
    console.log(`  ${r.rating.padEnd(7)} ${r.n}`);
  }
  console.log(`\nlast polls:`);
  for (const r of store.query(`SELECT * FROM polls ORDER BY id DESC LIMIT 3`)) {
    console.log(`  ${r.started_at.slice(0, 16)}  ${r.boards_ok} ok / ${r.boards_failed} failed  ${r.postings_new} new`);
  }
  store.close();
}

const blank = (v: string | undefined) => (v === undefined || v === '' ? null : v);
const daysFrom = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/** `jobpipe applied <posting-id> [--status applied] [--resume PATH] [--confirm URL] [--notes TEXT]` */
function cmdApplied(): void {
  const id = process.argv[3];
  if (!id || id.startsWith('--')) { console.error('Usage: jobpipe applied <posting-id> [--resume PATH] [--confirm URL] [--notes TEXT]'); process.exit(1); }
  const store = new Store(DB_PATH);
  const p = store.query('SELECT * FROM postings WHERE id = ?', id)[0];
  if (!p) { console.error(`No posting ${id}.`); process.exit(1); }
  const today = new Date().toISOString().slice(0, 10);
  const confirm = flag('confirm');
  const notes = [flag('notes'), confirm && `Confirmation: ${confirm}`].filter(Boolean).join(' ') || null;
  const range = p.salary_min || p.salary_max ? `${money(p.salary_min)}-${money(p.salary_max)}` : null;
  store.putApplication({
    postingId: id, company: p.company, role: p.title, track: flag('track') ?? null,
    postedRange: range, source: `jobpipe (${p.ats})`, url: p.url, appliedDate: today,
    status: flag('status', 'applied')!, followUpDate: daysFrom(today, 7),
    resumePath: flag('resume') ?? null, notes,
  });
  console.log(`Recorded: ${p.company} — ${p.title} (${flag('status', 'applied')}), follow up ${daysFrom(today, 7)}.`);
  store.close();
}

function cmdImportCsv(): void {
  const path = flag('from', TRACKER)!;
  const store = new Store(DB_PATH);
  const records = parseCsvRecords(readFileSync(path, 'utf8'));
  for (const r of records) {
    // Match the row back to a polled posting when the URL is one we hold.
    const posting = r.url ? store.query('SELECT id FROM postings WHERE url = ?', r.url)[0] : undefined;
    store.putApplication({
      postingId: posting?.id ?? null, company: r.company, role: r.role, track: blank(r.track),
      postedRange: blank(r.posted_range), source: blank(r.source), url: blank(r.url),
      appliedDate: blank(r.applied_date), status: r.status || 'unknown',
      followUpDate: blank(r.follow_up_date), resumePath: null, notes: blank(r.notes),
    });
  }
  console.log(`Imported ${records.length} applications from ${path}.`);
  store.close();
}

function cmdExportCsv(): void {
  const path = flag('out', TRACKER)!;
  const store = new Store(DB_PATH);
  const rows = store.applications();
  const existing = existsSync(path) ? path : existsSync(TRACKER) ? TRACKER : null;
  const eol = existing ? detectEol(readFileSync(existing, 'utf8')) : '\r\n';
  writeFileSync(path, toCsv([...APPLICATION_COLUMNS], rows, eol));
  console.log(`${rows.length} applications → ${path}`);
  store.close();
}

const kebab = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Engineering-flavored titles get the frontend master; everything else the marketing one. */
function trackFor(title: string): 'frontend' | 'marketing' {
  return /\b(engineer|developer|technologist|architect|programmer|devrel|advocate)\b/i.test(title) ? 'frontend' : 'marketing';
}

function applicationDir(p: Record<string, any>): string {
  return join(APPLICATIONS, `${kebab(p.company)}-${kebab(p.title)}`.slice(0, 80).replace(/-$/, ''));
}

function postingRow(store: Store, id: string | undefined): Record<string, any> {
  if (!id || id.startsWith('--')) { console.error(`Usage: jobpipe ${process.argv[2]} <posting-id>`); process.exit(1); }
  const p = store.query(`SELECT p.*, j.rating, j.score, j.reasoning, j.blockers, j.remote_truth, j.remote_evidence
    FROM postings p LEFT JOIN judgments j ON j.posting_id = p.id WHERE p.id = ?`, id)[0];
  if (!p) { console.error(`No posting ${id}.`); process.exit(1); }
  return p;
}

/**
 * `jobpipe tailor <posting-id> [--track frontend|marketing]`
 *
 * Sets up the application folder: the posting in full (what the resume is
 * tailored against) and a copy of the right master to edit. It never
 * overwrites a resume.md already there — that is someone's tailoring work.
 */
function cmdTailor(): void {
  const store = new Store(DB_PATH);
  const p = postingRow(store, process.argv[3]);
  const track = (flag('track') ?? trackFor(p.title)) as 'frontend' | 'marketing';
  const dir = applicationDir(p);
  mkdirSync(dir, { recursive: true });
  const blockers = JSON.parse(p.blockers ?? '[]') as string[];
  writeFileSync(join(dir, 'posting.md'), [
    `# ${p.company} — ${p.title}`, '',
    `- Posting id: \`${p.id}\``, `- URL: ${p.url}`, `- Location: ${p.location ?? 'not stated'}`,
    `- Pay: ${money(p.salary_min)}–${money(p.salary_max)}`, `- Track: ${track} (master-${track}.md)`,
    p.rating ? `- Judged: ${p.score ?? '?'}/5 ${p.rating} — remote ${p.remote_truth ?? '?'}` : '- Not judged yet',
    '', p.reasoning ? `## Judge's read\n\n${p.reasoning}\n${blockers.length ? `\nGaps to address or own: ${blockers.join('; ')}\n` : ''}${p.remote_evidence ? `\nRemote evidence: ${p.remote_evidence}\n` : ''}` : '',
    '## Description', '', p.description, '',
  ].join('\n'));
  const resume = join(dir, 'resume.md');
  const master = join(RESUMES, `master-${track}.md`);
  if (existsSync(resume)) console.log(`Kept existing ${resume}.`);
  else { copyFileSync(master, resume); console.log(`Copied master-${track}.md → ${resume}`); }
  writeFileSync(join(dir, '.jobpipe.json'), JSON.stringify({ postingId: p.id, track, master }, null, 2));
  console.log(`Posting written to ${join(dir, 'posting.md')}.`);
  console.log(`Next: edit resume.md against posting.md — wording and emphasis only, never new facts — then \`jobpipe build ${p.id}\`.`);
  store.close();
}

/**
 * `jobpipe build <posting-id>` — renders resume.md and checks the result is
 * fit to send: one page, and actually tailored (it differs from the master).
 * An early application went out with the master PDF; this is the check
 * that would have caught it.
 */
function cmdBuild(): void {
  const store = new Store(DB_PATH);
  const p = postingRow(store, process.argv[3]);
  const dir = applicationDir(p);
  if (!existsSync(join(dir, 'resume.md'))) { console.error(`No ${join(dir, 'resume.md')}. Run \`jobpipe tailor ${p.id}\` first.`); process.exit(1); }
  const r = buildResume(p, 'inherit');
  console.log(`${r.pdf}: ${r.pages} page${r.pages === 1 ? '' : 's'}, ${r.changed} lines changed from ${r.master.split('/').pop()}.`);
  if (r.problems.length) { console.error(`NOT READY: ${r.problems.join('; ')}.`); process.exitCode = 1; }
  else console.log(`Ready to attach: ${r.pdf}`);
  store.close();
}

/** Renders an application folder's resume.md and says whether it is fit to send. */
function buildResume(p: Record<string, any>, stdio: 'inherit' | 'pipe' = 'pipe') {
  const dir = applicationDir(p);
  const resume = join(dir, 'resume.md');
  const meta = existsSync(join(dir, '.jobpipe.json')) ? JSON.parse(readFileSync(join(dir, '.jobpipe.json'), 'utf8')) : {};
  const master: string = meta.master ?? join(RESUMES, `master-${trackFor(p.title)}.md`);
  execFileSync('python3', [join(RESUMES, 'build.py'), resume], { stdio });
  const pdf = join(dir, 'resume.pdf');
  const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }))?.[1]);
  const same = readFileSync(resume, 'utf8') === readFileSync(master, 'utf8');
  let changed = 0;
  try { execFileSync('diff', ['-u', master, resume]); } catch (e: any) {
    changed = String(e.stdout ?? '').split('\n')
      .filter((l: string) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;
  }
  const problems = [pages !== 1 && `it is ${pages} pages, not one`, same && 'it is identical to the master — not tailored']
    .filter(Boolean) as string[];
  return { pdf, pages, changed, master, problems };
}

/**
 * `jobpipe autoapply [--limit 10] [--dry-run] [--id POSTING]`
 *
 * Applies, unattended, to the best queued postings that fit the lane in
 * src/autoapply.ts: tailor → fact check → build → fill and submit through a
 * headless browser → record. At most `--limit` submissions a day, counted
 * across runs. Everything it did lands in out/auto-YYYY-MM-DD.md.
 */
async function cmdAutoapply(): Promise<void> {
  const store = new Store(DB_PATH);
  const today = new Date().toISOString().slice(0, 10);
  const dryRun = has('dry-run');
  const cap = Number(flag('limit', '10'));
  const sentToday = store.query(`SELECT COUNT(*) n FROM auto_attempts WHERE outcome = 'submitted' AND attempted_at >= ?`, today)[0].n as number;
  let room = cap - sentToday;
  if (room <= 0) { console.log(`Daily cap reached: ${sentToday}/${cap} sent today.`); store.close(); return; }

  // Both copies count: once the employer's copy is stored, a later screen keeps
  // it and the feed copy goes, and the same job must not be attempted twice.
  const tried = new Set(store.query('SELECT posting_id, employer_posting_id FROM auto_attempts')
    .flatMap((r) => [r.posting_id, r.employer_posting_id]).filter(Boolean));
  const only = flag('id');
  const candidates = store.queue(200).filter((r) => (only ? r.id === only
    : r.score >= 4 && r.ghost_risk === 'low' && r.remote_truth === 'us-remote' && !tried.has(r.id)));
  if (!candidates.length) { console.log('Nothing in the queue fits the automatic lane.'); store.close(); return; }

  const digest = join(OUT, `auto-${today}${dryRun ? '-dry-run' : ''}.md`);
  mkdirSync(dirname(digest), { recursive: true });
  if (!existsSync(digest)) writeFileSync(digest, `# Automatic applications — ${today}\n\n`);
  const log = (lines: string[]) => writeFileSync(digest, readFileSync(digest, 'utf8') + lines.join('\n') + '\n\n');
  const record = (id: string, outcome: string, detail: string, employerId: string | null, folder: string | null) => {
    // A dry run leaves no trace in the store, so it never blocks the real attempt.
    if (dryRun) { console.log(`  → (dry run) ${outcome}: ${detail}`); return; }
    store.db.prepare(`INSERT INTO auto_attempts (posting_id, attempted_at, outcome, detail, employer_posting_id, folder)
      VALUES (?,?,?,?,?,?) ON CONFLICT(posting_id) DO UPDATE SET attempted_at=excluded.attempted_at,
      outcome=excluded.outcome, detail=excluded.detail, employer_posting_id=excluded.employer_posting_id, folder=excluded.folder`)
      .run(id, new Date().toISOString(), outcome, detail, employerId, folder);
    console.log(`  → ${outcome}: ${detail}`);
  };

  const corpus = ['master-frontend.md', 'master-marketing.md', 'source.md']
    .map((f) => join(RESUMES, f)).filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
  const answerBank = readFileSync(ANSWERS, 'utf8');
  console.log(`${candidates.length} queued postings fit the lane; room for ${room} today${dryRun ? ' (dry run)' : ''}.`);

  for (const c of candidates) {
    if (room <= 0) break;
    console.log(`\n${c.score}/5 ${c.company} — ${c.title}  (${c.id})`);

    // 1. The employer's own copy: the feed's or the employer's board.
    let emp: Posting | null = LANE_ATS.includes(c.ats) ? rehydrate(c) : null;
    if (!emp) {
      const found = await fetchAll(probeTargets(c.company), { concurrency: 3, timeoutMs: 20_000 });
      emp = matchTitle(c.title, found.flatMap((r) => (r.ok ? r.postings : [])));
      if (emp) store.upsertPostings([emp]);
    }
    if (!emp) { record(c.id, 'not-in-lane', `no copy on the employer's own Greenhouse, Lever or Ashby board`, null, null); continue; }
    const screen = screenPosting(emp, rules());
    if (screen.verdict !== 'pass') { record(c.id, 'not-in-lane', `the employer's copy fails the screen: ${screen.reasons.join(', ')}`, emp.id, null); continue; }
    const url = applyUrl(emp)!;
    const already = store.query('SELECT 1 FROM applications WHERE posting_id = ? OR (company = ? AND role = ?)', emp.id, c.company, c.title);
    if (already.length) { record(c.id, 'not-in-lane', 'already applied', emp.id, null); continue; }

    // 2. Tailor, against the employer's full description.
    const p = { ...c, description: emp.description || c.description, url };
    const dir = applicationDir(p);
    mkdirSync(join(dir, 'browser'), { recursive: true });
    const track = trackFor(p.title);
    const master = join(RESUMES, `master-${track}.md`);
    const blockers = JSON.parse(p.blockers ?? '[]') as string[];
    const postingMd = [`# ${p.company} — ${p.title}`, '', `- Posting id: \`${c.id}\` (employer copy \`${emp.id}\`)`, `- Apply: ${url}`,
      `- Location: ${emp.location ?? 'not stated'}`, `- Pay: ${money(p.salary_min)}–${money(p.salary_max)}`, `- Track: ${track}`,
      '', `## Judge's read\n\n${p.reasoning}${blockers.length ? `\n\nGaps: ${blockers.join('; ')}` : ''}`, '', '## Description', '', p.description].join('\n');
    writeFileSync(join(dir, 'posting.md'), postingMd);
    // A resume.md left by an earlier automatic or dry run was tailored from whatever the master was
    // then; start again from today's. One a person tailored by hand (no auto flag) is kept.
    const metaPath = join(dir, '.jobpipe.json');
    const leftByMachine = existsSync(metaPath) && JSON.parse(readFileSync(metaPath, 'utf8')).auto === true;
    if (!existsSync(join(dir, 'resume.md')) || leftByMachine) copyFileSync(master, join(dir, 'resume.md'));
    writeFileSync(metaPath, JSON.stringify({ postingId: c.id, employerPostingId: emp.id, track, master, auto: true }, null, 2));
    const masterText = readFileSync(master, 'utf8');
    try {
      if (readFileSync(join(dir, 'resume.md'), 'utf8') === masterText) {
        await claude(['-p', tailorPrompt(postingMd, masterText), '--allowedTools', 'Read', 'Edit', '--disallowedTools', 'Bash', 'Write'], dir, 600_000);
      }
    } catch (e: any) { record(c.id, 'tailor-failed', String(e.message ?? e).slice(0, 200), emp.id, dir); continue; }
    const problems = factCheck(readFileSync(join(dir, 'resume.md'), 'utf8'), masterText, corpus);
    let built: ReturnType<typeof buildResume> | null = null;
    try { built = buildResume(p); problems.push(...built.problems); } catch (e: any) { problems.push(`build failed: ${String(e.message ?? e).slice(0, 120)}`); }
    if (problems.length) { record(c.id, 'tailor-failed', problems.join('; '), emp.id, dir); log([`## ✗ ${c.company} — ${c.title}`, `Resume rejected: ${problems.join('; ')}. Left in ${dir} for you.`]); continue; }

    // Greenhouse emails a security code after Submit, which only a person can enter. Stop here
    // with everything ready; `jobpipe ready` lists these for a session with Tory at the keyboard.
    if (emp.ats === 'greenhouse' && !dryRun) {
      record(c.id, 'needs-you', `resume ready: ${built!.pdf}`, emp.id, dir);
      log([`## → ${c.company} — ${c.title}`, `Ready for you (Greenhouse asks for an emailed code). ${url}`, `Resume: ${built!.pdf}`]);
      continue;
    }

    // 3. Fill and submit, in a headless browser of its own.
    const mcp = join(dir, 'browser', 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'chrome',
      '--headless', '--isolated', '--output-dir', join(dir, 'browser'), '--viewport-size', '1280,2000'] } } }));
    let out = '';
    try {
      out = await claude(['-p', applyPrompt({ company: p.company, title: p.title, url, pdf: built!.pdf, profile: answerBank,
        posting: postingMd, shotsDir: join(dir, 'browser'), dryRun }),
        '--mcp-config', mcp, '--strict-mcp-config', '--allowedTools', 'mcp__pw', '--disallowedTools', 'Bash', 'Write', 'Edit'],
        homedir(), 1_200_000);
    } catch (e: any) {
      // It may have got as far as submitting. Never retried automatically.
      record(c.id, 'unknown', `the browser run died (${String(e.message ?? e).slice(0, 120)}); check ${url} and your email`, emp.id, dir);
      log([`## ? ${c.company} — ${c.title}`, `Run died partway; it may or may not have submitted. Check your email for a confirmation. ${url}`]);
      continue;
    }
    writeFileSync(join(dir, 'browser', 'result.txt'), out);
    const r = parseApplyResult(out);
    if (!r) { record(c.id, 'unknown', 'unreadable reply; see browser/result.txt', emp.id, dir); continue; }
    const answers = r.answers.map((a) => `- ${a.field}: ${a.value}${a.source === 'drafted' ? ' *(drafted)*' : ''}`);
    const blanks = r.blank.map((b) => `- ${b.field} — left blank: ${b.why}`);
    writeFileSync(join(dir, 'application.md'), [`# ${p.company} — ${p.title}`, '', `Status: ${r.status} — ${r.reason}`, `Page: ${r.finalUrl}`,
      `Resume: ${built!.pdf}`, r.confirmation && `Confirmation: ${r.confirmation}`, '', '## Answers', ...answers, '', '## Left blank', ...blanks].filter((l) => l !== '').join('\n') + '\n');

    if (confirmedSubmission(r) && !dryRun) {
      room--;
      record(c.id, 'submitted', r.confirmation.slice(0, 200), emp.id, dir);
      const range = p.salary_min || p.salary_max ? `${money(p.salary_min)}-${money(p.salary_max)}` : null;
      store.putApplication({ postingId: emp.id, company: p.company, role: p.title, track, postedRange: range, source: `jobpipe auto (${emp.ats})`,
        url, appliedDate: today, status: 'applied', followUpDate: daysFrom(today, 7), resumePath: built!.pdf,
        notes: `Auto-applied. Confirmation: ${r.confirmation.slice(0, 160)}` });
      log([`## ✓ ${c.company} — ${c.title}`, `${money(p.salary_min)}–${money(p.salary_max)} · ${url}`, `Confirmation: ${r.confirmation}`,
        `Resume: ${built!.pdf}`, ...answers, ...blanks]);
    } else {
      const outcome = r.status === 'submitted' ? 'unknown' : r.status;
      record(c.id, outcome, r.reason || 'no confirmation seen', emp.id, dir);
      log([`## ${outcome === 'unknown' ? '?' : '–'} ${c.company} — ${c.title}`, `${outcome}: ${r.reason} · ${url}`]);
    }
  }
  console.log(`\nDigest: ${digest}`);
  store.close();
}

/** Applications the automatic run prepared but left for a person to submit, oldest first. */
function cmdReady(): void {
  const store = new Store(DB_PATH);
  const rows = store.query(`SELECT a.posting_id, a.employer_posting_id, a.attempted_at, a.detail, a.folder, p.company, p.title, e.ats, e.slug, e.external_id, e.url
    FROM auto_attempts a JOIN postings p ON p.id = a.posting_id LEFT JOIN postings e ON e.id = a.employer_posting_id
    WHERE a.outcome = 'needs-you' AND NOT EXISTS (SELECT 1 FROM applications x WHERE x.posting_id IN (a.posting_id, a.employer_posting_id)
      OR (x.company = p.company AND x.role = p.title)) ORDER BY a.attempted_at`);
  if (!rows.length) console.log('Nothing waiting for you.');
  for (const r of rows) {
    const url = r.ats ? applyUrl({ ats: r.ats, slug: r.slug, externalId: r.external_id, url: r.url }) : null;
    console.log(`${r.company} — ${r.title}\n  ${url ?? '(no apply url)'}\n  ${r.detail}\n  record: ./bin/jobpipe.ts applied ${r.employer_posting_id ?? r.posting_id} --resume <pdf> --confirm <text>\n`);
  }
  store.close();
}

/** Starter profile files for a new user; never overwrites one that exists. */
function cmdInit() {
  const starters: Record<string, string> = {
    'constraints.md': '# Hard rule-outs\n\nWhat you will never take, one per line: on-site, a state you cannot work in, a level, a pay floor in words.\n',
    'background.md': '# Background\n\nWho you are, what you have shipped, what you are after, and your honest gaps.\nThe gaps matter: without them the judge calls everything a maybe.\n',
    'rules.json': JSON.stringify({ payFloor: 0 }, null, 2) + '\n',
    'answers.md': '# Answer bank\n\nFor autoapply: name, email, phone, location, links (say "skip" for any to leave blank),\nwork authorization, desired salary, notice period, and anything forms usually ask.\n',
    'config.json': JSON.stringify({ tracker: join(HOME, 'applications.csv'), resumes: join(HOME, 'resume'),
      applications: join(HOME, 'applications'), answers: join(PROFILE_DIR, 'answers.md') }, null, 2) + '\n',
  };
  mkdirSync(PROFILE_DIR, { recursive: true });
  for (const [name, body] of Object.entries(starters)) {
    const path = join(PROFILE_DIR, name);
    if (existsSync(path)) { console.log(`kept    ${path}`); continue; }
    writeFileSync(path, body);
    console.log(`created ${path}`);
  }
  console.log(`\nEdit those, then: jobpipe poll && jobpipe screen && jobpipe judge --limit 20 && jobpipe report
Judging, tailoring and autoapply call the \`claude\` CLI (Claude Code). tailor/build expect
master-frontend.md, master-marketing.md and a build.py (markdown → one-page PDF) in ${RESUMES}.`);
}

const COMMANDS: Record<string, () => void | Promise<void>> = {
  init: cmdInit, verify: cmdVerify, poll: cmdPoll, screen: cmdScreen,
  judge: cmdJudge, report: cmdReport, stats: cmdStats,
  queue: cmdQueue, tailor: cmdTailor, build: cmdBuild, autoapply: cmdAutoapply, ready: cmdReady, applied: cmdApplied, 'import-csv': cmdImportCsv, 'export-csv': cmdExportCsv,
};

const command = process.argv[2];
if (!command || !COMMANDS[command]) {
  console.log(`jobpipe — find, judge and track job postings

  jobpipe init                                     create starter profile files
  jobpipe poll    [--bulk] [--scrape] [--ats workday] [--tag saas] [--concurrency 4]
                                                   fetch every board, store what is new
  jobpipe screen  [--all]                          apply the deterministic rule-outs
  jobpipe judge   [--limit 20] [--model NAME] [--id P]  send survivors to Claude
  jobpipe report  [--out PATH]                     write the triage markdown
  jobpipe queue   [--limit 5]                      best judged postings not yet applied to
  jobpipe stats                                    what the store holds
  jobpipe verify  [--bulk] [--ats A]               check every board still answers
  jobpipe tailor  <posting-id> [--track frontend|marketing]   set up the application folder
  jobpipe build   <posting-id>                     render the resume, check one page + tailored
  jobpipe autoapply [--limit 10] [--dry-run] [--id P]  tailor, fill and submit within the lane, unattended
  jobpipe ready                                     prepared Greenhouse applications waiting for you (it emails a code)
  jobpipe applied <posting-id> [--resume PATH] [--confirm URL] [--notes TEXT] [--status S]
  jobpipe import-csv [--from PATH]                 load the tracker CSV into the store
  jobpipe export-csv [--out PATH]                  write applications back out as CSV

Data lives beside a git checkout, or in ~/.jobpipe for an npm install.
Env: JOBPIPE_HOME, JOBPIPE_DB, JOBPIPE_PROFILE, JOBPIPE_REGISTRY, JOBPIPE_TRACKER,
     JOBPIPE_RESUMES, JOBPIPE_APPLICATIONS, JOBPIPE_ANSWERS (JOBFEED_* still read)`);
  process.exit(command ? 1 : 0);
}
await COMMANDS[command]();
