/**
 * Applying without Tory at the keyboard.
 *
 * Tory asked for this on 2026-10-01, knowing how an early manual one went wrong. What
 * keeps it honest is the lane, not a person:
 *
 *   - only postings the judge scored 4+, believed remote, and saw low ghost
 *     risk in;
 *   - only through the employer's own Greenhouse, Lever or Ashby board, found
 *     here by matching the title — never a feed's copy, never a site that
 *     wants an account, a password or a CAPTCHA;
 *   - only with a resume Claude tailored that passes `build` (one page,
 *     differs from the master) AND the fact check below, which rejects any
 *     number or proper noun the source documents do not already contain.
 *
 * Anything outside the lane stays in the manual queue. Each attempt is one
 * fresh `claude -p` turn driving a headless, profile-less Chrome, so it never
 * touches Tory's own browser or logged-in sessions.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ats, Company, Posting } from './types.ts';
import { normalizeCompany, normalizeTitle } from './dedupe.ts';
import { extractJson } from './judge.ts';

const run = promisify(execFile);

export const LANE_ATS: Ats[] = ['greenhouse', 'lever', 'ashby'];

/** Board slugs an employer is likely to use, most likely first. */
export function slugCandidates(company: string): string[] {
  const kebab = company.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([kebab, kebab.replace(/-/g, ''), normalizeCompany(company)])].filter((s) => s.length >= 3);
}

/** Registry entries to probe for an employer's own copy of a feed posting. */
export function probeTargets(company: string): Company[] {
  return slugCandidates(company).flatMap((slug) => LANE_ATS.map((ats) => ({ name: company, ats, slug })));
}

/** The employer copy with the same title, if one of the probed boards has it. */
export function matchTitle(title: string, postings: Posting[]): Posting | null {
  const want = normalizeTitle(title);
  return postings.find((p) => normalizeTitle(p.title) === want) ?? null;
}

/**
 * The page the application form is on. Greenhouse's `absolute_url` is often
 * the employer's own careers site with the form in an iframe; the hosted board
 * has the form on the page.
 */
export function applyUrl(p: Pick<Posting, 'ats' | 'slug' | 'externalId' | 'url'>): string | null {
  switch (p.ats) {
    case 'greenhouse': return `https://job-boards.greenhouse.io/${p.slug}/jobs/${p.externalId}`;
    case 'lever': return `https://jobs.lever.co/${p.slug}/${p.externalId}/apply`;
    case 'ashby': return `https://jobs.ashbyhq.com/${p.slug}/${p.externalId}/application`;
    default: return null;
  }
}

/** Hosts an automatic application may be filled on. */
export const LANE_HOSTS = /^(job-boards|boards)(\.eu)?\.greenhouse\.io$|^jobs\.(eu\.)?lever\.co$|^jobs\.ashbyhq\.com$/;

const COMMON = new Set(`a an and the of for to in on at by with from as is are was were be been this that these those it its
  i my me we our you your they their he she his her into over under across through per via vs not no or nor but so than then
  built build builds building designed design designs led lead leads managed manage manages own owns owned created create
  shipped ship ships developed develop develops maintained maintain maintains engineered engineer architected architect
  deployed deploy published publish analyzed analyze executed execute executes summary experience education skills present
  remote independent january february march april may june july august september october november december`
  .split(/\s+/).filter(Boolean));

/**
 * The words in a tailored resume that state facts: numbers, and capitalized
 * or code-ish terms (products, employers, tools). Ordinary words are free to
 * change; these are not.
 */
