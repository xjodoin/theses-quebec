"""OAI-PMH harvester for Quebec institutional repositories.

Streams oai_dc records from each source, normalizes them, classifies
discipline, and upserts into SQLite. Resumption tokens handle pagination.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

import requests
import yaml

from normalize import normalize_record
from classify import classify_discipline_detailed
from parsers import parse_record
from db import (
    connect, upsert_thesis, delete_thesis,
    get_harvest_from, set_harvest_state,
)

NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "oai_dc": "http://www.openarchives.org/OAI/2.0/oai_dc/",
}

ROOT = Path(__file__).resolve().parent.parent


# Some institutional WAFs (e.g. corpus.ulaval.ca's F5) silently reject requests
# whose UA looks like a script (`python-requests/*`, custom strings) — they
# return a 200 with an HTML "Request Rejected" page instead of OAI XML. A
# browser-like UA is the simplest, least invasive workaround.
DEFAULT_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/124.0.0.0 Safari/537.36 "
              "QcTheseAggregator/0.1 (+harvester; OAI-PMH client)")


def iter_records(base_url: str, metadata_prefix: str = "oai_dc",
                 set_spec: str | None = None,
                 from_date: str | None = None,
                 max_records: int | None = None,
                 user_agent: str = DEFAULT_UA) -> Iterator[ET.Element]:
    """Yield <record> elements from an OAI-PMH endpoint, following resumptionToken.

    `from_date` (UTC ISO 8601, e.g. "2026-04-25T00:00:00Z") narrows the harvest
    to records whose datestamp is ≥ from_date — used for incremental harvests.
    """
    params = {"verb": "ListRecords", "metadataPrefix": metadata_prefix}
    if set_spec:
        params["set"] = set_spec
    if from_date:
        params["from"] = from_date
    fetched = 0
    session = requests.Session()
    session.headers["User-Agent"] = user_agent

    while True:
        # Some EPrints servers are slow on the first ListRecords request.
        # We retry once with a longer timeout before giving up.
        for attempt in (1, 2):
            try:
                resp = session.get(base_url, params=params,
                                   timeout=120 if attempt == 1 else 240)
                resp.raise_for_status()
                break
            except (requests.Timeout, requests.ConnectionError) as exc:
                if attempt == 2:
                    raise
                print(f"  retrying after {type(exc).__name__}...", flush=True)
                time.sleep(3)
        root = ET.fromstring(resp.content)

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
        params = {"verb": "ListRecords", "resumptionToken": token_el.text.strip()}
        time.sleep(0.5)  # be polite


def record_to_dict(record: ET.Element, metadata_prefix: str = "oai_dc") -> dict:
    """Dispatch to the right per-format parser. Same return shape as before;
    additionally may include `authoritative_discipline` when the source
    exposes a qualified discipline / department field.
    """
    return parse_record(record, metadata_prefix)


def ingest_record(raw: ET.Element, source: dict, conn: sqlite3.Connection) -> str:
    """Ingest one OAI <record>. Returns 'kept' | 'skipped' | 'deleted'.

    Raises on parse errors so callers can count them.
    """
    prefix = source.get("metadata_prefix", "oai_dc")
    payload = record_to_dict(raw, prefix)
    if not payload:
        return "skipped"
    if payload.get("_deleted"):
        if payload.get("oai_identifier"):
            delete_thesis(conn, payload["oai_identifier"])
        return "deleted"
    normalized = normalize_record(payload, source)
    if not normalized:
        return "skipped"
    disc, source_tag = classify_discipline_detailed(normalized)
    normalized["discipline"] = disc
    normalized["discipline_source"] = source_tag if source_tag != "none" else "rule"
    upsert_thesis(conn, normalized)
    return "kept"


def harvest_source(source: dict, conn: sqlite3.Connection,
                   max_records: int | None = None,
                   record_iter=None,
                   full: bool = False) -> dict:
    """Harvest one source, return stats.

    Incremental by default: passes `from=<last_harvest_started>` to OAI-PMH
    so only records modified since the previous harvest come through.
    Pass `full=True` to force a complete re-harvest (ignores prior state).

    `record_iter` is an optional callable(source, max_records, from_date)
    that overrides the default HTTP fetcher (used by the Playwright-based
    McGill harvester to bypass Azure WAF).
    """
    stats = {"seen": 0, "kept": 0, "skipped": 0, "deleted": 0, "errors": 0}
    started_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    from_date = None if full else get_harvest_from(conn, source["id"])

    note = f" (incremental from {from_date})" if from_date else " (full)"
    print(f"\n=== {source['name']} ({source['base_url']}){note} ===", flush=True)

    iterator = (record_iter(source, max_records, from_date) if record_iter
                else iter_records(source["base_url"],
                                  metadata_prefix=source.get("metadata_prefix", "oai_dc"),
                                  set_spec=source.get("set"),
                                  from_date=from_date,
                                  max_records=max_records))
    try:
        for raw in iterator:
            stats["seen"] += 1
            try:
                outcome = ingest_record(raw, source, conn)
                stats[outcome] += 1
                if stats["kept"] and stats["kept"] % 100 == 0:
                    conn.commit()
                    print(f"  ... kept {stats['kept']} / seen {stats['seen']}", flush=True)
            except Exception as exc:  # one bad record shouldn't kill the run
                stats["errors"] += 1
                if stats["errors"] <= 3:
                    print(f"  ! record error: {exc}", flush=True)
        conn.commit()
        # Only checkpoint when the harvest reached completion (no fatal error).
        # Crashed mid-run? We keep the previous checkpoint so the next attempt
        # re-harvests the same window.
        set_harvest_state(
            conn, source["id"], started_at,
            seen=stats["seen"], kept=stats["kept"], deleted=stats["deleted"],
        )
        conn.commit()
    except requests.HTTPError as exc:
        print(f"  HTTP error: {exc}", flush=True)
        stats["errors"] += 1
    except Exception as exc:
        print(f"  fatal: {exc}", flush=True)
        stats["errors"] += 1

    print(f"  done: seen={stats['seen']} kept={stats['kept']} "
          f"skipped={stats['skipped']} deleted={stats['deleted']} "
          f"errors={stats['errors']}", flush=True)
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=str(ROOT / "harvester" / "sources.yaml"))
    ap.add_argument("--db", default=str(ROOT / "data" / "theses.db"))
    ap.add_argument("--max-per-source", type=int, default=None,
                    help="Cap records per source (useful for testing).")
    ap.add_argument("--only", nargs="+", help="Source ids to harvest (default: all).")
    ap.add_argument("--full", action="store_true",
                    help="Force a full re-harvest, ignoring prior incremental state.")
    args = ap.parse_args()

    sources = yaml.safe_load(Path(args.sources).read_text())
    if args.only:
        sources = [s for s in sources if s["id"] in args.only]
        if not sources:
            print(f"No sources matched {args.only}", file=sys.stderr)
            return 2

    conn = connect(args.db)
    totals = {"seen": 0, "kept": 0, "skipped": 0, "deleted": 0, "errors": 0}
    for source in sources:
        stats = harvest_source(source, conn,
                               max_records=args.max_per_source,
                               full=args.full)
        for k, v in stats.items():
            totals[k] += v

    print(f"\n=== TOTAL === seen={totals['seen']} kept={totals['kept']} "
          f"skipped={totals['skipped']} deleted={totals['deleted']} "
          f"errors={totals['errors']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
