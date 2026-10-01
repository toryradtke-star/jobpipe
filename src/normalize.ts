/**
 * Turning what a board hands back into the one Posting shape.
 *
 * Two jobs live here: getting readable text out of the HTML every ATS stores
 * descriptions as, and getting a salary range out of that text when the board
 * did not give us one as a number.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
};

/** HTML to plain text: entities decoded, tags dropped, blank lines collapsed. */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    // Block-level tags become line breaks so lists and paragraphs survive.
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

/**
 * A number written the way pay is written: 135000, 135,000, 135k, 135K.
 * Returns null for anything that is not one of those.
 */
function readAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  const k = /^(\d+(?:\.\d+)?)k$/i.exec(cleaned);
  if (k) return Math.round(Number(k[1]) * 1000);
  const plain = /^(\d+(?:\.\d+)?)$/.exec(cleaned);
  if (!plain) return null;
  return Math.round(Number(plain[1]));
}

/** Hourly and monthly pay, annualized. 2,080 hours is the US full-time year. */
function annualize(n: number, unit: 'year' | 'hour' | 'month'): number {
  if (unit === 'hour') return Math.round(n * 2080);
  if (unit === 'month') return Math.round(n * 12);
  return n;
}

/**
 * The pay range a posting states, in annual USD.
 *
 * Only ranges written with a dollar sign are read, because a bare pair of
 * numbers in a job description is far more often a date, a headcount or a
 * funding round than it is pay. A single figure with no range becomes both
 * ends. Figures that annualize to less than $15,000 or more than $1,000,000
 * are dropped as misreads — that catches "$401k", equity figures and the
 * "$50M Series B" sentence every startup posting carries.
 */
export function parseSalary(text: string): { min: number; max: number } | null {
  if (!text) return null;
  const unitOf = (tail: string): 'year' | 'hour' | 'month' => {
    if (/\b(per hour|an hour|\/\s*hour|\/\s*hr|hourly)\b/i.test(tail)) return 'hour';
    if (/\b(per month|a month|\/\s*month|monthly)\b/i.test(tail)) return 'month';
    return 'year';
  };

  // A range: $135,000 - $180,000 / $135k to $180k / $135,000—$180,000 USD
  const range = /\$\s*([\d,]+(?:\.\d+)?k?)\s*(?:-|–|—|to|and)\s*\$?\s*([\d,]+(?:\.\d+)?k?)/gi;
  for (const m of text.matchAll(range)) {
    const lo = readAmount(m[1]);
    const hi = readAmount(m[2]);
    if (lo === null || hi === null) continue;
    const unit = unitOf(text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 40));
    const min = annualize(Math.min(lo, hi), unit);
    const max = annualize(Math.max(lo, hi), unit);
    if (min < 15_000 || max > 1_000_000) continue;
    return { min, max };
  }

  // A single figure: "$120,000 annually", "$85/hour"
  const single = /\$\s*([\d,]+(?:\.\d+)?k?)/gi;
  for (const m of text.matchAll(single)) {
    const n = readAmount(m[1]);
    if (n === null) continue;
    const tail = text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 40);
    // Require a pay word nearby, or a bare figure is just a number in prose.
    if (!/\b(salary|base|compensation|pay|rate|per hour|an hour|hourly|annually|per year|a year|\/\s*(hr|hour|year|yr))\b/i.test(tail)) continue;
    const v = annualize(n, unitOf(tail));
    if (v < 15_000 || v > 1_000_000) continue;
    return { min: v, max: v };
  }
  return null;
}

/** ISO 8601 with no fractional seconds, or null when the input is unusable. */
export function isoOrNull(v: unknown): string | null {
  if (typeof v === 'number') {
    const d = new Date(v > 1e12 ? v : v * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
