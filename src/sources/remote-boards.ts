/**
 * Remote-only job boards: Remotive, RemoteOK, Himalayas, We Work Remotely.
 *
 * These are not one employer's board but many employers' postings in one
 * feed, so a registry entry names the feed rather than a company:
 *
 *   { "name": "Himalayas", "ats": "himalayas", "slug": "us", "tags": ["feed"],
 *     "search": ["GTM engineer", "growth engineer"] }
 *
 * The employer on each posting comes from the feed. The posting id is keyed on
 * the employer and the board's own job id, never the search term, so a job
 * that matches three searches is stored once.
 *
 * Every board here is remote by construction, and says so in the description
 * it hands the screen, along with whatever location restriction it states — a
 * "remote" job restricted to Germany is still outside the US.
 *
 * Terms worth knowing: Remotive asks for at most four pulls a day and that
 * listings link back to it; RemoteOK asks for a link back. One person reading
 * postings to apply to them is the use both are fine with.
 */
import type { Ats, Company, Posting } from '../types.ts';
import { htmlToText, isoOrNull, parseSalary } from '../normalize.ts';
import { getJson, request, type FetchContext } from './http.ts';

/** "Acme Labs, Inc." → "acme-labs-inc", the slug half of a feed posting's id. */
export function employerSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

type Raw = {
  ats: Ats; externalId: string; company: string; title: string; descriptionHtml: string;
  remoteNote: string; location: string | null; employmentType: string | null;
  postedAt: string | null; url: string; pay: { min: number; max: number } | null;
};

function toPosting(r: Raw, now: string): Posting {
  const description = htmlToText(r.descriptionHtml);
  const parsed = r.pay ? null : parseSalary(description);
  const slug = employerSlug(r.company);
  return {
    id: `${r.ats}:${slug}:${r.externalId}`,
    ats: r.ats, slug, company: r.company.trim(), externalId: r.externalId,
    title: r.title.trim(),
    description: [r.remoteNote, description].filter(Boolean).join('\n'),
    location: r.location, department: null, employmentType: r.employmentType,
    postedAt: r.postedAt, url: r.url,
    salaryMin: r.pay?.min ?? parsed?.min ?? null,
    salaryMax: r.pay?.max ?? parsed?.max ?? null,
    salarySource: r.pay ? 'structured' : parsed ? 'description' : null,
    firstSeen: now, lastSeen: now,
  };
}

/** Structured pay, kept only when it reads as an annual USD salary. */
function annualUsd(min: unknown, max: unknown, currency = 'USD'): { min: number; max: number } | null {
  const lo = Number(min), hi = Number(max);
  if (currency !== 'USD' || !Number.isFinite(lo) || !Number.isFinite(hi) || lo < 15_000 || hi > 1_000_000 || hi < lo) return null;
  return { min: lo, max: hi };
}

const restricted = (where: string | null) =>
  where ? `Remote: yes\nLocation restriction: ${where}` : 'Remote: yes';

// ── Remotive ──────────────────────────────────────────────────────────────
// https://remotive.com/api/remote-jobs?category=marketing — search terms are categories.

export function parseRemotive(body: unknown, now: string): Posting[] {
  const jobs = (body as { jobs?: Record<string, any>[] })?.jobs ?? [];
  return jobs.filter((j) => j?.id && j?.title && j?.company_name).map((j) => {
    const where = String(j.candidate_required_location ?? '').trim() || null;
    return toPosting({
      ats: 'remotive', externalId: String(j.id), company: String(j.company_name),
      title: String(j.title), descriptionHtml: `${j.salary ? `<p>Salary: ${j.salary}</p>` : ''}${j.description ?? ''}`,
      remoteNote: restricted(where), location: where ? `Remote (${where})` : 'Remote',
      employmentType: j.job_type ? String(j.job_type).replace(/_/g, ' ') : null,
      postedAt: isoOrNull(j.publication_date ? `${j.publication_date}Z` : null), url: String(j.url), pay: null,
    }, now);
  });
}

export const remotive = {
  async fetch(company: Company, ctx: FetchContext): Promise<Posting[]> {
    const out: Posting[] = [];
    for (const category of company.search ?? ['marketing', 'software-dev']) {
      out.push(...parseRemotive(await getJson(`https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`, { timeoutMs: ctx.timeoutMs }), ctx.now));
    }
    return out;
  },
};

// ── RemoteOK ──────────────────────────────────────────────────────────────
// https://remoteok.com/api — one feed of the latest ~100; the first element is the legal notice.

