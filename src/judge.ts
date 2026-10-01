/**
 * Judging what survived the screen, using the Claude Code CLI already on this
 * machine rather than a metered API key.
 *
 * `claude -p` runs one headless turn and prints the answer. That means the
 * judging budget is the subscription that is already being paid for, which is
 * the whole reason this is worth building: the tool it replaces allows 75 full
 * judgments a month.
 *
 * The model is given the same three things a person would need — the rules,
 * the background, and the posting — and asked for one JSON object. Anything it
 * says that is not parseable JSON is recorded as a failure rather than guessed
 * at, because a judgment nobody can read is worse than no judgment.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Judgment, Posting } from './types.ts';

const run = promisify(execFile);

/** How much of a description the model is shown. Whole postings are long. */
const DESCRIPTION_CHARS = 9_000;

export type Profile = {
  /** The hard rule-outs, verbatim. */
  constraints: string;
  /** Who the candidate is: skills, history, what they actually ship. */
  background: string;
};

function prompt(p: Posting, profile: Profile): string {
  return `You are screening one job posting for a specific candidate. Be strict and be honest; a false positive wastes their day.

## The candidate's hard rule-outs
${profile.constraints}

## The candidate's background
${profile.background}

## The posting
Company: ${p.company}
Title: ${p.title}
Location: ${p.location ?? 'not stated'}
Employment type: ${p.employmentType ?? 'not stated'}
Posted: ${p.postedAt ?? 'not stated'}
Stated pay: ${p.salaryMin ? `$${p.salaryMin.toLocaleString()}–$${p.salaryMax?.toLocaleString()}` : 'not stated'}
URL: ${p.url}

${p.description.slice(0, DESCRIPTION_CHARS)}

## Your answer
Reply with ONE JSON object and nothing else. No markdown fence, no commentary.

{"rating":"STRONG|FAIR|WEAK|NO","reasoning":"one or two sentences quoting the posting where it matters","blockers":["short phrases naming anything that would block an application, [] if none"]}

Rating means:
- STRONG: clears every hard rule-out and the work is what this candidate actually does.
- FAIR: clears every hard rule-out, with a real gap worth naming.
- WEAK: clears the hard rule-outs on a technicality, or the fit is thin.
- NO: at least one hard rule-out fires. Name it in blockers.`;
}

/** Pulls the first balanced JSON object out of a model's reply. */
function extractJson(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const RATINGS = new Set(['STRONG', 'FAIR', 'WEAK', 'NO']);

export async function judgePosting(
  p: Posting,
  profile: Profile,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<Judgment | { error: string; postingId: string }> {
  const model = opts.model ?? 'default';
  const args = ['-p', prompt(p, profile)];
  if (opts.model) args.push('--model', opts.model);
  try {
    const { stdout } = await run('claude', args, {
      timeout: opts.timeoutMs ?? 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = extractJson(stdout);
    if (!parsed) return { error: `unparseable reply: ${stdout.slice(0, 200)}`, postingId: p.id };
    const rating = String(parsed.rating ?? '').toUpperCase();
    if (!RATINGS.has(rating)) return { error: `bad rating: ${rating}`, postingId: p.id };
    return {
      postingId: p.id,
      rating: rating as Judgment['rating'],
      reasoning: String(parsed.reasoning ?? '').trim(),
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String) : [],
      judgedAt: new Date().toISOString(),
      model,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), postingId: p.id };
  }
}
