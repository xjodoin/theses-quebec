"""Re-run rule-based classification on every record in the DB.

Usage:
  python harvester/reclassify.py [--db data/theses.db]
  python harvester/reclassify.py --force      # overwrite LLM classifications too

Useful after enriching DISCIPLINE_RULES with new keywords, so existing
records benefit without re-harvesting from sources.

Update policy
-------------
By default, only records whose `discipline_source = 'rule'` are touched.
Records previously classified by the LLM (`discipline_source = 'llm'`) or
manually overridden (`'manual'`) are preserved unless `--force` is passed.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "harvester"))

from classify import classify_discipline_detailed, OTHER  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "theses.db"))
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the diff summary without writing.")
    ap.add_argument("--force", action="store_true",
                    help="Re-classify ALL records, including those marked "
                         "discipline_source IN ('llm', 'manual'). Use after a "
                         "major rule overhaul if you want rules to win.")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    # By default touch only rule-derived rows (incl. 'auth' and
    # 'rule_abstract' — all derivable from current code). 'llm' and
    # 'manual' stay put unless --force.
    where = "" if args.force else "WHERE discipline_source NOT IN ('llm', 'manual')"
    rows = list(conn.execute(
        "SELECT oai_identifier, title, subjects, abstract, publisher, "
        "       discipline, discipline_source, authoritative_discipline "
        f"FROM theses {where}"
    ))

    if not rows:
        print("Nothing to reclassify "
              "(no rows match — pass --force to re-classify everything).")
        return 0

    other_to_specific = 0
    rule_to_rule = 0
    transitions: Counter = Counter()
    updates: list[tuple[str, str]] = []

    source_only_changes = 0
    for row in rows:
        record = {
            "title": row["title"] or "",
            "subjects": row["subjects"] or "",
            "abstract": row["abstract"] or "",
            "publisher": row["publisher"] or "",
            "authoritative_discipline": row["authoritative_discipline"] or "",
        }
        new, new_source = classify_discipline_detailed(record)
        cur = row["discipline"] or OTHER
        cur_source = row["discipline_source"]

        if cur == OTHER and new != OTHER:
            other_to_specific += 1
            transitions[(cur, new)] += 1
            updates.append((new, new_source, row["oai_identifier"]))
        elif cur != OTHER and new != OTHER and cur != new:
            rule_to_rule += 1
            transitions[(cur, new)] += 1
            updates.append((new, new_source, row["oai_identifier"]))
        elif cur == new and new_source != cur_source and new_source != "none":
            # Same discipline, sharper provenance tag (e.g. 'rule' → 'auth'
            # now that authoritative_discipline is populated).
            source_only_changes += 1
            updates.append((new, new_source, row["oai_identifier"]))
        elif cur != OTHER and new == OTHER:
            # Don't fall back to OTHER from a non-OTHER classification.
            # The previous rule must have matched on something we no longer
            # carry — keep what we had rather than lose it.
            pass

    print(f"Scanned {len(rows):,} records "
          f"({'all' if args.force else 'rule-only'}).")
    print(f"  {other_to_specific} OTHER → specific category")
    print(f"  {rule_to_rule} reassigned between rule categories")
    print(f"  {source_only_changes} provenance-tag refinements (e.g. rule → auth)")
    print()
    if transitions:
        print("Top transitions:")
        for (from_cat, to_cat), n in transitions.most_common(20):
            print(f"  {from_cat!r:>40} → {to_cat!r:<40} ({n})")

    if args.dry_run:
        print("\n(dry run — no changes written)")
        return 0

    if updates:
        with conn:
            conn.executemany(
                "UPDATE theses SET discipline = ?, discipline_source = ? "
                "WHERE oai_identifier = ?",
                updates,
            )
        print(f"\nWrote {len(updates)} updates to {args.db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