export function parseRemoteOk(body: unknown, now: string): Posting[] {
  const rows = Array.isArray(body) ? body as Record<string, any>[] : [];
  return rows.filter((j) => j?.id && j?.position && j?.company).map((j) => {
    const where = String(j.location ?? '').trim() || null;
    return toPosting({
      ats: 'remoteok', externalId: String(j.id), company: String(j.company), title: String(j.position),
      descriptionHtml: String(j.description ?? ''), remoteNote: restricted(where),
      location: where ? `Remote (${where})` : 'Remote', employmentType: null,
      postedAt: isoOrNull(j.date), url: String(j.url ?? j.apply_url), pay: annualUsd(j.salary_min, j.salary_max),
    }, now);
  });
}

export const remoteok = {
  async fetch(_company: Company, ctx: FetchContext): Promise<Posting[]> {
    return parseRemoteOk(await getJson('https://remoteok.com/api', { timeoutMs: ctx.timeoutMs }), ctx.now);
  },
};

// ── Himalayas ─────────────────────────────────────────────────────────────
// https://himalayas.app/jobs/api/search?q=...&country=US&page=N — the slug is the country filter.

export function parseHimalayas(body: unknown, now: string): Posting[] {
  const jobs = (body as { jobs?: Record<string, any>[] })?.jobs ?? [];
  return jobs.filter((j) => j?.guid && j?.title && j?.companyName).map((j) => {
    const places = Array.isArray(j.locationRestrictions) ? j.locationRestrictions.join(', ') : '';
    const pay = j.salaryPeriod === 'annual' ? annualUsd(j.minSalary, j.maxSalary, j.currency ?? undefined) : null;
    return toPosting({
      ats: 'himalayas', externalId: String(j.guid).split('/').filter(Boolean).pop()!,
      company: String(j.companyName), title: String(j.title), descriptionHtml: String(j.description ?? j.excerpt ?? ''),
      remoteNote: restricted(places || 'Worldwide'), location: places ? `Remote (${places})` : 'Remote (Worldwide)',
      employmentType: j.employmentType ? String(j.employmentType) : null,
      postedAt: isoOrNull(Number(j.pubDate)), url: String(j.applicationLink ?? j.guid), pay,
    }, now);
  });
}

export const himalayas = {
  async fetch(company: Company, ctx: FetchContext): Promise<Posting[]> {
    const country = company.slug === 'worldwide' ? '' : `&country=${encodeURIComponent(company.slug.toUpperCase())}`;
    const seen = new Map<string, Posting>();
    for (const q of company.search ?? ['GTM engineer', 'growth engineer', 'marketing engineer']) {
      for (let page = 1; page <= 2; page++) {
        const body = await getJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}${country}&page=${page}`, { timeoutMs: ctx.timeoutMs });
        const found = parseHimalayas(body, ctx.now);
        for (const p of found) seen.set(p.id, p);
        const total = Number((body as any)?.totalCount ?? 0);
        if (!found.length || page * 20 >= total) break;
      }
    }
    return [...seen.values()];
  },
};

// ── We Work Remotely ──────────────────────────────────────────────────────
// https://weworkremotely.com/categories/{category}.rss — search terms are category slugs.

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) => s
  .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]);
const tag = (item: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
  return m ? unxml(m[1].trim()) : '';
};

export function parseWwr(xml: string, now: string): Posting[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    // Titles read "Company: Role"; a colon inside the role stays with the role.
    const full = tag(item, 'title');
    const i = full.indexOf(': ');
    const [company, title] = i > 0 ? [full.slice(0, i), full.slice(i + 2)] : ['Unknown', full];
    const link = tag(item, 'link') || tag(item, 'guid');
    const where = [tag(item, 'region'), tag(item, 'country'), tag(item, 'state')].filter(Boolean).join(', ') || null;
    return toPosting({
      ats: 'wwr', externalId: link.split('/').filter(Boolean).pop() ?? link, company, title,
      descriptionHtml: tag(item, 'description'), remoteNote: restricted(where),
      location: where ? `Remote (${where})` : 'Remote', employmentType: tag(item, 'type') || null,
      postedAt: isoOrNull(tag(item, 'pubDate')), url: link, pay: null,
    }, now);
  }).filter((p) => p.title && p.url);
}

export const wwr = {
  async fetch(company: Company, ctx: FetchContext): Promise<Posting[]> {
    const out: Posting[] = [];
    for (const category of company.search ?? ['remote-sales-and-marketing-jobs']) {
      const res = await request(`https://weworkremotely.com/categories/${encodeURIComponent(category)}.rss`,
        { accept: 'application/rss+xml, application/xml', timeoutMs: ctx.timeoutMs });
      out.push(...parseWwr(await res.text(), ctx.now));
    }
    return out;
  },
};
