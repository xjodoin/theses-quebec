"""SQLite schema + helpers. FTS5 virtual table is kept in sync via triggers.

Two tables:
  - `theses`: one row per record; `oai_identifier` is the primary key
  - `harvest_state`: one row per source; tracks last harvest timestamp for
    incremental OAI-PMH harvests via the `from=` parameter

The `discipline_source` column on `theses` records WHO set the discipline:
  - 'rule'   = harvester's rule-based classifier (default for new records)
  - 'llm'    = Gemini batch classifier (set by llm_classify.py)
  - 'manual' = human override

`upsert_thesis` preserves 'llm' and 'manual' classifications across re-harvests
so the rule-based result doesn't clobber a curated value.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS theses (
    oai_identifier TEXT PRIMARY KEY,
    source_id      TEXT NOT NULL,
    source_name    TEXT NOT NULL,
    title          TEXT NOT NULL,
    authors        TEXT,
    abstract       TEXT,
    subjects       TEXT,
    year           INTEGER,
    type           TEXT,           -- 'thesis' | 'memoire'
    language       TEXT,
    publisher      TEXT,
    url            TEXT,
    discipline        TEXT,
    discipline_source TEXT NOT NULL DEFAULT 'rule',  -- 'rule' | 'llm' | 'manual'
    datestamp      TEXT,
    harvested_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_theses_year       ON theses(year);
CREATE INDEX IF NOT EXISTS idx_theses_discipline ON theses(discipline);
CREATE INDEX IF NOT EXISTS idx_theses_source     ON theses(source_id);
CREATE INDEX IF NOT EXISTS idx_theses_type       ON theses(type);

CREATE TABLE IF NOT EXISTS harvest_state (
    source_id              TEXT PRIMARY KEY,
    last_harvest_started   TEXT NOT NULL,   -- ISO 8601 UTC, used as `from=` next time
    last_records_seen      INTEGER DEFAULT 0,
    last_records_kept      INTEGER DEFAULT 0,
    last_records_deleted   INTEGER DEFAULT 0
);

-- FTS5 contentless-external table mirrors searchable fields.
CREATE VIRTUAL TABLE IF NOT EXISTS theses_fts USING fts5(
    title, authors, abstract, subjects,
    content='theses', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS theses_ai AFTER INSERT ON theses BEGIN
    INSERT INTO theses_fts(rowid, title, authors, abstract, subjects)
    VALUES (new.rowid, new.title, new.authors, new.abstract, new.subjects);
END;

CREATE TRIGGER IF NOT EXISTS theses_ad AFTER DELETE ON theses BEGIN
    INSERT INTO theses_fts(theses_fts, rowid, title, authors, abstract, subjects)
    VALUES('delete', old.rowid, old.title, old.authors, old.abstract, old.subjects);
END;

CREATE TRIGGER IF NOT EXISTS theses_au AFTER UPDATE ON theses BEGIN
    INSERT INTO theses_fts(theses_fts, rowid, title, authors, abstract, subjects)
    VALUES('delete', old.rowid, old.title, old.authors, old.abstract, old.subjects);
    INSERT INTO theses_fts(rowid, title, authors, abstract, subjects)
    VALUES (new.rowid, new.title, new.authors, new.abstract, new.subjects);
END;
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Apply column additions for existing DBs that pre-date a schema bump.

    SQLite's `CREATE TABLE IF NOT EXISTS` doesn't add columns when the table
    already exists, so we ALTER explicitly. Idempotent: checks first.
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(theses)").fetchall()}
    if "discipline_source" not in cols:
        conn.execute(
            "ALTER TABLE theses ADD COLUMN discipline_source "
            "TEXT NOT NULL DEFAULT 'rule'"
        )
        # Bootstrap: any pre-existing discipline that's NOT the catch-all has
        # been curated (initially by the rule-based classifier, then
        # potentially overridden by Gemini). We can't tell rule from LLM after
        # the fact, so to be safe we mark them all 'llm' — preventing the
        # next re-harvest from overwriting them. The user can run
        # `reclassify --force` to re-apply rules anytime.
        conn.execute(
            "UPDATE theses SET discipline_source = 'llm' "
            "WHERE discipline IS NOT NULL "
            "AND discipline != 'Autre / non classé'"
        )
        conn.commit()


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def upsert_thesis(conn: sqlite3.Connection, row: dict) -> None:
    """INSERT a new record or UPDATE an existing one.

    `discipline_source` defaults to 'rule' for new inserts (the harvester
    re-runs `classify_discipline` on every record, producing a rule-based
    label). On UPDATE, the discipline is overwritten ONLY if the existing
    `discipline_source` is 'rule'; 'llm' and 'manual' are preserved so a
    re-harvest doesn't lose a curated classification.
    """
    cols = ("oai_identifier", "source_id", "source_name", "title", "authors",
            "abstract", "subjects", "year", "type", "language", "publisher",
            "url", "discipline", "datestamp")
    placeholders = ", ".join(["?"] * len(cols))
    # Update every field but discipline/discipline_source unconditionally.
    standard_updates = ", ".join(
        f"{c}=excluded.{c}"
        for c in cols
        if c not in ("oai_identifier", "discipline")
    )
    sql = (
        f"INSERT INTO theses ({', '.join(cols)}, discipline_source) "
        f"VALUES ({placeholders}, 'rule') "
        f"ON CONFLICT(oai_identifier) DO UPDATE SET "
        f"{standard_updates}, "
        f"discipline = CASE WHEN theses.discipline_source IN ('llm', 'manual') "
        f"                  THEN theses.discipline "
        f"                  ELSE excluded.discipline END, "
        f"discipline_source = CASE WHEN theses.discipline_source IN ('llm', 'manual') "
        f"                          THEN theses.discipline_source "
        f"                          ELSE 'rule' END"
    )
    conn.execute(sql, tuple(row.get(c) for c in cols))


def delete_thesis(conn: sqlite3.Connection, oai_identifier: str) -> int:
    """Remove a thesis by OAI identifier. Returns rowcount (0 if not present)."""
    cur = conn.execute("DELETE FROM theses WHERE oai_identifier = ?", (oai_identifier,))
    return cur.rowcount


# ----------------------------------------------------------- harvest_state --

def get_harvest_from(conn: sqlite3.Connection, source_id: str) -> str | None:
    r = conn.execute(
        "SELECT last_harvest_started FROM harvest_state WHERE source_id = ?",
        (source_id,),
    ).fetchone()
    return r["last_harvest_started"] if r else None


def set_harvest_state(
    conn: sqlite3.Connection,
    source_id: str,
    started_at: str,
    *,
    seen: int = 0,
    kept: int = 0,
    deleted: int = 0,
) -> None:
    conn.execute(
        "INSERT INTO harvest_state "
        "(source_id, last_harvest_started, last_records_seen, "
        " last_records_kept, last_records_deleted) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(source_id) DO UPDATE SET "
        "last_harvest_started=excluded.last_harvest_started, "
        "last_records_seen=excluded.last_records_seen, "
        "last_records_kept=excluded.last_records_kept, "
        "last_records_deleted=excluded.last_records_deleted",
        (source_id, started_at, seen, kept, deleted),
    )
