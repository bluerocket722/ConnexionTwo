#!/usr/bin/env python3
"""ConnexionTwo GovCon — scraper orchestrator.

Flow (matches the pipeline you described):

    Scheduler (hourly cron / GitHub Actions)
        -> run.py asks the server: "am I due to run now?"  (weekly schedule)
        -> if due, run each enabled portal's Playwright scraper
        -> POST results to the scrape-ingest edge function
        -> server filters to your bid window, scores, dedupes, stores
        -> they appear in RFP Discovery / Pipeline

Env required:
    SUPABASE_URL        https://<project>.supabase.co
    C2_INGEST_TOKEN     from the app: Settings -> Scraping (per-user token)

Usage:
    python run.py                 # normal: only scrapes if the schedule says it's due
    python run.py --force         # ignore the schedule, run now
    python run.py --portal ohiobuys   # run one portal only
    python run.py --debug         # visible browser + save screenshots to ./debug
"""
from __future__ import annotations
import sys
import c2_client
import ohiobuys
import emma

SCRAPERS = {"ohiobuys": ohiobuys.scrape, "emma": emma.scrape}


def main() -> int:
    force = "--force" in sys.argv
    debug = "--debug" in sys.argv
    only = None
    if "--portal" in sys.argv:
        i = sys.argv.index("--portal")
        if i + 1 < len(sys.argv):
            only = sys.argv[i + 1]

    check = c2_client.schedule_check()
    print(f"schedule-check: due={check.get('due')} portals={check.get('portals')} "
          f"now={check.get('now_local')}")

    if not check.get("due") and not force:
        print("Not scheduled to run right now. Exiting. (use --force to override)")
        return 0

    keywords = check.get("keywords") or []
    portals = [only] if only else (check.get("portals") or list(SCRAPERS))
    max_items = 50

    total_new = 0
    for portal in portals:
        fn = SCRAPERS.get(portal)
        if not fn:
            print(f"! no scraper for portal '{portal}', skipping")
            continue
        try:
            items = fn(keywords, max_items=max_items, headless=not debug, debug=debug)
        except Exception as e:
            print(f"! {portal} scrape failed: {e}")
            continue
        if not items:
            print(f"  {portal}: 0 items scraped")
            continue
        res = c2_client.ingest(portal, items)
        print(f"  {portal}: found {res.get('found')}, in-window {res.get('in_window')}, "
              f"new {res.get('new_rfps')}")
        total_new += int(res.get("new_rfps") or 0)

    print(f"Done. {total_new} new opportunities stored.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
