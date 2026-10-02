/**
 * Judging what survived the screen, using the Claude Code CLI already on this
 * machine rather than a metered API key.
 *
 * `claude -p` runs one headless turn and prints the answer. That means the
 * judging budget is the subscription that is already being paid for, which is
 * the whole reason this is worth building: the tool it replaces allows 75 full
 * judgments a month.
 *
 * The model is given what a person would need — the rules, the background,
 * the posting, and what the pipeline knows about the posting's history — and
 * asked for one JSON object. Anything it
 * says that is not parseable JSON is recorded as a failure rather than guessed
 * at, because a judgment nobody can read is worse than no judgment.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Judgment, Posting } from './types.ts';

const run = promisify(execFile);

/** How much of a description the model is shown. Whole postings are long. */
const DESCRIPTION_CHARS = 16_000;

/**
 * What jobpipe already knows about a posting that the posting itself does not
 * say: how old it is, whether it is still up, whether it keeps being reposted.
 * Ghost-job signals the model cannot see from the text alone.
 */
export type Context = {
  /** Days since the board says it was posted; null when the board does not say. */
  ageDays: number | null;
  /** Days since jobpipe first saw it. */
  trackedDays: number;
  /** Seen in the latest poll of its board. */
  live: boolean;
  /** Earlier postings at this employer with the same normalized title. */
  reposts: number;
  /** The screen's unresolved doubts, e.g. "us-not-stated". */
  flags: string[];
  /** "employer board" or the aggregator's name. */
  source: string;
};

export type Profile = {
  /** The hard rule-outs, verbatim. */
  constraints: string;
  /** Who the candidate is: skills, history, what they actually ship. */
  background: string;
};

function prompt(p: Posting, profile: Profile, ctx: Context): string {
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

## What the pipeline knows that the posting does not say
- Source: ${ctx.source}
- Age: ${ctx.ageDays === null ? 'the board gives no posting date' : `${ctx.ageDays} days since posted`}; tracked for ${ctx.trackedDays} days
- Still listed in the latest poll: ${ctx.live ? 'yes' : 'NO — it may have closed'}
- Earlier postings at this employer with the same title: ${ctx.reposts}
- Screen flags to settle: ${ctx.flags.length ? ctx.flags.join(', ') : 'none'}${ctx.flags.includes('us-not-stated') ? ' (the posting is remote but never names a country — decide from the text whether US candidates are eligible)' : ''}

## How to judge
1. Remote truth. Job boards label roles "remote" that are not. Read the whole description for on-site days, relocation, a required metro, a state list, or timezone limits. A candidate fails a state list that leaves out the state they live in (from the background). Quote the words that decide it.
2. Ghost risk. A posting that is very old, no longer listed, reposted again and again, or written so generically that no team could be behind it is likely not being hired for.
3. Title leverage. The same skills are often paid very differently depending on the title. Score how far this title moves the candidate toward the best-paid titles their background fits; the background may name them.
4. Tier. Put the posting in one bucket by how likely this candidate gets an interview and what it pays (use the stated pay; when none is stated, estimate base pay from the title, level and company):
   - "75k": the candidate meets the stated requirements now; base pay around $75–95k.
   - "100k": the candidate meets most requirements (at most one real gap); base pay around $95–125k.
   - "stretch": asks well past the candidate (years well beyond theirs, or a core tool they have never used), or pays above $125k with any level gap.
   Use the requirements as written: "5+ years" against ~3 is a stretch whatever the pay.

## Your answer
Reply with ONE JSON object and nothing else. No markdown fence, no commentary.

{"rating":"STRONG|FAIR|WEAK|NO","score":1,"subscores":{"role_fit":1,"level":1,"pay":1,"remote":1,"title_leverage":1},"remote_truth":"us-remote|state-restricted|hybrid-or-onsite|non-us|unclear","remote_evidence":"the deciding words, quoted","ghost_risk":"low|medium|high","ghost_signals":["short phrases, [] if none"],"reasoning":"one or two sentences quoting the posting where it matters","blockers":["short phrases naming anything that would block an application, [] if none"],"tier":"75k|100k|stretch","est_pay":95000}

Scores are 1–5, 5 best. "pay" is 3 when pay is not stated. "score" is your overall call, not an average.

Rating means:
- STRONG (score 4–5): clears every hard rule-out and the work is what this candidate actually does.
- FAIR (score 3–4): clears every hard rule-out, with a real gap worth naming.
- WEAK (score 2): clears the hard rule-outs on a technicality, or the fit is thin.
- NO (score 1): at least one hard rule-out fires, remote_truth is anything but us-remote or a state list including MN, or ghost_risk is high. Name it in blockers.`;
}

/** Pulls the first balanced JSON object out of a model's reply. */
export function extractJson(text: string): Record<string, any> | null {
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

const REMOTE_TRUTH = new Set(['us-remote', 'state-restricted', 'hybrid-or-onsite', 'non-us', 'unclear']);
const GHOST = new Set(['low', 'medium', 'high']);
const TIERS = new Set(['75k', '100k', 'stretch']);
const clamp = (v: unknown) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null; };

export async function judgePosting(
  p: Posting,
  profile: Profile,
  ctx: Context,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<Judgment | { error: string; postingId: string }> {
  const model = opts.model ?? 'default';
  const args = ['-p', prompt(p, profile, ctx)];
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
      score: clamp(parsed.score),
      subscores: Object.fromEntries(Object.entries(parsed.subscores ?? {})
        .map(([k, v]) => [k, clamp(v)]).filter(([, v]) => v !== null)) as Record<string, number>,
      remoteTruth: REMOTE_TRUTH.has(parsed.remote_truth) ? parsed.remote_truth : 'unclear',
      remoteEvidence: String(parsed.remote_evidence ?? '').trim(),
      ghostRisk: GHOST.has(parsed.ghost_risk) ? parsed.ghost_risk : null,
      ghostSignals: Array.isArray(parsed.ghost_signals) ? parsed.ghost_signals.map(String) : [],
      tier: TIERS.has(parsed.tier) ? parsed.tier : null,
      estPay: Number.isFinite(Number(parsed.est_pay)) && Number(parsed.est_pay) > 1000 ? Math.round(Number(parsed.est_pay)) : null,
      judgedAt: new Date().toISOString(),
      model,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), postingId: p.id };
  }
}
