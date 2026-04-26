"""OAI-PMH harvester for Quebec institutional repositories.

Streams oai_dc records from each source, normalizes them, classifies
discipline, and upserts into SQLite. Resumption tokens handle pagination.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

import requests
import yaml

from normalize import normalize_record
from classify import classify_discipline
from db import connect, upsert_thesis

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
                 max_records: int | None = None,
                 user_agent: str = DEFAULT_UA) -> Iterator[ET.Element]:
    """Yield <record> elements from an OAI-PMH endpoint, following resumptionToken."""
    params = {"verb": "ListRecords", "metadataPrefix": metadata_prefix}
    if set_spec:
        params["set"] = set_spec
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


def record_to_dict(record: ET.Element) -> dict:
    """Pull header + Dublin Core fields out of an OAI record element."""
    header = record.find("oai:header", NS)
    if header is None or header.get("status") == "deleted":
        return {}

    identifier = header.findtext("oai:identifier", default="", namespaces=NS).strip()
    datestamp = header.findtext("oai:datestamp", default="", namespaces=NS).strip()

    dc_root = record.find("oai:metadata/oai_dc:dc", NS)
    if dc_root is None:
        return {}

    fields: dict[str, list[str]] = {}
    for child in dc_root:
        # tag is like '{http://purl.org/dc/elements/1.1/}title'
        tag = child.tag.split("}", 1)[-1]
        text = (child.text or "").strip()
        if text:
            fields.setdefault(tag, []).append(text)

    return {
        "oai_identifier": identifier,
        "datestamp": datestamp,
        "dc": fields,
    }


def ingest_record(raw: ET.Element, source: dict, conn: sqlite3.Connection) -> str:
    """Ingest one OAI <record>. Returns 'kept' | 'skipped'.

    Raises on parse errors so callers can count them.
    """
    payload = record_to_dict(raw)
    if not payload:
        return "skipped"
    normalized = normalize_record(payload, source)
    if not normalized:
        return "skipped"
    normalized["discipline"] = classify_discipline(normalized)
    upsert_thesis(conn, normalized)
    return "kept"


def harvest_source(source: dict, conn: sqlite3.Connection,
                   max_records: int | None = None,
                   record_iter=None) -> dict:
    """Harvest one source, return stats.

    `record_iter` is an optional callable(source, max_records) -> Iterator[ET.Element]
    that overrides the default HTTP fetcher (used by the Playwright-based
    McGill harvester to bypass Azure WAF).
    """
    stats = {"seen": 0, "kept": 0, "skipped": 0, "errors": 0}
    print(f"\n=== {source['name']} ({source['base_url']}) ===", flush=True)

    iterator = (record_iter(source, max_records) if record_iter
                else iter_records(source["base_url"],
                                  set_spec=source.get("set"),
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
    except requests.HTTPError as exc:
        print(f"  HTTP error: {exc}", flush=True)
        stats["errors"] += 1
    except Exception as exc:
        print(f"  fatal: {exc}", flush=True)
        stats["errors"] += 1

    print(f"  done: seen={stats['seen']} kept={stats['kept']} "
          f"skipped={stats['skipped']} errors={stats['errors']}", flush=True)
    return stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=str(ROOT / "harvester" / "sources.yaml"))
    ap.add_argument("--db", default=str(ROOT / "data" / "theses.db"))
    ap.add_argument("--max-per-source", type=int, default=None,
                    help="Cap records per source (useful for testing).")
    ap.add_argument("--only", nargs="+", help="Source ids to harvest (default: all).")
    args = ap.parse_args()

    sources = yaml.safe_load(Path(args.sources).read_text())
    if args.only:
        sources = [s for s in sources if s["id"] in args.only]
        if not sources:
            print(f"No sources matched {args.only}", file=sys.stderr)
            return 2

    conn = connect(args.db)
    totals = {"seen": 0, "kept": 0, "skipped": 0, "errors": 0}
    for source in sources:
        stats = harvest_source(source, conn, max_records=args.max_per_source)
        for k, v in stats.items():
            totals[k] += v

    print(f"\n=== TOTAL === seen={totals['seen']} kept={totals['kept']} "
          f"skipped={totals['skipped']} errors={totals['errors']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
