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

Why oai_etdms (and how we work around its bug)
----------------------------------------------
McGill's `oai_dc` view collapses the degree to just `<dc:type>Thesis</dc:type>`
— no master vs. doctoral distinction. That made every McGill record default
to `type='thesis'` (PhD) when in fact the bulk are master's (mémoires).

The `oai_etdms` view carries the right data (`<degree><name>`,
`<degree><discipline>`, `<degree><grantor>`), but McGill's Blacklight provider
aborts a `ListRecords` page with `cannotDisseminateFormat` whenever any one
record in the page can't be serialized as ETDMS. Earlier this code fell back
to oai_dc to avoid the issue; the cost was wholesale type misclassification.

Workaround: when we hit `cannotDisseminateFormat`, we parse the resumption
token's cursor offset (`oai_etdms.s(...).t(N):OFFSET`) and increment OFFSET
by 1, retrying until we get records back. This pinpoints the bad record at
the cost of skipping it (and any good records preceding it within the failed
window). Lost records keep whatever data we already have in the DB from prior
harvests.
"""
from __future__ import annotations

import argparse
import re
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
    "metadata_prefix": "oai_etdms",
    "home_url": "https://escholarship.mcgill.ca/",
}

# Resumption-token cursor: "<prefix>.s(...).f(...).u(...).t(<total>):<offset>"
_TOKEN_OFFSET_RE = re.compile(r":(\d+)$")
# Hard cap on consecutive offset bumps after a serialization error. Each
# bump = one extra HTTP call; the worst case observed is one bad record per
# 25-record page, so 50 is comfortably above the page size and prevents
# runaway loops if McGill ever returns a long contiguous run of bad records.
_MAX_SKIP_BUMPS = 50


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


def _bump_token_offset(token: str, by: int = 1) -> str | None:
    """Increment the trailing `:N` cursor in a Blacklight resumption token.

    Returns None if the token doesn't end in `:N`, in which case we can't
    skip — caller should treat the error as fatal.
    """
    m = _TOKEN_OFFSET_RE.search(token)
    if not m:
        return None
    new_offset = int(m.group(1)) + by
    return _TOKEN_OFFSET_RE.sub(f":{new_offset}", token)


def make_record_iter(page: Page):
    """Return a callable(source, max_records, from_date) -> Iterator[ET.Element]."""
    def _iter(source: dict, max_records: int | None,
              from_date: str | None = None) -> Iterator[ET.Element]:
        base = source["base_url"]
        prefix = source.get("metadata_prefix", "oai_dc")
        url = f"{base}?verb=ListRecords&metadataPrefix={prefix}"
        if source.get("set"):
            url += f"&set={source['set']}"
        if from_date:
            url += f"&from={from_date}"

        # Track the last token we sent so we can bump its offset if the
        # current page errors with cannotDisseminateFormat. None means we're
        # on the very first request, which has no token yet.
        last_token: str | None = None
        skipped_records = 0

        fetched = 0
        while True:
            xml = _fetch_xml(page, url)
            root = ET.fromstring(xml)

            err = root.find("oai:error", NS)
            if err is not None:
                code = err.get("code", "unknown")
                if code == "noRecordsMatch":
                    return
                # McGill aborts a ListRecords page when any record in it
                # can't be serialized as ETDMS. Bump the cursor by 1 and
                # retry — see the module docstring for context.
                if code == "cannotDisseminateFormat" and last_token:
                    bumped = last_token
                    for _ in range(_MAX_SKIP_BUMPS):
                        bumped = _bump_token_offset(bumped, 1)
                        if bumped is None:
                            break
                        skipped_records += 1
                        url = f"{base}?verb=ListRecords&resumptionToken={bumped}"
                        time.sleep(0.3)
                        retry_xml = _fetch_xml(page, url)
                        retry_root = ET.fromstring(retry_xml)
                        retry_err = retry_root.find("oai:error", NS)
                        if retry_err is None:
                            # Found a clean offset. Replay normal flow with
                            # this response.
                            xml = retry_xml
                            root = retry_root
                            last_token = bumped
                            print(
                                f"  ! skipped past serialization-error window "
                                f"(total skipped: {skipped_records})",
                                flush=True,
                            )
                            break
                        if retry_err.get("code") == "noRecordsMatch":
                            return
                    else:
                        raise RuntimeError(
                            f"OAI error {code}: gave up after "
                            f"{_MAX_SKIP_BUMPS} bumps from {last_token!r}"
                        )
                    err = root.find("oai:error", NS)
                if err is not None:
                    raise RuntimeError(f"OAI error {err.get('code')}: {err.text}")

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
            last_token = token_el.text.strip()
            url = f"{base}?verb=ListRecords&resumptionToken={last_token}"
            time.sleep(0.5)
    return _iter


def harvest_mcgill(db_path: str, max_records: int | None,
                   headless: bool = True, full: bool = False) -> dict:
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
                full=full,
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
    ap.add_argument("--full", action="store_true",
                    help="Force a full re-harvest, ignoring prior incremental state.")
    args = ap.parse_args()

    stats = harvest_mcgill(args.db, args.max_records,
                           headless=not args.headed, full=args.full)
    return 0 if stats["kept"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
