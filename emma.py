"""Maryland eMMA (emaryland.buyspeed.com / procurement.maryland.gov) scraper.

eMMA publishes open solicitations that are browsable without a login. This
scraper opens the public solicitation search, optionally applies a keyword,
and extracts the result rows.

⚠️ Selectors below are a starting point — verify against the live site with
   `python emma.py --debug` and adjust SELECTORS as needed.
"""
from __future__ import annotations
import sys
from base import browser_page, dump_debug, first_text, first_href, parse_date

# Public "Browse Open Solicitations" page. {query} replaced with keyword.
SEARCH_URL = "https://emaryland.buyspeed.com/bso/external/publicBids.sdo"

SELECTORS = {
    "row":      "table tbody tr, .bidRow, .result-row, [role='row']",
    "title":    "a, .description, td:nth-child(3)",
    "agency":   ".department, .organization, td:nth-child(4)",
    "deadline": ".dueDate, .closeDate, td:nth-child(6)",
    "notice":   ".bidNumber, .solicitationNumber, td:nth-child(1)",
    "link":     "a",
}
BASE = "https://emaryland.buyspeed.com"


def scrape(keywords: list[str], max_items: int = 50, headless: bool = True,
           debug: bool = False, search_url: str | None = None) -> list[dict]:
    url = search_url or SEARCH_URL
    out: list[dict] = []
    with browser_page(headless=headless) as page:
        print(f"[emma] opening {url}")
        page.goto(url, wait_until="networkidle")
        page.wait_for_timeout(2500)

        kw = " ".join(keywords[:3]) if keywords else ""
        if kw:
            for sel in ["input[type='search']", "input[name*='keyword' i]", "input[id*='search' i]", "input[type='text']"]:
                box = page.query_selector(sel)
                if box:
                    try:
                        box.fill(kw)
                        box.press("Enter")
                        page.wait_for_timeout(3000)
                        break
                    except Exception:
                        continue

        if debug:
            dump_debug(page, "emma")

        rows = page.query_selector_all(SELECTORS["row"])
        print(f"[emma] {len(rows)} candidate rows")
        for row in rows[:max_items]:
            title = first_text(row, SELECTORS["title"].split(", "))
            if not title or len(title) < 4:
                continue
            out.append({
                "title": title,
                "agency": first_text(row, SELECTORS["agency"].split(", ")) or "State of Maryland",
                "deadline": parse_date(first_text(row, SELECTORS["deadline"].split(", "))),
                "notice_id": first_text(row, SELECTORS["notice"].split(", ")) or None,
                "url": first_href(row, BASE, SELECTORS["link"].split(", ")),
                "description": None,
                "naics": None,
            })
    print(f"[emma] extracted {len(out)} opportunities")
    return out


if __name__ == "__main__":
    dbg = "--debug" in sys.argv
    items = scrape(["janitorial", "custodial", "cleaning"], debug=dbg, headless=not dbg)
    for it in items[:10]:
        print(it)
