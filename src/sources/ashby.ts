/**
 * Ashby job boards.
 *
 * https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *
 * The richest of the three: it states a workplace type and a remote flag as
 * fields rather than leaving them in prose, and with the compensation
 * parameter it states pay as a number. Those are taken over anything parsed
 * out of the description, because a field the employer filled in beats a
 * regular expression run over their marketing copy.
 */
import type { Ats, Company, Posting } from '../types.ts';
import { htmlToText, isoOrNull, parseSalary } from '../normalize.ts';

const ATS: Ats = 'ashby';

export function url(slug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

/** Ashby writes its summary as "$211.4K – $290.6K", which parseSalary reads. */
function structuredPay(j: Record<string, any>): { min: number; max: number } | null {
  const summary = j.compensation?.scrapeableCompensationSalarySummary
    ?? j.compensation?.compensationTierSummary;
  return typeof summary === 'string' ? parseSalary(summary) : null;
}

export function parse(body: unknown, company: Company, now: string): Posting[] {
  const all = (body as { jobs?: unknown[] })?.jobs;
  if (!Array.isArray(all)) return [];
  // Ashby publishes unlisted postings on the same feed; keep only listed ones.
  const jobs = all.filter((j) => (j as Record<string, any>)?.isListed !== false);
  return jobs.map((raw) => {
    const j = raw as Record<string, any>;
    const description = j.descriptionPlain
      ? String(j.descriptionPlain)
      : htmlToText(String(j.descriptionHtml ?? ''));
    const structured = structuredPay(j);
    const salary = structured ?? parseSalary(description);
    const externalId = String(j.id ?? '');
    const locations = [j.location, ...(Array.isArray(j.secondaryLocations) ? j.secondaryLocations.map((s: any) => s?.location) : [])]
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
    return {
      id: `${ATS}:${company.slug}:${externalId}`,
      ats: ATS,
      slug: company.slug,
      company: company.name,
      externalId,
      title: String(j.title ?? '').trim(),
      // The workplace type is a field here; keep it in the text so the screen
      // and the judge both see it without needing a column of its own.
      description: [
        j.workplaceType ? `Workplace type: ${j.workplaceType}` : '',
        j.isRemote === true ? 'Remote: yes' : j.isRemote === false ? 'Remote: no' : '',
        description,
      ].filter(Boolean).join('\n'),
      location: locations.length ? [...new Set(locations)].join(' | ') : null,
      department: j.department ? String(j.department) : null,
      employmentType: j.employmentType ? String(j.employmentType) : null,
      postedAt: isoOrNull(j.publishedAt),
      url: String(j.jobUrl ?? j.applyUrl ?? ''),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salarySource: salary ? (structured ? 'structured' : 'description') : null,
      firstSeen: now,
      lastSeen: now,
    } satisfies Posting;
  }).filter((p) => p.externalId && p.title);
}
