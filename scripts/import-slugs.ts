#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Grows the bulk registry from job-board-aggregator's published slug lists.
 *
 *   node scripts/import-slugs.ts [--ats greenhouse,lever,ashby,workday] [--limit N] [--concurrency 8]
 *
 * Every slug is probed before it goes in — a slug nobody answers for, or a
 * board with nothing on it, is recorded as dead so the next run skips it
 * rather than asking again. Slugs already in the curated companies.json are
 * left out; that file stays the hand-picked list polled every run.
 *
 * The lists are Feashliaa/job-board-aggregator's (MIT code, CC BY-NC data),
 * fine for one person's job search and not for redistributing, which is why
 * the output lives in data/ and out of git.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe } from '../src/sources/index.ts';
import { getJson } from '../src/sources/http.ts';
import type { Ats, Company } from '../src/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURATED = join(ROOT, 'companies.json');
const BULK = process.env.JOBPIPE_BULK_REGISTRY ?? join(ROOT, 'data', 'companies-bulk.json');
const DEAD = join(ROOT, 'data', 'dead-slugs.json');
const SOURCE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/HEAD/data';

const flag = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const read = <T>(path: string, fallback: T): T =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback;

/** "acme-labs" → "Acme Labs". The feed's own name would be better; this is what we have. */
function nameFrom(ats: Ats, slug: string): string {
  const raw = ats === 'workday' ? slug.split('|')[0] : slug;
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

const atsList = (flag('ats', 'greenhouse,lever,ashby,workday')!).split(',') as Ats[];
const limit = Number(flag('limit', 'Infinity'));
const concurrency = Number(flag('concurrency', '8'));

const key = (c: { ats: string; slug: string }) => `${c.ats}:${c.slug.toLowerCase()}`;
const curated = new Set(read<Company[]>(CURATED, []).map(key));
const bulk = read<Company[]>(BULK, []);
const known = new Set(bulk.map(key));
const dead = new Set(read<string[]>(DEAD, []));

const todo: Company[] = [];
for (const ats of atsList) {
  const slugs = await getJson(`${SOURCE}/${ats}_companies.json`) as string[];
  const fresh = slugs
    .map((slug) => ({ name: nameFrom(ats, slug), ats, slug, tags: ['bulk'] }) as Company)
    .filter((c) => !curated.has(key(c)) && !known.has(key(c)) && !dead.has(key(c)));
  console.log(`${ats}: ${slugs.length} listed, ${fresh.length} not yet probed`);
  todo.push(...fresh);
}
const batch = todo.slice(0, limit);
console.log(`Probing ${batch.length}, ${concurrency} at a time…`);

let done = 0, live = 0;
const save = () => {
  mkdirSync(dirname(BULK), { recursive: true });
  writeFileSync(BULK, JSON.stringify(bulk, null, 1));
  writeFileSync(DEAD, JSON.stringify([...dead]));
};
const queue = [...batch];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const r = await probe(c, 15_000);
    // A timeout is not proof of death; leave it for the next run to try.
    if (r.ok && r.count > 0) { bulk.push(c); live++; }
    else if (r.ok || /http 4\d\d/.test(r.error ?? '')) dead.add(key(c));
    if (++done % 250 === 0) { save(); console.log(`  ${done}/${batch.length} probed, ${live} live`); }
  }
}));
save();
console.log(`Done. ${live} live boards added; bulk registry now ${bulk.length}. Dead slugs remembered: ${dead.size}.`);
