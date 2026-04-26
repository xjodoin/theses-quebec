"""Re-run rule-based classification on every record in the DB.

Usage: python harvester/reclassify.py [--db data/theses.db]

Useful after enriching DISCIPLINE_RULES with new keywords, so existing
records benefit without re-harvesting from sources.

Update policy (preserves LLM-assigned classifications):
- If current discipline is OTHER → adopt the new rule-based result
  (whatever it is, even OTHER stays OTHER).
- If current discipline is non-OTHER and the new rule-based result is
  also non-OTHER but different → adopt the new result (rules improved).
- If current discipline is non-OTHER and the new rule-based result is
  OTHER → keep current value (likely set by the LLM).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "harvester"))

from classify import classify_discipline, OTHER  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "theses.db"))
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the diff summary without writing.")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    rows = list(conn.execute(
        "SELECT oai_identifier, title, subjects, abstract, publisher, discipline "
        "FROM theses"
    ))

    other_to_specific = 0
    rule_to_rule = 0
    transitions: Counter = Counter()
    updates: list[tuple[str, str]] = []

    for row in rows:
        record = {
            "title": row["title"] or "",
            "subjects": row["subjects"] or "",
            "abstract": row["abstract"] or "",
            "publisher": row["publisher"] or "",
        }
        new = classify_discipline(record)
        cur = row["discipline"] or OTHER

        if cur == OTHER and new != OTHER:
            other_to_specific += 1
            transitions[(cur, new)] += 1
            updates.append((new, row["oai_identifier"]))
        elif cur != OTHER and new != OTHER and cur != new:
            rule_to_rule += 1
            transitions[(cur, new)] += 1
            updates.append((new, row["oai_identifier"]))

    print(f"Scanned {len(rows)} records.")
    print(f"  {other_to_specific} OTHER → specific category")
    print(f"  {rule_to_rule} reassigned between rule categories")
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
                "UPDATE theses SET discipline = ? WHERE oai_identifier = ?",
                updates,
            )
        print(f"\nWrote {len(updates)} updates to {args.db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
