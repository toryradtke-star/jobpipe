/**
 * The one posting shape everything downstream reads.
 *
 * Every source normalizes into this. Fields the source did not give us are
 * null rather than guessed — a null salary means "the posting did not say",
 * which is a different thing from "the posting said zero", and the screen
 * treats the two differently.
 */
export type Posting = {
  /** `${ats}:${slug}:${externalId}` — stable across polls, the primary key. */
  id: string;
  ats: Ats;
  /** The board slug we polled, e.g. "vercel". */
  slug: string;
  /** The employer's display name, from the registry rather than the feed. */
  company: string;
  externalId: string;
  title: string;
  /** Plain text. HTML entities decoded, tags stripped. */
  description: string;
  /** The location string as the employer wrote it, joined if several. */
  location: string | null;
  department: string | null;
  employmentType: string | null;
  /** ISO 8601, from the board. Null when the board does not publish one. */
  postedAt: string | null;
  url: string;
  /** Annualized USD, parsed from structured fields or the description text. */
  salaryMin: number | null;
  salaryMax: number | null;
  /** Where the salary came from, so a bad parse can be traced. */
  salarySource: 'structured' | 'description' | null;
  /** ISO 8601, the first poll that saw this posting. */
  firstSeen: string;
  lastSeen: string;
};

export type Ats = 'greenhouse' | 'ashby' | 'lever';

/** One employer's board, as the registry lists it. */
export type Company = {
  name: string;
  ats: Ats;
  slug: string;
  /** Free-form labels for filtering polls, e.g. ["saas", "devtools"]. */
  tags?: string[];
};

/** The outcome of the deterministic screen. */
export type Screen = {
  postingId: string;
  /** `out` means a hard rule fired; `pass` means nothing fired. */
  verdict: 'pass' | 'out';
  /** Which rules fired, by name. Empty on a pass. */
  reasons: string[];
  screenedAt: string;
};

/** The outcome of an LLM judgment over a posting that passed the screen. */
export type Judgment = {
  postingId: string;
  rating: 'STRONG' | 'FAIR' | 'WEAK' | 'NO';
  /** One or two sentences, the model's own words. */
  reasoning: string;
  /** What the model thinks would block an application, if anything. */
  blockers: string[];
  judgedAt: string;
  model: string;
};
