/**
 * Indeed, Google Jobs and (read-only, sparingly) LinkedIn, through JobSpy.
 *
 * JobSpy is a Python scraper, so this adapter shells out to
 * scripts/jobspy_pull.py under `uv run`, which installs its one dependency on
 * first use. Registry entry:
 *
 *   { "name": "Indeed", "ats": "jobspy", "slug": "indeed", "tags": ["scrape"],
 *     "search": ["marketing automation", "marketing operations"] }
 *
 * The slug is the comma-separated JobSpy site list. Entries tagged "scrape"
 * are left out of a plain `poll` and run only with `--scrape`: these sites do
 * not offer an API, rate-limit scraping, and Indeed's search matching is loose
 * enough that most of what comes back is noise for the screen to clear.
 *
 * Where Indeed links straight to the employer's own posting (a Workday or
 * Lever URL, often), that URL is kept as the posting's URL — it is where the
 * application actually happens, and it lets dedupe match the same job polled
 * from the employer's board.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Company, Posting } from '../types.ts';
import { isoOrNull, parseSalary } from '../normalize.ts';
import { employerSlug } from './remote-boards.ts';
import type { FetchContext } from './http.ts';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'jobspy_pull.py');
const UV = existsSync(join(homedir(), '.local', 'bin', 'uv')) ? join(homedir(), '.local', 'bin', 'uv') : 'uv';

export const DEFAULT_SEARCH = ['marketing automation', 'marketing operations', 'marketing technologist'];

const PER_YEAR: Record<string, number> = { yearly: 1, monthly: 12, weekly: 52, daily: 260, hourly: 2080 };

function pay(r: Record<string, any>): { min: number; max: number } | null {
  const mult = PER_YEAR[String(r.interval ?? '')];
  const lo = Number(r.min_amount), hi = Number(r.max_amount ?? r.min_amount);
  if (!mult || (r.currency && r.currency !== 'USD') || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const min = Math.round(lo * mult), max = Math.round(hi * mult);
  return min >= 15_000 && max <= 1_000_000 && max >= min ? { min, max } : null;
}

export function parseJobspy(rows: unknown, now: string): Posting[] {
  if (!Array.isArray(rows)) return [];
  const out = new Map<string, Posting>();
  for (const r of rows as Record<string, any>[]) {
    if (!r?.id || !r?.title || !r?.job_url) continue;
    const company = String(r.company ?? '').trim() || 'Unknown';
    const description = String(r.description ?? '');
    const structured = pay(r);
    const parsed = structured ? null : parseSalary(description);
    const slug = employerSlug(company);
    const externalId = `${r.site}-${r.id}`;
    const p: Posting = {
      id: `jobspy:${slug}:${externalId}`, ats: 'jobspy', slug, company, externalId,
      title: String(r.title).trim(),
      // The site's remote flag is its own guess; say whose it is so the judge
      // weighs it as a claim, not a fact.
      description: [r.is_remote === true ? `Remote: yes (per ${r.site})` : '', description].filter(Boolean).join('\n'),
      location: r.location ? String(r.location) : null, department: null,
      employmentType: r.job_type ? String(r.job_type) : null,
      postedAt: isoOrNull(r.date_posted),
      url: String(r.job_url_direct || r.job_url),
      salaryMin: structured?.min ?? parsed?.min ?? null,
      salaryMax: structured?.max ?? parsed?.max ?? null,
      salarySource: structured ? 'structured' : parsed ? 'description' : null,
      firstSeen: now, lastSeen: now,
    };
    out.set(p.id, p);
  }
  return [...out.values()];
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(UV, ['run', '-q', SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`jobspy timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolveRun(stdout) : reject(new Error(`jobspy exited ${code}: ${stderr.trim().split('\n').pop()}`));
    });
  });
}

export async function fetch(company: Company, ctx: FetchContext): Promise<Posting[]> {
  const terms = company.search ?? DEFAULT_SEARCH;
  const args = ['--sites', company.slug, '--results', '25', ...terms.flatMap((t) => ['--term', t])];
  // A scrape is many slow searches with pauses between; the per-board
  // timeout is sized for one JSON request, so allow a minute per term.
  const out = await run(args, Math.max(ctx.timeoutMs, terms.length * 60_000));
  return parseJobspy(JSON.parse(out || '[]'), ctx.now);
}
