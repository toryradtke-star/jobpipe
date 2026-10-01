/**
 * The store: one SQLite file, opened with the runtime's own driver.
 *
 * node:sqlite ships with Node, so this whole tool has no dependencies to
 * install and nothing to compile. The schema is small on purpose — postings,
 * the screen's verdicts, the judge's verdicts, and a log of polls — because
 * everything interesting is a query over those four rather than another table.
 *
 * Postings are never deleted. A posting that disappears from a board stops
 * having its `last_seen` moved forward, which is how a closed role is told
 * apart from a live one without throwing away what we learned about it.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Judgment, Posting, Screen } from './types.ts';
import { fingerprint, type Candidate } from './dedupe.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  ats TEXT NOT NULL,
  slug TEXT NOT NULL,
  company TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT,
  department TEXT,
  employment_type TEXT,
  posted_at TEXT,
  url TEXT NOT NULL,
  salary_min INTEGER,
  salary_max INTEGER,
  salary_source TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_first_seen ON postings(first_seen);
CREATE INDEX IF NOT EXISTS postings_posted_at ON postings(posted_at);
CREATE INDEX IF NOT EXISTS postings_company ON postings(company);

CREATE TABLE IF NOT EXISTS screens (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  verdict TEXT NOT NULL,
  reasons TEXT NOT NULL,
  screened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS screens_verdict ON screens(verdict);

CREATE TABLE IF NOT EXISTS judgments (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  rating TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  blockers TEXT NOT NULL,
  judged_at TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS judgments_rating ON judgments(rating);

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  boards_ok INTEGER NOT NULL DEFAULT 0,
  boards_failed INTEGER NOT NULL DEFAULT 0,
  postings_seen INTEGER NOT NULL DEFAULT 0,
  postings_new INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);

-- What Tory actually sent, or tried to. posting_id is null for applications
-- that came from somewhere jobpipe never polled (Wellfound, Hirebridge, a
-- referral). Status is free text on purpose: "blocked-not-applied" says more
-- than any enum would.
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id TEXT REFERENCES postings(id),
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  track TEXT,
  posted_range TEXT,
  source TEXT,
  url TEXT,
  applied_date TEXT,
  status TEXT NOT NULL,
  follow_up_date TEXT,
  resume_path TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS applications_posting ON applications(posting_id);

-- Every automatic application attempt, whatever came of it. A posting with a
-- row here is never attempted again automatically: an attempt that timed out
-- may still have submitted, and applying twice is worse than not at all.
CREATE TABLE IF NOT EXISTS auto_attempts (
  posting_id TEXT PRIMARY KEY REFERENCES postings(id),
  attempted_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL,
  employer_posting_id TEXT,
  folder TEXT
);

-- Small facts the CLI remembers between runs, e.g. when the last report ran.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS applications_company_role ON applications(company, role);
`;

/** The tracker's columns, in the order ~/job-search/applications.csv uses. */
export const APPLICATION_COLUMNS = ['company', 'role', 'track', 'posted_range', 'source', 'url',
  'applied_date', 'status', 'follow_up_date', 'notes'] as const;

