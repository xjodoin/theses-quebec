"""Tests for the upsert / preservation / harvest_state behaviors."""
import sqlite3

import pytest

from db import (
    connect, upsert_thesis, delete_thesis,
    get_harvest_from, set_harvest_state,
)


def _record(oai="oai:test:1", title="Sample thèse", **kw):
    base = {
        "oai_identifier": oai,
        "source_id": "test",
        "source_name": "Test",
        "title": title,
        "authors": "Doe, Jane",
        "abstract": "",
        "subjects": "",
        "year": 2024,
        "type": "thesis",
        "language": "fr",
        "publisher": "",
        "url": "https://example.test/1",
        "discipline": "Autre / non classé",
        "datestamp": "2024-06-15",
    }
    base.update(kw)
    return base


@pytest.fixture
def conn(tmp_path):
    db = tmp_path / "t.db"
    c = connect(str(db))
    yield c
    c.close()


def test_first_insert_marks_discipline_as_rule(conn):
    upsert_thesis(conn, _record(discipline="Biologie"))
    row = conn.execute(
        "SELECT discipline, discipline_source FROM theses WHERE oai_identifier = ?",
        ("oai:test:1",)).fetchone()
    assert row["discipline"] == "Biologie"
    assert row["discipline_source"] == "rule"


def test_reupsert_overwrites_when_source_is_rule(conn):
    upsert_thesis(conn, _record(discipline="Biologie"))
    upsert_thesis(conn, _record(discipline="Chimie"))   # rules improved
    row = conn.execute(
        "SELECT discipline, discipline_source FROM theses").fetchone()
    assert row["discipline"] == "Chimie"
    assert row["discipline_source"] == "rule"


def test_reupsert_preserves_llm_classification(conn):
    upsert_thesis(conn, _record(discipline="Autre / non classé"))
    # Simulate llm_classify writing the curated label.
    conn.execute(
        "UPDATE theses SET discipline = ?, discipline_source = 'llm' "
        "WHERE oai_identifier = ?",
        ("Psychologie", "oai:test:1"))
    # Re-harvest produces a fresh rule-based result that disagrees.
    upsert_thesis(conn, _record(discipline="Sociologie"))
    row = conn.execute(
        "SELECT discipline, discipline_source, title FROM theses").fetchone()
    assert row["discipline"] == "Psychologie"   # llm value preserved
    assert row["discipline_source"] == "llm"
    # But other fields are still refreshed.
    upsert_thesis(conn, _record(discipline="X", title="Updated title"))
    row = conn.execute("SELECT title, discipline FROM theses").fetchone()
    assert row["title"] == "Updated title"
    assert row["discipline"] == "Psychologie"   # still llm-protected


def test_reupsert_preserves_manual_override(conn):
    upsert_thesis(conn, _record(discipline="Biologie"))
    conn.execute(
        "UPDATE theses SET discipline = ?, discipline_source = 'manual' "
        "WHERE oai_identifier = ?",
        ("Génie biomédical", "oai:test:1"))
    upsert_thesis(conn, _record(discipline="Biologie"))
    row = conn.execute("SELECT discipline, discipline_source FROM theses").fetchone()
    assert row["discipline"] == "Génie biomédical"
    assert row["discipline_source"] == "manual"


def test_delete_thesis_removes_record(conn):
    upsert_thesis(conn, _record())
    assert conn.execute("SELECT COUNT(*) FROM theses").fetchone()[0] == 1
    n = delete_thesis(conn, "oai:test:1")
    assert n == 1
    assert conn.execute("SELECT COUNT(*) FROM theses").fetchone()[0] == 0


def test_delete_thesis_idempotent_on_missing(conn):
    n = delete_thesis(conn, "oai:does-not-exist")
    assert n == 0


def test_harvest_state_round_trip(conn):
    assert get_harvest_from(conn, "udem") is None
    set_harvest_state(conn, "udem", "2026-04-26T12:00:00Z",
                      seen=100, kept=80, deleted=2)
    assert get_harvest_from(conn, "udem") == "2026-04-26T12:00:00Z"
    # update overwrites
    set_harvest_state(conn, "udem", "2026-04-27T12:00:00Z",
                      seen=10, kept=10, deleted=0)
    assert get_harvest_from(conn, "udem") == "2026-04-27T12:00:00Z"


def test_migration_idempotent(tmp_path):
    """Calling connect() twice on the same file shouldn't fail or duplicate."""
    db = tmp_path / "t.db"
    c1 = connect(str(db))
    upsert_thesis(c1, _record())
    c1.commit()
    c1.close()
    c2 = connect(str(db))   # should succeed, schema already present
    rows = c2.execute("SELECT COUNT(*) FROM theses").fetchone()[0]
    assert rows == 1
    c2.close()
