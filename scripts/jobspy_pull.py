# /// script
# requires-python = ">=3.10"
# dependencies = ["python-jobspy>=1.1"]
# ///
"""
Pulls Indeed / Google Jobs / LinkedIn search results through JobSpy and prints
them as one JSON array on stdout, for src/sources/jobspy.ts to normalize.

    uv run scripts/jobspy_pull.py --sites indeed,google --term "GTM engineer" \
        --term "growth engineer" --results 25 --hours 168

Each term is one search per site, with a pause between searches. These sites
do not publish an API for this and rate-limit scrapers hard; a handful of
searches a day is the use this is built for. Progress goes to stderr so stdout
stays parseable.
"""
import argparse
import json
import math
import random
import sys
import time

from jobspy import scrape_jobs


def clean(v):
    """NaN, NaT and pandas scalars → plain JSON values."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            return None
    if hasattr(v, "item"):
        return v.item()
    s = str(v)
    return None if s in ("nan", "NaT", "None", "") else v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sites", default="indeed,google")
    ap.add_argument("--term", action="append", required=True)
    ap.add_argument("--results", type=int, default=25)
    ap.add_argument("--hours", type=int, default=0, help="0 = no age filter; Indeed ignores is_remote when this is set")
    ap.add_argument("--pause", type=float, default=6.0)
    args = ap.parse_args()

    sites = [s.strip() for s in args.sites.split(",") if s.strip()]
    out = []
    for i, term in enumerate(args.term):
        if i:
            time.sleep(args.pause + random.random() * 3)
        try:
            df = scrape_jobs(
                site_name=sites,
                search_term=term,
                google_search_term=f"{term} remote jobs in United States since last week",
                location="United States",
                is_remote=True,
                results_wanted=args.results,
                hours_old=args.hours or None,
                country_indeed="USA",
                description_format="markdown",
                linkedin_fetch_description="linkedin" in sites,
                verbose=0,
            )
        except Exception as e:  # one failed search should not lose the others
            print(f"jobspy: {term!r} failed: {e}", file=sys.stderr)
            continue
        rows = [{k: clean(v) for k, v in r.items()} for r in df.to_dict("records")]
        print(f"jobspy: {term!r} → {len(rows)}", file=sys.stderr)
        for r in rows:
            r["search_term"] = term
        out.extend(rows)
    json.dump(out, sys.stdout, default=str)


if __name__ == "__main__":
    main()
