/**
 * Greenhouse job boards.
 *
 * https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 * Unauthenticated, one request per board, every description included.
 *
 * The one oddity: `content` arrives HTML-escaped HTML, so the entities have to
 * come off before the tags do. htmlToText decodes entities after stripping
 * tags, so it is run twice rather than taught a special case.
 */
import type { Ats, Company, Posting } from '../types.ts';
import { htmlToText, isoOrNull, parseSalary } from '../normalize.ts';

const ATS: Ats = 'greenhouse';

export function url(slug: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
}

export function parse(body: unknown, company: Company, now: string): Posting[] {
  const jobs = (body as { jobs?: unknown[] })?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((raw) => {
    const j = raw as Record<string, any>;
    // Escaped HTML: decode the entities, then strip the tags they hid.
    const description = htmlToText(htmlToText(String(j.content ?? '')));
    const salary = parseSalary(description);
    const externalId = String(j.id ?? j.internal_job_id ?? '');
    return {
      id: `${ATS}:${company.slug}:${externalId}`,
      ats: ATS,
      slug: company.slug,
      company: company.name,
      externalId,
      title: String(j.title ?? '').trim(),
      description,
      location: j.location?.name ? String(j.location.name) : null,
      department: Array.isArray(j.departments) && j.departments[0]?.name ? String(j.departments[0].name) : null,
      employmentType: null,
      postedAt: isoOrNull(j.first_published) ?? isoOrNull(j.updated_at),
      url: String(j.absolute_url ?? ''),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salarySource: salary ? 'description' : null,
      firstSeen: now,
      lastSeen: now,
    } satisfies Posting;
  }).filter((p) => p.externalId && p.title);
}
