"""Shared Playwright helpers for the portal scrapers.

IMPORTANT — selectors need tuning against the live sites.
OhioBuys (Jaggaer) and Maryland eMMA (SAP Ariba) are JavaScript portals whose
markup changes over time, and they cannot be inspected from a CI sandbox. Each
scraper keeps its CSS selectors in a SELECTORS dict at the top of the file so
you can adjust them in one place. Run any scraper with --debug to save a
screenshot + the rendered HTML to ./debug/ so you can copy the right selectors
from DevTools (right-click element -> Inspect -> Copy -> Copy selector).
"""
from __future__ import annotations
import os
import re
import datetime as dt
from contextlib import contextmanager
from playwright.sync_api import sync_playwright, Page

DEBUG_DIR = os.path.join(os.path.dirname(__file__), "debug")


@contextmanager
def browser_page(headless: bool = True):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ConnexionTwo-Autopilot/1.0",
            viewport={"width": 1440, "height": 900},
        )
        page = ctx.new_page()
        page.set_default_timeout(45_000)
        try:
            yield page
        finally:
            ctx.close()
            browser.close()


def dump_debug(page: Page, name: str) -> None:
    os.makedirs(DEBUG_DIR, exist_ok=True)
    try:
        page.screenshot(path=os.path.join(DEBUG_DIR, f"{name}.png"), full_page=True)
        with open(os.path.join(DEBUG_DIR, f"{name}.html"), "w", encoding="utf-8") as f:
            f.write(page.content())
        print(f"  [debug] wrote {DEBUG_DIR}/{name}.png and .html")
    except Exception as e:
        print(f"  [debug] failed: {e}")


def txt(el) -> str:
    try:
        return (el.inner_text() or "").strip()
    except Exception:
        return ""


def first_text(row, selectors: list[str]) -> str:
    """Return the text of the first selector that matches inside `row`."""
    for sel in selectors:
        if not sel:
            continue
        try:
            el = row.query_selector(sel)
            if el:
                t = txt(el)
                if t:
                    return t
        except Exception:
            continue
    return ""


def first_href(row, base_url: str, selectors: list[str]) -> str | None:
    for sel in (selectors or ["a"]):
        try:
            el = row.query_selector(sel) if sel else row.query_selector("a")
            href = el.get_attribute("href") if el else None
            if href:
                if href.startswith("http"):
                    return href
                from urllib.parse import urljoin
                return urljoin(base_url, href)
        except Exception:
            continue
    return None


_DATE_PATTERNS = [
    "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%B %d, %Y", "%b %d, %Y",
    "%m/%d/%Y %I:%M %p", "%m/%d/%Y %H:%M", "%d %b %Y",
]


def parse_date(s: str) -> str | None:
    """Best-effort parse of a due-date string -> YYYY-MM-DD (None if unparseable)."""
    if not s:
        return None
    s = s.strip()
    # pull the first date-looking token out of noisy text ("Closes 08/15/2026 2:00 PM ET")
    m = re.search(r"([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})", s)
    cand = m.group(1) if m else s
    for fmt in _DATE_PATTERNS:
        try:
            return dt.datetime.strptime(cand, fmt).date().isoformat()
        except ValueError:
            continue
    return None
