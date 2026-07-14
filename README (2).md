# ConnexionTwo GovCon — portal scrapers (OhioBuys, Maryland eMMA)

OhioBuys (Jaggaer) and Maryland eMMA (SAP Ariba) have **no public API**, so
opportunities are pulled with headless-browser scraping (Playwright) and pushed
into Supabase, where the same bid-window + scoring rules as SAM.gov apply.

```
hourly cron ─▶ run.py ──schedule-check──▶ scrape-ingest edge fn
                 │  (due? which portals? keywords?)
                 ├─ ohiobuys.py ─┐
                 └─ emma.py ─────┴─▶ ingest ─▶ govcon_rfps ─▶ RFP Discovery / Pipeline
```

## One-time setup in the app
1. Run `govcon_migration_3.sql` in the Supabase SQL editor.
2. Deploy the `scrape-ingest` edge function.
3. In the app: **Profile & Settings → Scraping** — enable OhioBuys / eMMA,
   set the weekly schedule (e.g. Friday 17:00 America/New_York), and copy your
   **ingest token**.

## Run it — two options

### A) GitHub Actions (no server, free)
`.github/workflows/scrape.yml` runs `run.py` hourly. Add two repo secrets
(Settings → Secrets and variables → Actions):
- `SUPABASE_URL` — `https://<project>.supabase.co`
- `C2_INGEST_TOKEN` — the token from the app

Every hour the job asks the server if the schedule is due; if not, it exits in
a second. It only scrapes at your chosen day/time.

### B) Your own machine / VPS (cron)
```bash
cd scrapers
pip install -r requirements.txt
python -m playwright install --with-deps chromium
export SUPABASE_URL=https://<project>.supabase.co
export C2_INGEST_TOKEN=<token from the app>
python run.py            # respects the schedule
python run.py --force    # run right now, ignore schedule
```
Add to crontab to check hourly: `0 * * * * cd /path/scrapers && python run.py`

## Tuning selectors (important)
These portals are JavaScript apps whose markup shifts, and they can't be
inspected from CI. If a run reports `0 items`, the CSS selectors need updating:

```bash
python ohiobuys.py --debug     # opens a visible browser, saves debug/ohiobuys.png + .html
python emma.py --debug
```
Open the screenshot/HTML, find the real row/title/date selectors in DevTools
(right-click → Inspect → Copy → Copy selector), and edit the `SELECTORS` dict at
the top of `ohiobuys.py` / `emma.py`. Everything else stays the same.

## Fields extracted
title · agency · due date · notice/solicitation number · URL (naics/description
where available). The server drops anything with no due date or outside your
bid window, scores the rest, and dedupes by notice id.
