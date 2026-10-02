# jobpipe

My own job search, run as a pipeline: find postings, screen them, have Claude
judge what survives, tailor a resume, apply, and track what happened. One
SQLite file holds all of it. Node 22, no dependencies, no build step.

```
poll  →  screen  →  judge  →  queue  →  tailor → build  →  apply  →  track
8,600    8,000 out   ~600 read   top 5     fact-checked       headless    CSV
```

## The design decision that matters

Collection is free, so everything is collected. Judgment is expensive, so it
sits downstream of a screen that costs nothing.

The hosted tool this replaced did it the other way round: its matching engine
only ran on postings you had already spent your daily quota collecting, handed
over newest-first, so you bought blind and ranked afterwards. Here a poll pulls
thousands of postings in under a minute, deterministic rules cut ~93%, and a
model reads a whole description only for the few hundred that are left.

Every knob is upstream of the model, and every rule-out is measurable: a
rejection stores every rule that fired, so the cost of a rule is the number of
postings it kills *alone*. That is how the rules get tuned — never by feel.

## Stages

**poll** — `src/sources/`. Greenhouse, Ashby and Lever publish unauthenticated
JSON for every open role; one GET per board. Workday has no such feed, so its
adapter searches each site for target titles, drops what the screen would
reject, and only then fetches descriptions. Remote boards (Himalayas, Remotive,
RemoteOK, We Work Remotely) are many employers in one feed. Indeed comes through
[JobSpy](https://github.com/speedyapply/JobSpy), opt-in and low volume.
Postings are never deleted: a closed role just stops having `last_seen` moved,
which is how live and closed are told apart.

**screen** — `src/screen.ts`, `src/place.ts`. Named rules: level words, job
family, specialisms, a stated range under the floor, clearance, office days,
location. The bias is one-way — *when in doubt, pass* — because the judge is
cheap and a wrongly discarded posting is never seen again. Each past bug is a
pinned test (Roman numerals rescuing "Senior … II"; "London, UK" matching a
state code; benefits boilerplate saying "remote" over an office location).

**dedupe** — `src/dedupe.ts`. The same job on the employer's board, a feed and
Indeed three times over is one fingerprint (normalized company + title). Dedupe
runs *after* the other rules, among copies that passed — run first, a London
copy could beat the US-remote copy of the same job and the job was lost.

**judge** — `src/judge.ts`. `claude -p`, four at a time, one JSON object back:
a 1–5 score with subscores, a **remote-truth** verdict quoting the posting
(boards' "remote" labels have been wrong), and **ghost risk** from facts the
store supplies — age, still listed, reposts. Unparseable replies are recorded
as failures, never guessed at. A run that hits a usage limit resumes where it
stopped.

**tailor / build** — the resume is edited against the posting (emphasis and
wording only), rendered to PDF, and refused if it is not one page or is
identical to the master.

**autoapply** — `src/autoapply.ts`. Unattended, within a narrow lane:

- only postings scored 4+, believed remote, low ghost risk;
- only through the employer's own Greenhouse/Lever/Ashby copy, found by probing
  likely slugs and matching the title, and that copy must pass the screen too;
- the tailored resume must pass a **fact check**: no number or proper noun the
  source documents don't already contain, header unchanged, no "managed spend";
- a fresh headless, profile-less Chrome per attempt via Playwright MCP, with
  hard stops for accounts, passwords, CAPTCHAs, ID or financial fields, and
  on-site or relocation requirements; demographic questions always left blank;
- counted only when it ends on the board's own host with a confirmation, and
  **never retried** — an attempt that died may have submitted.

**track** — applications keyed on company + role, synced byte-for-byte with a
CSV tracker.

## Install

```bash
npm install -g jobpipe     # Node 22.18+
jobpipe init               # starter profile files in ~/.jobpipe/profile
```

Polling and screening need nothing else. Judging, tailoring and autoapply call
the `claude` CLI ([Claude Code](https://claude.com/claude-code)); Indeed needs
[uv](https://docs.astral.sh/uv/).

Your files live in `profile/`: `constraints.md` (hard rule-outs),
`background.md` (who you are, including honest gaps — those are what stop the
judge calling everything a maybe), `rules.json` (`payFloor`), `answers.md`
(what application forms ask), and `config.json` (where the tracker CSV,
resumes and application folders go). An npm install keeps all of it, and the
store, in `~/.jobpipe` (`JOBPIPE_HOME` moves it); a git checkout keeps it
beside the code, gitignored.

## Running it

```bash
jobpipe poll [--scrape] [--bulk]
jobpipe screen [--all]
jobpipe judge --limit 40
jobpipe report            # out/YYYY-MM-DD.md, with "new since last report"
jobpipe queue
jobpipe tailor <id> && jobpipe build <id>
jobpipe autoapply --dry-run
```

From a checkout, run `./bin/jobpipe.ts` directly — no build step; `npm test`
runs the tests and `npm run build` makes the npm package.
`scripts/scheduled-run.sh` is the daily run for a systemd user timer.

## Registry

`companies.json` holds 74 boards, each probed live before it went in; `verify`
re-checks them. The registry decides output quality more than the code does —
once the adapters worked, which companies are in the file became the whole
game. A bulk registry of thousands more is built locally by
`scripts/import-slugs.ts` from a CC BY-NC slug list and is never committed.

## Scope

LinkedIn is never polled or automated. Indeed is read through JobSpy at low
volume for personal use. Everything else is a public feed an employer or board
publishes to be read.
