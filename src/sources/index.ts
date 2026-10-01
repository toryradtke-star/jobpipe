/**
 * Fetching the boards.
 *
 * One request per company per poll, run a few at a time. These are public
 * endpoints an employer publishes so their postings get read, but that is not
 * a reason to hammer them: the concurrency is deliberately low, and a failed
 * request is retried twice with backoff and then reported, not retried forever.
 *
 * Most adapters are one GET: they export `url()` and `parse()`. An adapter
 * whose board needs more than that — Workday pages through a search and then
 * reads each job — exports `fetch()` instead and does its own requests
 * through `request()`, so it gets the same timeout, retries and user agent.
 */
import type { Ats, Company, Posting } from '../types.ts';
import * as greenhouse from './greenhouse.ts';
import * as ashby from './ashby.ts';
import * as lever from './lever.ts';
import * as workday from './workday.ts';
import { getJson, type FetchContext } from './http.ts';

type Adapter =
  | { url(slug: string): string; parse(body: unknown, company: Company, now: string): Posting[] }
  | { fetch(company: Company, ctx: FetchContext): Promise<Posting[]> };

const ADAPTERS: Record<Ats, Adapter> = { greenhouse, ashby, lever, workday };

export const SUPPORTED: Ats[] = Object.keys(ADAPTERS) as Ats[];

export type FetchResult =
  | { ok: true; company: Company; postings: Posting[] }
  | { ok: false; company: Company; error: string };

async function fetchOne(company: Company, timeoutMs: number): Promise<FetchResult> {
  const adapter = ADAPTERS[company.ats];
  if (!adapter) return { ok: false, company, error: `unsupported ats: ${company.ats}` };
  const now = new Date().toISOString();
  try {
    const postings = 'fetch' in adapter
      ? await adapter.fetch(company, { now, timeoutMs })
      : adapter.parse(await getJson(adapter.url(company.slug), { timeoutMs }), company, now);
    return { ok: true, company, postings };
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
export async function probe(company: Company, timeoutMs = 25_000): Promise<{ ok: boolean; count: number; error?: string }> {
  // Reading a whole Workday site means dozens of requests; one search says
  // whether it is alive.
  if (company.ats === 'workday') {
    try { return { ok: true, count: await workday.probe(company, { now: '', timeoutMs }) }; }
    catch (err) { return { ok: false, count: 0, error: err instanceof Error ? err.message : String(err) }; }
  }
  const r = await fetchOne(company, timeoutMs);
  if (!r.ok) return { ok: false, count: 0, error: r.error };
  return { ok: true, count: r.postings.length };
}
