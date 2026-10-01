/**
 * Fetching the boards.
 *
 * One request per company per poll, run a few at a time. These are public
 * endpoints an employer publishes so their postings get read, but that is not
 * a reason to hammer them: the concurrency is deliberately low and a failed
 * board is reported rather than retried forever.
 */
import type { Ats, Company, Posting } from '../types.ts';
import * as greenhouse from './greenhouse.ts';
import * as ashby from './ashby.ts';
import * as lever from './lever.ts';

const ADAPTERS = { greenhouse, ashby, lever } as const;

export const SUPPORTED: Ats[] = Object.keys(ADAPTERS) as Ats[];

export type FetchResult =
  | { ok: true; company: Company; postings: Posting[] }
  | { ok: false; company: Company; error: string };

const USER_AGENT = 'jobpipe/0.1 (personal job search; contact via repo)';

async function fetchOne(company: Company, timeoutMs: number): Promise<FetchResult> {
  const adapter = ADAPTERS[company.ats];
  if (!adapter) return { ok: false, company, error: `unsupported ats: ${company.ats}` };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(adapter.url(company.slug), {
      signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) return { ok: false, company, error: `http ${res.status}` };
    const body = await res.json();
    const now = new Date().toISOString();
    return { ok: true, company, postings: adapter.parse(body, company, now) };
  } catch (err) {
    return { ok: false, company, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Polls every company, at most `concurrency` requests in flight. */
export async function fetchAll(
  companies: Company[],
  opts: { concurrency?: number; timeoutMs?: number; onResult?: (r: FetchResult) => void } = {},
): Promise<FetchResult[]> {
  const { concurrency = 4, timeoutMs = 30_000, onResult } = opts;
  const results: FetchResult[] = [];
  const queue = [...companies];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const r = await fetchOne(next, timeoutMs);
      results.push(r);
      onResult?.(r);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Checks a slug is real without keeping the postings. Used by `verify`. */
export async function probe(company: Company): Promise<{ ok: boolean; count: number; error?: string }> {
  const r = await fetchOne(company, 25_000);
  if (!r.ok) return { ok: false, count: 0, error: r.error };
  return { ok: true, count: r.postings.length };
}
