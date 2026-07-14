"""Thin client for the ConnexionTwo scrape-ingest edge function.

Auth is a per-user INGEST TOKEN (Settings -> API keys / schedule in the app),
not a login. Configure via env:

    SUPABASE_URL      e.g. https://rfdvogakvyodixgpvqvz.supabase.co
    C2_INGEST_TOKEN   the uuid shown in the app under Settings -> Scraping
"""
import os
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
INGEST_TOKEN = os.environ["C2_INGEST_TOKEN"]
_FN = f"{SUPABASE_URL}/functions/v1/scrape-ingest"
_HEADERS = {"Authorization": f"Bearer {INGEST_TOKEN}", "Content-Type": "application/json"}


def schedule_check() -> dict:
    """Ask the server whether now matches the user's weekly schedule.

    Returns e.g. {"due": True, "portals": ["ohiobuys","emma"],
                  "keywords": [...], "deadline_min_days": 5, "deadline_max_days": 90}
    """
    r = requests.post(_FN, headers=_HEADERS, json={"action": "schedule-check"}, timeout=30)
    r.raise_for_status()
    return r.json()


def ingest(portal: str, items: list[dict]) -> dict:
    """Send scraped opportunities for one portal. The server filters to the
    user's bid window, scores, dedupes, and stores them."""
    r = requests.post(_FN, headers=_HEADERS,
                      json={"action": "ingest", "portal": portal, "items": items}, timeout=120)
    r.raise_for_status()
    return r.json()
