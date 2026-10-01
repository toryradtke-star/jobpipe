/**
 * The same job, polled from several places.
 *
 * Himalayas lists a startup's GTM Engineer role; so does the startup's own
 * Ashby board; so does Indeed, three times, once per city. Without this the
 * judge reads it five times and the queue offers it five times.
 *
 * A fingerprint is the employer and the title, both normalized. Location is
 * left out on purpose: every source writes it differently, and one role
 * listed in several cities is still one application.
 *
 * Dedupe runs after the other rules and only among copies that passed them:
 * a role listed in London and as US-remote is two postings on one board, and
 * keeping the London one would lose the job. When passing copies collide, the
 * employer's own board wins — its description is the
 * full one, its URL is where the application happens, and it disappears when
 * the role closes, which a feed's copy may not.
 */
import type { Ats } from './types.ts';

/** Lower is more trusted. */
export const SOURCE_RANK: Record<Ats, number> = {
  greenhouse: 0, ashby: 0, lever: 0, workday: 0,
  himalayas: 1, remotive: 1, wwr: 1, remoteok: 2,
  jobspy: 3,
};

const COMPANY_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|pbc|technologies|technology|labs|hq|ai|io)\b\.?/g;
const TITLE_NOISE = /\(([^)]*)\)|\[[^\]]*\]|\s[-–—|]\s*(remote|hybrid|us|usa|united states|anywhere)\b.*$|\b(remote|100% remote|fully remote)\b/gi;

export function normalizeCompany(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^\w\s.]/g, ' ')
    .replace(COMPANY_SUFFIX, ' ').replace(/[^a-z0-9]+/g, '');
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(TITLE_NOISE, ' ')
    .replace(/\bsr\b\.?/g, 'senior').replace(/\bjr\b\.?/g, 'junior')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function fingerprint(company: string, title: string): string {
  return `${normalizeCompany(company)}|${normalizeTitle(title)}`;
}

export type Candidate = { id: string; ats: Ats; firstSeen: string; lastSeen: string; judged?: boolean };

/**
 * The copy to keep: most trusted source; then one already judged, so a new
 * copy never costs a second judgment; then the most recently seen, so a
 * closed listing never wins over a live one; then the first seen.
 */
export function preferred<T extends Candidate>(copies: T[]): T {
  return [...copies].sort((a, b) =>
    (SOURCE_RANK[a.ats] ?? 9) - (SOURCE_RANK[b.ats] ?? 9)
    || Number(!!b.judged) - Number(!!a.judged)
    || b.lastSeen.slice(0, 10).localeCompare(a.lastSeen.slice(0, 10))
    || a.firstSeen.localeCompare(b.firstSeen)
    || a.id.localeCompare(b.id))[0];
}
