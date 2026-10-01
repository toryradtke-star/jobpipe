# jobfeed

A personal job-posting collector. It polls company job boards directly, screens
them against rules you write down, judges what survives with Claude, and hands
you a short list.

It exists because the metered alternative gives five postings a day. This
collects about seven thousand in six seconds, from boards that publish them
deliberately and without authentication.

## How it works

Four steps, each one cheap enough to run as often as you like.

```
poll  →  screen  →  judge  →  report
7000     6700 out   ~200 read   a page you can act on
```

**poll** fetches every board in `companies.json`. Greenhouse, Ashby and Lever
all publish an unauthenticated JSON endpoint carrying the full description of
every open role, because employers want those postings read. One request per
company, four at a time.

**screen** applies the deterministic rule-outs in `src/screen.ts` — the ones
that need no judgment: a level word in the title, a stated range under your
floor, the word "clearance", an office-days requirement. It costs nothing and
removes roughly 97% of what came in.

**judge** sends what is left to Claude through the `claude` CLI already on your
machine, with your rules and your background attached, and stores a rating and
its reasoning. Because it runs on the subscription rather than an API key, the
judging budget is effectively your afternoon rather than a quota.

**report** writes the survivors to markdown, best first.

Nothing is ever deleted. A posting that vanishes from a board simply stops
having its `last_seen` moved forward, which is how a closed role is told apart
from a live one.

## The design decision that matters

The tool this replaces gates its matching engine behind its collection quota:
ranking by meaning, ranking against your own profile and setting a match
threshold all work only on postings you have already paid to collect, and
collection hands them over newest-first. You buy blind, then rank.

This inverts that. Collection is free, so everything is collected. All the
judgment sits downstream of a screen that costs nothing. The expensive step —
a model reading a whole description — only ever runs on the couple of hundred
postings that survived rules you wrote yourself.

## Setup

Node 22.18 or newer. No dependencies, no build step: Node runs the TypeScript
directly and `node:sqlite` ships with the runtime.

Put two files in `profile/` (gitignored, and it should stay that way):

- `constraints.md` — your hard rule-outs, one per line. What makes a posting
  an instant no.
- `background.md` — who you are, what you actually ship, and your honest gaps.
  The gaps matter more than the strengths; they are what stops the judge
  returning everything as a maybe.

```bash
node bin/jobfeed.ts poll      # fetch every board
node bin/jobfeed.ts screen    # apply the rule-outs
node bin/jobfeed.ts judge     # read the survivors, --limit 20 by default
node bin/jobfeed.ts report    # write out/YYYY-MM-DD.md
node bin/jobfeed.ts stats     # what the store holds
node bin/jobfeed.ts verify    # check every board still answers
```

Useful flags: `--tag martech` polls one slice of the registry, `--concurrency N`
on poll and judge, `--limit N` and `--model NAME` on judge, `--all` re-screens
everything after you change a rule, `--out PATH` on report.

Environment: `JOBFEED_DB`, `JOBFEED_PROFILE`, `JOBFEED_REGISTRY`.

## Growing the registry

`companies.json` holds 69 verified boards. Every entry was probed before it
went in; none of them are guesses. To add more, append `{name, ats, slug, tags}`
and run `verify` — a slug that does not answer is reported rather than silently
returning nothing. The slug is the last path segment of a company's public job
board URL:

```
job-boards.greenhouse.io/SLUG        → {"ats":"greenhouse","slug":"SLUG"}
jobs.ashbyhq.com/SLUG                → {"ats":"ashby","slug":"SLUG"}
jobs.lever.co/SLUG                   → {"ats":"lever","slug":"SLUG"}
```

The registry is the part worth your time. The code stopped being the hard
problem once the three adapters worked; which companies are in the file is what
decides whether the output is any good.

## Scope

Career sites only — an employer's own board. It does not touch LinkedIn or
Indeed, which forbid it in their terms and have litigated the point. That is a
real gap: a company not on Greenhouse, Ashby or Lever is invisible here, and
the fix is adding their ATS to `src/sources/`, not scraping an aggregator.
