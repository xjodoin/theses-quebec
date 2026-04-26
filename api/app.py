"""Search API for the aggregated thesis index.

Endpoints
---------
GET  /api/search?q=&discipline=&type=&source=&year_min=&year_max=&page=&size=
GET  /api/facets       (counts of disciplines / sources / types / year buckets)
GET  /api/sources      (list of harvested repositories)
GET  /api/healthz
GET  /                 → static frontend
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "theses.db"
WEB_DIR = ROOT / "web"

app = FastAPI(title="Quebec Theses Aggregator", version="0.1")


def get_conn() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(503, "Index not built yet. Run the harvester first.")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# FTS5 query sanitization: keep words, quote them so they're treated as
# prefix-matched terms and unbalanced operators can't break the parser.
_TOKEN_RE = re.compile(r"[\wÀ-ÿ\-]+", re.UNICODE)


def fts_query(raw: str) -> str:
    tokens = _TOKEN_RE.findall(raw or "")
    if not tokens:
        return ""
    # prefix match each token, AND-combined
    return " ".join(f'"{t}"*' for t in tokens if len(t) >= 2)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    # strip noisy fields
    d.pop("rowid", None)
    return d


@app.get("/api/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/api/sources")
def sources() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT source_id, source_name, COUNT(*) AS n "
            "FROM theses GROUP BY source_id, source_name ORDER BY source_name"
        ).fetchall()
    return {"sources": [dict(r) for r in rows]}


@app.get("/api/facets")
def facets(
    q: str = "",
    discipline: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    author: list[str] | None = Query(None),
    type: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict:
    sql, params = _build_query(q, discipline, source, author, type, year_min, year_max,
                                select="t.discipline, t.source_id, t.source_name, t.type, t.year, t.authors")
    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()

    discipline_counts: dict[str, int] = {}
    source_counts: dict[str, dict] = {}
    type_counts: dict[str, int] = {}
    decade_counts: dict[str, int] = {}
    author_counts: dict[str, int] = {}
    for r in rows:
        d = r["discipline"] or "Autre / non classé"
        discipline_counts[d] = discipline_counts.get(d, 0) + 1
        sid = r["source_id"]
        source_counts.setdefault(sid, {"id": sid, "name": r["source_name"], "n": 0})
        source_counts[sid]["n"] += 1
        t = r["type"] or "?"
        type_counts[t] = type_counts.get(t, 0) + 1
        if r["year"]:
            decade = f"{(r['year'] // 10) * 10}s"
            decade_counts[decade] = decade_counts.get(decade, 0) + 1
        if r["authors"]:
            for raw in r["authors"].split(";"):
                name = raw.strip()
                if name:
                    author_counts[name] = author_counts.get(name, 0) + 1

    top_authors = sorted(
        ({"name": k, "n": v} for k, v in author_counts.items()),
        key=lambda x: (-x["n"], x["name"]),
    )[:50]

    return {
        "total": len(rows),
        "disciplines": sorted(
            ({"name": k, "n": v} for k, v in discipline_counts.items()),
            key=lambda x: -x["n"],
        ),
        "sources": sorted(source_counts.values(), key=lambda x: -x["n"]),
        "types": [{"name": k, "n": v} for k, v in sorted(type_counts.items())],
        "decades": sorted(
            ({"name": k, "n": v} for k, v in decade_counts.items()),
            key=lambda x: x["name"],
        ),
        "authors": top_authors,
    }


SORT_OPTIONS = {
    "relevance": None,  # falls back to "rank ASC, year DESC" if q else year DESC
    "year_desc": "t.year DESC NULLS LAST, t.title ASC",
    "year_asc":  "t.year ASC NULLS LAST,  t.title ASC",
    "title_asc": "t.title COLLATE NOCASE ASC",
}


@app.get("/api/search")
def search(
    q: str = "",
    discipline: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    author: list[str] | None = Query(None),
    type: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
    sort: str = "relevance",
    page: int = 1,
    size: int = 20,
) -> dict:
    page = max(1, page)
    size = max(1, min(100, size))
    offset = (page - 1) * size

    if sort not in SORT_OPTIONS:
        sort = "relevance"
    explicit_order = SORT_OPTIONS[sort]
    if explicit_order is None:
        explicit_order = "rank ASC, t.year DESC" if q else "t.year DESC, t.title ASC"

    count_sql, count_params = _build_query(q, discipline, source, author, type, year_min, year_max,
                                            select="COUNT(*) AS n")
    sql, params = _build_query(q, discipline, source, author, type, year_min, year_max,
                                select="t.*",
                                order=explicit_order,
                                limit=size, offset=offset)

    with get_conn() as conn:
        total = conn.execute(count_sql, count_params).fetchone()["n"]
        rows = conn.execute(sql, params).fetchall()

    return {
        "total": total,
        "page": page,
        "size": size,
        "results": [_row_to_dict(r) for r in rows],
    }


def _build_query(
    q: str,
    discipline: list[str] | None,
    source: list[str] | None,
    author: list[str] | None,
    type_: str | None,
    year_min: int | None,
    year_max: int | None,
    *,
    select: str,
    order: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> tuple[str, list]:
    where: list[str] = []
    params: list = []
    fts = fts_query(q)

    if fts:
        from_clause = ("FROM theses_fts JOIN theses t ON t.rowid = theses_fts.rowid")
        where.append("theses_fts MATCH ?")
        params.append(fts)
    else:
        from_clause = "FROM theses t"

    if discipline:
        where.append("t.discipline IN (" + ",".join("?" * len(discipline)) + ")")
        params.extend(discipline)
    if source:
        where.append("t.source_id IN (" + ",".join("?" * len(source)) + ")")
        params.extend(source)
    if author:
        # Match around delimiters so "Tremblay" doesn't accidentally match
        # "Tremblay-Roy"; the stored column is semicolon-separated, optionally
        # with surrounding whitespace, so collapse "; " → ";" before INSTR.
        for a in author:
            where.append(
                "INSTR(';' || REPLACE(REPLACE(t.authors, '; ', ';'), ' ;', ';') || ';', ?) > 0"
            )
            params.append(f";{a};")
    if type_:
        where.append("t.type = ?")
        params.append(type_)
    if year_min is not None:
        where.append("t.year >= ?")
        params.append(year_min)
    if year_max is not None:
        where.append("t.year <= ?")
        params.append(year_max)

    sql = f"SELECT {select} {from_clause}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    if order:
        sql += f" ORDER BY {order}"
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    if offset:
        sql += f" OFFSET {int(offset)}"
    return sql, params


# --- static frontend ---------------------------------------------------
if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
