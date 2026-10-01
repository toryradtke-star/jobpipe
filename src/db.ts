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
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
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
        first_seen, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
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
          p.salaryMin, p.salaryMax, p.salarySource, p.firstSeen, p.lastSeen);
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
      INSERT INTO screens (posting_id, verdict, reasons, screened_at) VALUES (?,?,?,?)
      ON CONFLICT(posting_id) DO UPDATE SET
        verdict = excluded.verdict, reasons = excluded.reasons, screened_at = excluded.screened_at
    `).run(s.postingId, s.verdict, JSON.stringify(s.reasons), s.screenedAt);
  }

  putJudgment(j: Judgment): void {
    this.db.prepare(`
      INSERT INTO judgments (posting_id, rating, reasoning, blockers, judged_at, model)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(posting_id) DO UPDATE SET
        rating = excluded.rating, reasoning = excluded.reasoning,
        blockers = excluded.blockers, judged_at = excluded.judged_at, model = excluded.model
    `).run(j.postingId, j.rating, j.reasoning, JSON.stringify(j.blockers), j.judgedAt, j.model);
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
