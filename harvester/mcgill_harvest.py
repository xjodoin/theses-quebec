"""McGill eScholarship harvester (specialized).

Why this exists
---------------
escholarship.mcgill.ca sits behind Azure WAF + a JavaScript challenge that
blocks plain HTTP clients (curl, requests). The WAF accepts a real browser
session, so we drive headless Chromium with Playwright:

  1. Navigate to https://escholarship.mcgill.ca/  → WAF JS challenge runs
     in the browser, cookies get set
  2. Use page.evaluate(fetch(...)) to call /catalog/oai from inside the
     browser — credentials/cookies travel with the request
  3. Parse XML and feed into the same normalize/classify/db pipeline as
     the standard OAI harvester

Endpoint discovered: /catalog/oai (Blacklight OAI provider).
Useful set: DocumentType:Thesis (theses + dissertations only).
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

from playwright.sync_api import sync_playwright, Page

from harvest import NS, harvest_source
from db import connect

ROOT = Path(__file__).resolve().parent.parent

McGILL_SOURCE = {
    "id": "mcgill",
    "name": "McGill University (eScholarship)",
    "short": "McGill",
    "platform": "blacklight",
    "base_url": "https://escholarship.mcgill.ca/catalog/oai",
    "set": "DocumentType:Thesis",
    "home_url": "https://escholarship.mcgill.ca/",
}


def _fetch_xml(page: Page, url: str, retries: int = 3) -> str:
    """Fetch an OAI URL from inside the browser context (cookies preserved)."""
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            text = page.evaluate(
                """async (u) => {
                    const r = await fetch(u, { credentials: 'include' });
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return await r.text();
                }""",
                url,
            )
            if "<OAI-PMH" not in text:
                # WAF interstitial — re-warm by reloading home, then retry
                if attempt < retries:
                    page.goto(McGILL_SOURCE["home_url"], wait_until="networkidle")
                    time.sleep(1.0)
                    continue
                raise RuntimeError("response did not contain <OAI-PMH (WAF interstitial?)")
            return text
        except Exception as exc:
            last_exc = exc
            if attempt < retries:
                time.sleep(2.0 * attempt)
    raise RuntimeError(f"fetch failed after {retries} attempts: {last_exc}")


def make_record_iter(page: Page):
    """Return a callable(source, max_records) -> Iterator[ET.Element]."""
    def _iter(source: dict, max_records: int | None) -> Iterator[ET.Element]:
        base = source["base_url"]
        url = f"{base}?verb=ListRecords&metadataPrefix=oai_dc"
        if source.get("set"):
            url += f"&set={source['set']}"

        fetched = 0
        while True:
            xml = _fetch_xml(page, url)
            root = ET.fromstring(xml)

            err = root.find("oai:error", NS)
            if err is not None:
                code = err.get("code", "unknown")
                if code == "noRecordsMatch":
                    return
                raise RuntimeError(f"OAI error {code}: {err.text}")

            list_records = root.find("oai:ListRecords", NS)
            if list_records is None:
                return

            for record in list_records.findall("oai:record", NS):
                yield record
                fetched += 1
                if max_records and fetched >= max_records:
                    return

            token_el = list_records.find("oai:resumptionToken", NS)
            if token_el is None or not (token_el.text or "").strip():
                return
            token = token_el.text.strip()
            url = f"{base}?verb=ListRecords&resumptionToken={token}"
            time.sleep(0.5)
    return _iter


def harvest_mcgill(db_path: str, max_records: int | None,
                   headless: bool = True) -> dict:
    conn = connect(db_path)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        context = browser.new_context(
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/124.0 Safari/537.36"),
            viewport={"width": 1280, "height": 900},
            locale="en-CA",
        )
        page = context.new_page()

        # Warm up: pass the WAF JS challenge by visiting the home page.
        print("  warming up WAF session...", flush=True)
        page.goto(McGILL_SOURCE["home_url"], wait_until="networkidle", timeout=60_000)
        # Sanity check: title should be the repo, not "Azure WAF"
        if "Azure WAF" in page.title():
            print("  ! still showing WAF challenge — waiting 5s and retrying", flush=True)
            page.wait_for_timeout(5_000)
            page.reload(wait_until="networkidle")
        print(f"  page ready: {page.title()!r}", flush=True)

        try:
            stats = harvest_source(
                McGILL_SOURCE, conn,
                max_records=max_records,
                record_iter=make_record_iter(page),
            )
        finally:
            context.close()
            browser.close()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "theses.db"))
    ap.add_argument("--max-records", type=int, default=None)
    ap.add_argument("--headed", action="store_true",
                    help="Show the browser window (useful for debugging WAF).")
    args = ap.parse_args()

    stats = harvest_mcgill(args.db, args.max_records, headless=not args.headed)
    return 0 if stats["kept"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
