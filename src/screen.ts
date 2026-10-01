/**
 * The deterministic screen: the rules that can be decided without a model.
 *
 * These are Tory's rule-outs from job-search/pinloop/constraints.txt, written
 * as code. Every rule is named, and a posting that is ruled out records which
 * rules fired, so a screen that is throwing away good postings can be argued
 * with rather than guessed at.
 *
 * The bias is deliberate and one-way. A rule fires only on evidence that is
 * hard to misread — a level word in the title, the word "clearance", a stated
 * range whose top is under the floor. Anything needing judgment (is this
 * degree requirement real, is this role actually adjacent enough) is left to
 * pass, because the judge downstream is cheap and a wrongly discarded posting
 * is never seen again.
 */
import type { Posting, Screen } from './types.ts';
import { readPlace } from './place.ts';

export type Rules = {
  /** Skip when the top of a stated range is below this. Unstated pay passes. */
  payFloor: number;
  /** Words in a title that mean the role is above this candidate's level. */
  tooSenior: RegExp;
  /** Words in a title that mean the wrong job family entirely. */
  wrongFunction: RegExp;
  /** Words in a title that mean a specialism this candidate does not have. */
  deepSpecialist: RegExp;
};

export const DEFAULT_RULES: Rules = {
  payFloor: 0, // no floor unless profile/rules.json sets one
  tooSenior: /\b(senior|sr\.?|staff|principal|distinguished|lead|leader|director|head of|vp|vice president|chief|architect|manager|mgr|fellow)\b/i,
  wrongFunction: /\b(account executive|account manager|sales development|sdr|bdr|business development|recruiter|recruiting|talent acquisition|customer support|technical support|support specialist|customer success|help desk|collections|underwriter)\b/i,
  deepSpecialist: /\b(backend|back-end|infrastructure|platform engineer|site reliability|sre|devops|kubernetes|data engineer|machine learning engineer|ml engineer|research scientist|android|ios|mobile engineer|embedded|firmware|compiler|security engineer|network engineer|database administrator|dba)\b/i,
};

/**
 * Level words that no other word in a title can take back. "Senior Platform
 * Engineer II" is a senior role; the numeral is a rung inside the senior band,
 * not a junior marker, and an earlier version of this file was fooled by it.
 */
const HARD_SENIOR = /\b(senior|sr\.?|staff|principal|distinguished|director|head of|vp|vice president|chief|fellows?|executive)\b/i;

/** Words that genuinely mark a junior rung, used only against soft level words. */
const JUNIOR_MARKER = /\b(junior|jr\.?|entry[- ]level|associate|early[- ]career|apprentice|graduate)\b/i;

const INTERNSHIP = /\b(intern|internship|co-?op|apprentice|apprenticeship|new grad|new-grad|university grad|student program|returnship|fellowship|fellows program)\b/i;

const CLEARANCE = /\b(security clearance|ts\/sci|top secret|public trust|secret clearance|dod clearance|polygraph|clearable|q clearance|l clearance)\b/i;

const NO_BASE = /\b(commission[- ]only|100% commission|uncapped commission only|equity[- ]only|unpaid|volunteer position|no base salary)\b/i;





/** A degree requirement that the posting itself does not soften. */
const HARD_DEGREE = /\b(bachelor'?s?|b\.?s\.?|master'?s?|m\.?s\.?|ph\.?d\.?|degree)\b[^.\n]{0,80}\b(computer science|software engineering|electrical engineering|mathematics|statistics)\b/i;
const DEGREE_SOFTENED = /\b(or equivalent|in lieu of|equivalent (?:practical |hands-on |work |professional )?experience|degree (?:is )?(?:not required|preferred but)|no degree|or relevant experience|or comparable)\b/i;

/**
 * The rules that read nothing but the title. Split out so a board that costs a
 * request per description (Workday) can skip fetching ones the screen would
 * throw away on the title alone.
 */
export function titleReasons(title: string, rules: Rules = DEFAULT_RULES): string[] {
  const reasons: string[] = [];
  // Level. The title is the reliable signal. A hard senior word settles it
  // outright; a soft one ("lead", "manager", "architect") can be taken back by
  // a junior marker in the same title.
  if (HARD_SENIOR.test(title)) reasons.push('too-senior');
  else if (rules.tooSenior.test(title) && !JUNIOR_MARKER.test(title)) reasons.push('too-senior');
  if (INTERNSHIP.test(title)) reasons.push('internship');
  if (rules.wrongFunction.test(title)) reasons.push('wrong-function');
  if (rules.deepSpecialist.test(title)) reasons.push('deep-specialist');
  return reasons;
}

export function screenPosting(p: Posting, rules: Rules = DEFAULT_RULES): Screen {
  const title = p.title;
  const where = `${p.location ?? ''}`;
  const text = `${p.title}\n${where}\n${p.description}`;
  const head = p.description.slice(0, 4_000);

  const reasons = titleReasons(title, rules);
  if (!reasons.includes('internship') && INTERNSHIP.test(head)) reasons.push('internship');
  if (CLEARANCE.test(text)) reasons.push('clearance');
  if (NO_BASE.test(text)) reasons.push('no-base-pay');

  // Pay. Only a stated range can rule out; silence passes to the judge.
  if (p.salaryMax !== null && p.salaryMax < rules.payFloor) reasons.push('below-floor');

  // Place. Silence counts against a posting here: a role that never says it is
  // remote is an office job, whatever the absence of the word "hybrid" implies.
  const place = readPlace(p.location, p.description);
  if (!place.remote) reasons.push('not-remote');
  else if (place.officeDays) reasons.push('office-days-required');
  if (place.elsewhere && !place.us) reasons.push('outside-us');
  else if (!place.us && !place.elsewhere) reasons.push('us-not-stated');

  // Degree, only when the posting never softens it.
  if (HARD_DEGREE.test(head) && !DEGREE_SOFTENED.test(head)) reasons.push('hard-degree');

  return {
    postingId: p.id,
    verdict: reasons.length ? 'out' : 'pass',
    reasons,
    screenedAt: new Date().toISOString(),
  };
}