export function factTokens(text: string): Set<string> {
  const body = text.replace(/^---[\s\S]*?\n---\n/, '');
  const out = new Set<string>();
  for (const m of body.matchAll(/[$~]?\d[\d,.]*\s?(?:[kKmMbB]\b|%|\+)?/g)) out.add(m[0].replace(/[\s,~]/g, '').replace(/\.$/, '').toLowerCase());
  for (const m of body.matchAll(/`([^`]+)`|\b([A-Z][\w.+/#-]*[\w+#]|[A-Z])\b/g)) {
    const t = (m[1] ?? m[2]).toLowerCase();
    if (!COMMON.has(t)) out.add(t);
  }
  return out;
}

/** Spend Tory monitors is not spend Tory manages; a resume must never say so. */
const MANAGED_SPEND = /\b(manag|own|oversaw|oversee|controll?|direct|allocat)\w*\b[^.\n]{0,60}\b(spend|budget)/i;

/**
 * What is wrong with a tailored resume, judged against everything Tory has
 * written down about themselves. Empty means it only rephrases.
 */
export function factCheck(tailored: string, master: string, corpus: string): string[] {
  const problems: string[] = [];
  const front = (s: string) => /^---[\s\S]*?\n---\n/.exec(s)?.[0] ?? '';
  if (front(tailored) !== front(master)) problems.push('the header (name, contact, links) was changed');
  const known = factTokens(`${master}\n${corpus}`);
  const knownText = `${master}\n${corpus}`.toLowerCase();
  // A word is known when its stem is: "Marketer" opening a sentence is fine
  // when the master says "marketing"; "Salesforce" is not, from anything.
  const stem = (t: string) => (/^[a-z]{7,}$/.test(t) ? t.slice(0, 6) : t);
  const fresh = [...factTokens(tailored)].filter((t) => !known.has(t) && !knownText.includes(stem(t)));
  if (fresh.length) problems.push(`facts not in the source documents: ${fresh.slice(0, 12).join(', ')}`);
  // Line by line: the master's own "accounts running ~$50K/month in spend" matches too.
  const masterLines = new Set(master.split('\n').map((l) => l.trim()));
  if (tailored.split('\n').some((l) => MANAGED_SPEND.test(l) && !masterLines.has(l.trim()))) {
    problems.push('claims to manage ad spend or budget (Tory makes creative and monitors spend)');
  }
  return problems;
}

export function tailorPrompt(posting: string, master: string): string {
  return `You are tailoring a one-page resume for one job application. It will be sent without a person reading it first, so the rules are absolute.

The file resume.md in the current directory is a copy of the candidate's master resume. Edit resume.md in place, tailoring it to the posting in posting.md (shown below).

Rules:
- Facts never change. Only emphasis, order and wording. Every line you write must be a rephrasing of something already in the master.
- Never add a number, metric, employer, client, product, tool, skill or technology the master does not already contain. An automated check rejects the resume if you do.
- Never claim the candidate manages or owns ad spend or budgets. They make creative and monitor accounts.
- Do not hedge real claims down either.
- Leave the YAML header between the --- lines exactly as it is.
- Keep it to roughly the same length so it stays one page.
- Lead with what this posting asks for: reorder bullets, sharpen the summary, put the most relevant skills first.

When done, reply with one line: DONE.

## posting.md
${posting}

## The master (what resume.md started as)
${master}`;
}

export type ApplyResult = {
  status: 'submitted' | 'skipped' | 'failed';
  reason: string;
  finalUrl: string;
  confirmation: string;
  answers: { field: string; value: string; source: 'profile' | 'drafted' | 'posting' }[];
  blank: { field: string; why: string }[];
};

export function applyPrompt(o: {
  company: string; title: string; url: string; pdf: string; profile: string; posting: string; shotsDir: string; dryRun: boolean;
}): string {
  return `You are submitting one job application on the candidate's behalf, unattended. The candidate (Tory Radtke) has authorized automatic submission within the rules below. Nobody is watching; when a rule says stop, stop and report.

Role: ${o.company} — ${o.title}
Application page: ${o.url}
Resume PDF to upload (the only file you may attach): ${o.pdf}

## Hard stops — report status "skipped" and do not submit if any is true
- The page is not on job-boards.greenhouse.io, boards.greenhouse.io, jobs.lever.co or jobs.ashbyhq.com (check after every navigation), or the posting is closed, or it is a different role.
- The form asks you to create an account, sign in, or enter a password.
- A CAPTCHA or bot check appears that is not passed automatically.
- It asks for SSN, government ID, date of birth, bank or card details.
- A question or the posting requires on-site or hybrid work, relocation, living in a specific metro, or a state list without Minnesota. Do not answer around it.
- A required question would need a false answer from the candidate's facts (e.g. a required license, clearance, or years of experience they do not have).

## Filling
- Answers come from the answer bank below. State desired salary as the answer bank gives it.
- A required question the answer bank does not cover: draft a short, truthful answer from the candidate's background in posting.md and the answer bank. Never invent experience, employers, numbers or credentials. Mark it "drafted".
- Optional free-text questions (cover letter, "anything else"): leave blank unless required.
- EEO, demographic and voluntary self-identification questions (gender, race, ethnicity, veteran, disability, pronouns, sexual orientation): ALWAYS leave blank or choose "decline to answer" if a choice is forced.
- LinkedIn: leave blank. Website/portfolio: https://toryradtke.com. GitHub: https://github.com/toryradtke-star.
- Upload ${o.pdf} with browser_file_upload as the resume. Never any other file.
- Fill with browser_fill_form / browser_type WITHOUT submit:true. Never press Enter in a field.
- Before submitting, take a full-page screenshot to ${o.shotsDir}/filled.png and re-read the form with browser_snapshot to confirm every required field is set and the resume filename is attached.
${o.dryRun
    ? '- DRY RUN: do NOT click submit. Stop after the screenshot and report status "skipped" with reason "dry run — ready to submit".'
    : '- Then click the form\'s Submit / Submit application button once. Wait for the confirmation, take a screenshot to ' + o.shotsDir + '/confirmation.png, and copy the confirmation text.'}
- If the submit shows validation errors, fix them and submit again, at most twice. Never submit a form you have not checked.

## Your answer
Reply with ONE JSON object and nothing else:
{"status":"submitted|skipped|failed","reason":"why, one sentence","finalUrl":"the page URL at the end","confirmation":"the confirmation text, empty if none","answers":[{"field":"label","value":"what you entered","source":"profile|drafted|posting"}],"blank":[{"field":"label","why":"reason"}]}

"value" is exactly what you entered, in full — a whole cover letter or drafted answer word for word, never a summary of it.
"submitted" only if the site confirmed receipt.

## Answer bank (profile.md)
${o.profile}

## posting.md
${o.posting}`;
}

export function parseApplyResult(stdout: string): ApplyResult | null {
  const j = extractJson(stdout);
  if (!j || !['submitted', 'skipped', 'failed'].includes(j.status)) return null;
  return {
    status: j.status, reason: String(j.reason ?? ''), finalUrl: String(j.finalUrl ?? ''),
    confirmation: String(j.confirmation ?? ''),
    answers: Array.isArray(j.answers) ? j.answers.map((a: any) => ({ field: String(a.field), value: String(a.value), source: a.source })) : [],
    blank: Array.isArray(j.blank) ? j.blank.map((b: any) => ({ field: String(b.field), why: String(b.why) })) : [],
  };
}

/** A submission only counts if it ended on a lane host and the site confirmed it. */
export function confirmedSubmission(r: ApplyResult): boolean {
  let host = '';
  try { host = new URL(r.finalUrl).hostname; } catch { /* not a URL */ }
  return r.status === 'submitted' && LANE_HOSTS.test(host) && r.confirmation.trim().length > 0;
}

/** One headless Claude turn. Rejects on timeout or a non-zero exit. */
export async function claude(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  const { stdout } = await run('claude', args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
