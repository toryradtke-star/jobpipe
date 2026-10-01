/**
 * Workday career sites.
 *
 * POST https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 * GET  https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
 *
 * The slug is "tenant|wd5|site", the same shape job-board-aggregator publishes
 * its Workday list in, so its rows drop straight into the registry.
 *
 * Unlike the other three boards, Workday will not hand over everything in one
 * request: the list endpoint is a search returning 20 at a time with no
 * description, and each description is another request. A large employer has
 * thousands of postings, nearly all of them engineering or nursing or retail.
 * So this adapter searches for the roles Tory is after rather than reading the
 * whole board, drops titles the screen would throw away on the title alone,
 * and only then fetches descriptions.
 */
import type { Ats, Company, Posting } from '../types.ts';
import { htmlToText, isoOrNull, parseSalary } from '../normalize.ts';
import { titleReasons } from '../screen.ts';
import { getJson, type FetchContext } from './http.ts';

const ATS: Ats = 'workday';

/** The searches run when a registry entry names none of its own. */
export const DEFAULT_SEARCH = [
  'GTM', 'growth', 'marketing', 'automation', 'solutions engineer',
  'developer advocate', 'revenue operations', 'web developer',
];

const PAGE = 20;
const MAX_PAGES = 3;
const DETAIL_CONCURRENCY = 3;

export function parseSlug(slug: string): { tenant: string; wd: string; site: string } {
  const [tenant, wd, site] = slug.split('|');
  if (!tenant || !wd || !site) throw new Error(`workday slug must be tenant|wdN|site, got "${slug}"`);
  return { tenant, wd, site };
}

function base(slug: string): { api: string; site: string; host: string } {
  const { tenant, wd, site } = parseSlug(slug);
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`;
  return { api: `${host}/wday/cxs/${tenant}/${site}`, site, host };
}

export type ListHit = { title: string; externalPath: string; locationsText: string | null };

/** One page of the search endpoint, as hits. */
export function parseList(body: unknown): { total: number; hits: ListHit[] } {
  const b = body as { total?: number; jobPostings?: Record<string, any>[] };
  const hits = (Array.isArray(b?.jobPostings) ? b.jobPostings : [])
    .filter((j) => typeof j?.externalPath === 'string' && typeof j?.title === 'string')
    .map((j) => ({ title: String(j.title).trim(), externalPath: j.externalPath,
      locationsText: typeof j.locationsText === 'string' ? j.locationsText : null }));
  return { total: typeof b?.total === 'number' ? b.total : 0, hits };
}

/** One job's detail response, as a Posting. */
export function parseDetail(body: unknown, company: Company, hit: ListHit, now: string): Posting | null {
  const j = (body as { jobPostingInfo?: Record<string, any> })?.jobPostingInfo;
  if (!j) return null;
  const { host, site } = base(company.slug);
  const description = htmlToText(String(j.jobDescription ?? ''));
  const salary = parseSalary(description);
  const externalId = String(j.jobReqId ?? j.id ?? hit.externalPath);
  const locations = [j.location, ...(Array.isArray(j.additionalLocations) ? j.additionalLocations : [])]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  const country = j.jobRequisitionLocation?.country?.descriptor ?? j.country?.descriptor;
  return {
    id: `${ATS}:${company.slug}:${externalId}`,
    ats: ATS,
    slug: company.slug,
    company: company.name,
    externalId,
    title: String(j.title ?? hit.title).trim(),
    // Workday states the country and sometimes a remote type as fields; keep
    // them in the text where the place reader and the judge will see them.
    description: [
      j.remoteType ? `Remote type: ${j.remoteType}` : '',
      country ? `Country: ${country}` : '',
      description,
    ].filter(Boolean).join('\n'),
    location: locations.length ? [...new Set(locations)].join(' | ') : hit.locationsText,
    department: null,
    employmentType: j.timeType ? String(j.timeType) : null,
    postedAt: isoOrNull(j.startDate),
    url: typeof j.externalUrl === 'string' ? j.externalUrl : `${host}/${site}${hit.externalPath}`,
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salarySource: salary ? 'description' : null,
    firstSeen: now,
    lastSeen: now,
  };
}

export async function fetch(company: Company, ctx: FetchContext): Promise<Posting[]> {
  const { api } = base(company.slug);
  const hits = new Map<string, ListHit>();
  for (const searchText of company.search ?? DEFAULT_SEARCH) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await getJson(`${api}/jobs`, {
        method: 'POST', timeoutMs: ctx.timeoutMs,
        body: { appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText },
      });
      const { total, hits: found } = parseList(body);
      for (const h of found) if (!titleReasons(h.title).length) hits.set(h.externalPath, h);
      if ((page + 1) * PAGE >= total || !found.length) break;
    }
  }
  const pending = [...hits.values()];
  const postings: Posting[] = [];
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, async () => {
    for (let h = pending.shift(); h; h = pending.shift()) {
      const p = parseDetail(await getJson(`${api}${h.externalPath}`, { timeoutMs: ctx.timeoutMs }), company, h, ctx.now);
      if (p) postings.push(p);
    }
  }));
  return postings;
}

/** One search request, enough to tell a live site from a dead one. Used by `verify`. */
export async function probe(company: Company, ctx: FetchContext): Promise<number> {
  const body = await getJson(`${base(company.slug).api}/jobs`, {
    method: 'POST', timeoutMs: ctx.timeoutMs, retries: 0,
    body: { appliedFacets: {}, limit: 1, offset: 0, searchText: '' },
  });
  return parseList(body).total;
}
