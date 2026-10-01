/**
 * Lever job boards.
 *
 * https://api.lever.co/v0/postings/{slug}?mode=json
 *
 * Lever splits a posting across four fields: the opening blurb, the body, the
 * bulleted `lists` (which is where requirements and qualifications live), and
 * a closing `additional`. A description built from the body alone misses the
 * requirements entirely, which is exactly the half the screen needs, so all
 * four are joined.
 */
import type { Ats, Company, Posting } from '../types.ts';
import { htmlToText, isoOrNull, parseSalary } from '../normalize.ts';

const ATS: Ats = 'lever';

export function url(slug: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
}

export function parse(body: unknown, company: Company, now: string): Posting[] {
  if (!Array.isArray(body)) return [];
  return body.map((raw) => {
    const j = raw as Record<string, any>;
    const lists = Array.isArray(j.lists)
      ? j.lists.map((l: any) => `${l?.text ?? ''}\n${htmlToText(String(l?.content ?? ''))}`).join('\n\n')
      : '';
    const description = [
      j.openingPlain ?? htmlToText(String(j.opening ?? '')),
      j.descriptionPlain ?? htmlToText(String(j.description ?? '')),
      lists,
      j.additionalPlain ?? htmlToText(String(j.additional ?? '')),
    ].filter(Boolean).join('\n\n').trim();
    const salary = parseSalary(description);
    const externalId = String(j.id ?? '');
    const locations: string[] = Array.isArray(j.categories?.allLocations)
      ? j.categories.allLocations
      : j.categories?.location ? [j.categories.location] : [];
    return {
      id: `${ATS}:${company.slug}:${externalId}`,
      ats: ATS,
      slug: company.slug,
      company: company.name,
      externalId,
      title: String(j.text ?? '').trim(),
      description: [
        j.workplaceType ? `Workplace type: ${j.workplaceType}` : '',
        description,
      ].filter(Boolean).join('\n'),
      location: locations.length ? locations.join(' | ') : null,
      department: j.categories?.team ? String(j.categories.team) : null,
      employmentType: j.categories?.commitment ? String(j.categories.commitment) : null,
      postedAt: isoOrNull(j.createdAt),
      url: String(j.hostedUrl ?? j.applyUrl ?? ''),
      salaryMin: salary?.min ?? null,
      salaryMax: salary?.max ?? null,
      salarySource: salary ? 'description' : null,
      firstSeen: now,
      lastSeen: now,
    } satisfies Posting;
  }).filter((p) => p.externalId && p.title);
}
