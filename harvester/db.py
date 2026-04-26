"""SQLite schema + helpers. FTS5 virtual table is kept in sync via triggers."""
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
    discipline     TEXT,
    datestamp      TEXT,
    harvested_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_theses_year       ON theses(year);
CREATE INDEX IF NOT EXISTS idx_theses_discipline ON theses(discipline);
CREATE INDEX IF NOT EXISTS idx_theses_source     ON theses(source_id);
CREATE INDEX IF NOT EXISTS idx_theses_type       ON theses(type);

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


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def upsert_thesis(conn: sqlite3.Connection, row: dict) -> None:
    cols = ("oai_identifier", "source_id", "source_name", "title", "authors",
            "abstract", "subjects", "year", "type", "language", "publisher",
            "url", "discipline", "datestamp")
    placeholders = ", ".join(["?"] * len(cols))
    set_clause = ", ".join(f"{c}=excluded.{c}" for c in cols if c != "oai_identifier")
    conn.execute(
        f"INSERT INTO theses ({', '.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT(oai_identifier) DO UPDATE SET {set_clause}",
        tuple(row.get(c) for c in cols),
    )