export type Application = {
  postingId: string | null;
  company: string;
  role: string;
  track: string | null;
  postedRange: string | null;
  source: string | null;
  url: string | null;
  appliedDate: string | null;
  status: string;
  followUpDate: string | null;
  resumePath: string | null;
  notes: string | null;
};

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after a store was first created, backfilled once. */
  private migrate(): void {
    const cols = new Set((this.db.prepare('PRAGMA table_info(postings)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('fingerprint')) {
      this.db.exec('ALTER TABLE postings ADD COLUMN fingerprint TEXT');
      const set = this.db.prepare('UPDATE postings SET fingerprint = ? WHERE id = ?');
      this.db.exec('BEGIN');
      for (const r of this.db.prepare('SELECT id, company, title FROM postings').all() as Record<string, string>[]) {
        set.run(fingerprint(r.company, r.title), r.id);
      }
      this.db.exec('COMMIT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS postings_fingerprint ON postings(fingerprint)');
    const screenCols = new Set((this.db.prepare('PRAGMA table_info(screens)').all() as { name: string }[]).map((c) => c.name));
    if (!screenCols.has('flags')) this.db.exec(`ALTER TABLE screens ADD COLUMN flags TEXT NOT NULL DEFAULT '[]'`);
    const judgeCols = new Set((this.db.prepare('PRAGMA table_info(judgments)').all() as { name: string }[]).map((c) => c.name));
    for (const [col, def] of [['score', 'INTEGER'], ['subscores', "TEXT NOT NULL DEFAULT '{}'"],
      ['remote_truth', 'TEXT'], ['remote_evidence', 'TEXT'], ['ghost_risk', 'TEXT'],
      ['ghost_signals', "TEXT NOT NULL DEFAULT '[]'"]] as const) {
      if (!judgeCols.has(col)) this.db.exec(`ALTER TABLE judgments ADD COLUMN ${col} ${def}`);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS judgments_score ON judgments(score)');
  }

  /**
   * Writes postings, keeping the earliest `first_seen` we ever recorded.
   * Returns how many of them this store had never held before, which is the
   * number worth printing after a poll.
   */
  upsertPostings(postings: Posting[]): { seen: number; added: number } {
    const insert = this.db.prepare(`
      INSERT INTO postings (id, ats, slug, company, external_id, title, description, location,
        department, employment_type, posted_at, url, salary_min, salary_max, salary_source,
        first_seen, last_seen, fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        fingerprint = excluded.fingerprint,
        description = excluded.description,
        location = excluded.location,
        salary_min = excluded.salary_min,
        salary_max = excluded.salary_max,
        salary_source = excluded.salary_source,
        last_seen = excluded.last_seen
    `);
    const exists = this.db.prepare('SELECT 1 FROM postings WHERE id = ?');
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const p of postings) {
        if (!exists.get(p.id)) added++;
        insert.run(p.id, p.ats, p.slug, p.company, p.externalId, p.title, p.description,
          p.location, p.department, p.employmentType, p.postedAt, p.url,
          p.salaryMin, p.salaryMax, p.salarySource, p.firstSeen, p.lastSeen,
          fingerprint(p.company, p.title));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { seen: postings.length, added };
  }

  putScreen(s: Screen): void {
    this.db.prepare(`
      INSERT INTO screens (posting_id, verdict, reasons, flags, screened_at) VALUES (?,?,?,?,?)
      ON CONFLICT(posting_id) DO UPDATE SET
        verdict = excluded.verdict, reasons = excluded.reasons, flags = excluded.flags,
        screened_at = excluded.screened_at
    `).run(s.postingId, s.verdict, JSON.stringify(s.reasons), JSON.stringify(s.flags), s.screenedAt);
  }

  putJudgment(j: Judgment): void {
    this.db.prepare(`
      INSERT INTO judgments (posting_id, rating, reasoning, blockers, judged_at, model,
        score, subscores, remote_truth, remote_evidence, ghost_risk, ghost_signals)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(posting_id) DO UPDATE SET
        rating = excluded.rating, reasoning = excluded.reasoning,
        blockers = excluded.blockers, judged_at = excluded.judged_at, model = excluded.model,
        score = excluded.score, subscores = excluded.subscores, remote_truth = excluded.remote_truth,
        remote_evidence = excluded.remote_evidence, ghost_risk = excluded.ghost_risk,
        ghost_signals = excluded.ghost_signals
    `).run(j.postingId, j.rating, j.reasoning, JSON.stringify(j.blockers), j.judgedAt, j.model,
      j.score, JSON.stringify(j.subscores), j.remoteTruth, j.remoteEvidence, j.ghostRisk,
      JSON.stringify(j.ghostSignals));
  }

  /**
   * Records an application, keyed on company + role so re-recording one
   * updates it rather than duplicating it. Null fields leave what the row
   * already holds alone, so `applied` can add a confirmation URL without
   * wiping the notes an import brought in. The first applied_date sticks.
   */
  putApplication(a: Application): void {
    this.db.prepare(`
      INSERT INTO applications (posting_id, company, role, track, posted_range, source, url,
        applied_date, status, follow_up_date, resume_path, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(company, role) DO UPDATE SET
        posting_id = COALESCE(excluded.posting_id, posting_id),
        track = COALESCE(excluded.track, track),
        posted_range = COALESCE(excluded.posted_range, posted_range),
        source = COALESCE(excluded.source, source),
        url = COALESCE(excluded.url, url),
        applied_date = COALESCE(applied_date, excluded.applied_date),
        status = excluded.status,
        follow_up_date = COALESCE(excluded.follow_up_date, follow_up_date),
        resume_path = COALESCE(excluded.resume_path, resume_path),
        notes = COALESCE(excluded.notes, notes)
    `).run(a.postingId, a.company, a.role, a.track, a.postedRange, a.source, a.url,
      a.appliedDate, a.status, a.followUpDate, a.resumePath, a.notes);
  }

  /** Every application, in the order they were first recorded. */
  applications(): Record<string, any>[] {
    return this.query('SELECT * FROM applications ORDER BY id');
  }

  /** Copies of a job that passed every rule but dedupe. */
  passingCopies(fp: string): Candidate[] {
    return (this.db.prepare(`SELECT p.id, p.ats, p.first_seen, p.last_seen, j.posting_id IS NOT NULL AS judged
      FROM postings p JOIN screens s ON s.posting_id = p.id AND s.verdict = 'pass'
      LEFT JOIN judgments j ON j.posting_id = p.id
      WHERE p.fingerprint = ?`).all(fp) as Record<string, any>[])
      .map((r) => ({ id: r.id, ats: r.ats, firstSeen: r.first_seen, lastSeen: r.last_seen, judged: !!r.judged }));
  }

  markDuplicate(id: string): void {
    this.db.prepare(`UPDATE screens SET verdict = 'out', reasons = '["duplicate"]' WHERE posting_id = ?`).run(id);
  }

  /** The ghost-job facts the judge is handed alongside a posting. */
  context(p: Posting): Omit<import('./judge.ts').Context, 'source'> {
    const now = Date.now();
    const days = (iso: string) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));
    const latest = this.db.prepare('SELECT MAX(last_seen) t FROM postings WHERE ats = ? AND slug = ?').get(p.ats, p.slug) as { t: string };
    const fp = fingerprint(p.company, p.title);
    const reposts = (this.db.prepare(`SELECT COUNT(*) n FROM postings WHERE fingerprint = ? AND id != ? AND first_seen < ?`)
      .get(fp, p.id, p.firstSeen) as { n: number }).n;
    const screen = this.db.prepare('SELECT flags FROM screens WHERE posting_id = ?').get(p.id) as { flags?: string } | undefined;
    return {
      ageDays: p.postedAt ? days(p.postedAt) : null,
      trackedDays: days(p.firstSeen),
      // Live means it was in the most recent poll of its board, within a day.
      live: !latest?.t || Date.parse(latest.t) - Date.parse(p.lastSeen) < 86_400_000,
      reposts,
      flags: JSON.parse(screen?.flags ?? '[]'),
    };
  }

  getMeta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * Judged postings worth a look and not yet applied to, best first. "Applied"
   * matches by posting id, or by company + title for applications recorded
   * from somewhere jobpipe never polled. Closed postings, high ghost risk and
   * remote claims the judge did not believe are left out.
   */
  queue(limit: number): Record<string, any>[] {
    const applied = new Set((this.db.prepare('SELECT company, role FROM applications').all() as Record<string, string>[])
      .map((a) => fingerprint(a.company, a.role)));
    const rows = this.query(`
      SELECT p.*, j.rating, j.score, j.subscores, j.remote_truth, j.remote_evidence, j.ghost_risk, j.reasoning, j.blockers
      FROM postings p JOIN judgments j ON j.posting_id = p.id
      JOIN screens s ON s.posting_id = p.id AND s.verdict = 'pass'
      WHERE j.rating IN ('STRONG','FAIR')
        AND COALESCE(j.ghost_risk, 'low') != 'high'
        AND COALESCE(j.remote_truth, 'us-remote') IN ('us-remote','state-restricted')
        AND p.last_seen >= (SELECT datetime(MAX(last_seen), '-1 day') FROM postings q WHERE q.ats = p.ats AND q.slug = p.slug)
        AND p.id NOT IN (SELECT posting_id FROM applications WHERE posting_id IS NOT NULL)
      ORDER BY COALESCE(j.score, CASE j.rating WHEN 'STRONG' THEN 4 ELSE 3 END) DESC,
               CASE j.rating WHEN 'STRONG' THEN 0 ELSE 1 END,
               COALESCE(p.posted_at, p.first_seen) DESC`);
    return rows.filter((r) => !applied.has(r.fingerprint)).slice(0, limit);
  }

  /** Postings with no screen verdict yet. */
  unscreened(): Posting[] {
    return this.rows(`SELECT p.* FROM postings p
      LEFT JOIN screens s ON s.posting_id = p.id WHERE s.posting_id IS NULL`);
  }

  /** Postings that passed the screen and have not been judged. */
  unjudged(limit: number): Posting[] {
    return this.rows(`SELECT p.* FROM postings p
      JOIN screens s ON s.posting_id = p.id AND s.verdict = 'pass'
      LEFT JOIN judgments j ON j.posting_id = p.id
      WHERE j.posting_id IS NULL
      ORDER BY COALESCE(p.posted_at, p.first_seen) DESC
      LIMIT ?`, limit);
  }

  private rows(sql: string, ...params: unknown[]): Posting[] {
    const stmt = this.db.prepare(sql);
    return (stmt.all(...(params as any[])) as Record<string, any>[]).map(fromRow);
  }

  query(sql: string, ...params: unknown[]): Record<string, any>[] {
    return this.db.prepare(sql).all(...(params as any[])) as Record<string, any>[];
  }

  close(): void { this.db.close(); }
}

function fromRow(r: Record<string, any>): Posting {
  return {
    id: r.id, ats: r.ats, slug: r.slug, company: r.company, externalId: r.external_id,
    title: r.title, description: r.description, location: r.location,
    department: r.department, employmentType: r.employment_type, postedAt: r.posted_at,
    url: r.url, salaryMin: r.salary_min, salaryMax: r.salary_max,
    salarySource: r.salary_source, firstSeen: r.first_seen, lastSeen: r.last_seen,
  };
}
