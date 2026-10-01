#!/usr/bin/env node
/**
 * jobfeed — poll company job boards, screen them against your own rules,
 * judge what survives, and print what is worth your afternoon.
 *
 * Six commands, each doing one thing:
 *   verify   check every board in the registry still answers
 *   poll     fetch every board and store what is new
 *   screen   apply the deterministic rule-outs to everything unscreened
 *   judge    send survivors to Claude, newest first
 *   report   write the triage markdown
 *   stats    what the store holds right now
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/db.ts';
import { fetchAll, probe } from '../src/sources/index.ts';
import { screenPosting } from '../src/screen.ts';
import { judgePosting, type Profile } from '../src/judge.ts';
import type { Company, Posting } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.JOBFEED_DB ?? join(ROOT, 'data', 'jobfeed.db');
const PROFILE_DIR = process.env.JOBFEED_PROFILE ?? join(ROOT, 'profile');
const REGISTRY = process.env.JOBFEED_REGISTRY ?? join(ROOT, 'companies.json');

function companies(): Company[] {
  return JSON.parse(readFileSync(REGISTRY, 'utf8')) as Company[];
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
  const list = companies().filter((c) => {
    const tag = flag('tag');
    return !tag || (c.tags ?? []).includes(tag);
  });
  const startedAt = new Date().toISOString();
  console.log(`Polling ${list.length} boards…`);
  let ok = 0, failed = 0, seen = 0, added = 0;
  const errors: string[] = [];
  const results = await fetchAll(list, {
    concurrency: Number(flag('concurrency', '4')),
    onResult: (r) => {
      if (r.ok) { ok++; } else { failed++; errors.push(`${r.company.ats}:${r.company.slug} ${r.error}`); }
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
  for (const e of errors) console.log(`  failed: ${e}`);
  store.close();
}

function cmdScreen(): void {
  const store = new Store(DB_PATH);
  const pending = has('all')
    ? store.query('SELECT * FROM postings').map((r) => r as any as Posting)
    : store.unscreened();
  if (!pending.length) { console.log('Nothing to screen.'); store.close(); return; }
  const tally = new Map<string, number>();
  let passed = 0;
  for (const raw of pending) {
    const p = has('all') ? rehydrate(raw as any) : raw;
    const s = screenPosting(p);
    store.putScreen(s);
    if (s.verdict === 'pass') passed++;
    for (const r of s.reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
  }
  console.log(`Screened ${pending.length}. ${passed} passed, ${pending.length - passed} ruled out.`);
  for (const [reason, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${reason}`);
  }
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
  const queue = store.unjudged(limit);
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
      const r = await judgePosting(p, prof, model ? { model } : {});
      done++;
      if ('error' in r) { console.log(`  [${done}/${queue.length}] FAILED ${p.company} — ${p.title}: ${r.error}`); continue; }
      store.putJudgment(r);
      counts.set(r.rating, (counts.get(r.rating) ?? 0) + 1);
      console.log(`  [${done}/${queue.length}] ${r.rating.padEnd(6)} ${p.company} — ${p.title}`);
    }
  }));
  console.log([...counts].map(([k, v]) => `${k} ${v}`).join(', '));
  store.close();
}

function cmdReport(): void {
  const store = new Store(DB_PATH);
  const rows = store.query(`
    SELECT p.*, j.rating, j.reasoning, j.blockers
    FROM postings p JOIN judgments j ON j.posting_id = p.id
    WHERE j.rating IN ('STRONG','FAIR','WEAK')
    ORDER BY CASE j.rating WHEN 'STRONG' THEN 0 WHEN 'FAIR' THEN 1 ELSE 2 END,
             COALESCE(p.posted_at, p.first_seen) DESC`);
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [`# jobfeed — ${today}`, ''];
  const totals = store.query(`SELECT COUNT(*) n FROM postings`)[0]?.n ?? 0;
  const passed = store.query(`SELECT COUNT(*) n FROM screens WHERE verdict='pass'`)[0]?.n ?? 0;
  out.push(`${totals} postings held · ${passed} passed the screen · ${rows.length} rated worth a look.`, '');
  let heading = '';
  for (const r of rows) {
    if (r.rating !== heading) { heading = r.rating; out.push(`## ${heading}`, ''); }
    const blockers = JSON.parse(r.blockers ?? '[]') as string[];
    out.push(`### ${r.company} — ${r.title}`);
    out.push(`**${money(r.salary_min)}–${money(r.salary_max)}** · ${r.location ?? 'location not stated'} · posted ${String(r.posted_at ?? '').slice(0, 10) || 'unknown'}`);
    out.push(r.reasoning);
    if (blockers.length) out.push(`Blockers: ${blockers.join('; ')}`);
    out.push(`<${r.url}>`, '');
  }
  const path = flag('out', join(ROOT, 'out', `${today}.md`))!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out.join('\n'));
  console.log(`${rows.length} rated postings → ${path}`);
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

const COMMANDS: Record<string, () => void | Promise<void>> = {
  verify: cmdVerify, poll: cmdPoll, screen: cmdScreen,
  judge: cmdJudge, report: cmdReport, stats: cmdStats,
};

const command = process.argv[2];
if (!command || !COMMANDS[command]) {
  console.log(`jobfeed — a personal job-posting collector

  jobfeed poll    [--tag saas] [--concurrency 4]   fetch every board, store what is new
  jobfeed screen  [--all]                          apply the deterministic rule-outs
  jobfeed judge   [--limit 20] [--model NAME]      send survivors to Claude
  jobfeed report  [--out PATH]                     write the triage markdown
  jobfeed stats                                    what the store holds
  jobfeed verify                                   check every board still answers

Env: JOBFEED_DB, JOBFEED_PROFILE, JOBFEED_REGISTRY`);
  process.exit(command ? 1 : 0);
}
await COMMANDS[command]();
