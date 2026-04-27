"""Normalize OAI Dublin Core records into a unified thesis schema.

Input: dict with `oai_identifier`, `datestamp`, `dc` (DC field -> list[str]).
Output: dict ready for the `theses` table, or None to skip.

We keep the record only if it looks like a thesis or dissertation.
"""
from __future__ import annotations

import html
import re
import unicodedata
from typing import Optional

THESIS_TYPE_HINTS = (
    "thesis", "these",
    "dissertation",
    "memoir", "memoire",
    "doctoral", "master",
    "info:eu-repo/semantics/doctoralthesis",
    "info:eu-repo/semantics/masterthesis",
    "info:eu-repo/semantics/bachelorthesis",
)

DOCTORAL_TYPE_SIGNALS = (
    "doctoral thesis", "doctorate", "doctorat",
    "these de doctorat", "ph.d", "phd",
    "info:eu-repo/semantics/doctoralthesis",
)

MASTER_TYPE_SIGNALS = (
    "master thesis", "master's thesis", "masters thesis",
    "memoire de maitrise",
    "info:eu-repo/semantics/masterthesis",
    "m.a.", "m.sc", "m.eng", "m.ed",
)

YEAR_RE = re.compile(r"\b(1[89]\d{2}|20\d{2}|21\d{2})\b")


def _strip_diacritics(s: str) -> str:
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _clean(text: str) -> str:
    """Decode HTML entities and collapse whitespace."""
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def _first(values: list[str] | None) -> str:
    if not values:
        return ""
    return _clean(values[0])


def _join(values: list[str] | None, sep: str = "; ") -> str:
    if not values:
        return ""
    return sep.join(_clean(v) for v in values if v and v.strip())


def _classify_type(dc: dict) -> Optional[str]:
    """Return 'thesis' (doctoral), 'memoire' (master), or None.

    Decision order, prioritising the explicit dc:type field over fuzzy
    matches in title/abstract:
      1. dc:type contains an explicit doctoral marker → 'thesis'
      2. dc:type contains an explicit master marker → 'memoire'
      3. dc:type contains a generic thesis hint → 'thesis'
      4. dc:type is present but says something else (Article, Conference,
         Book, journal, map, image, …) → None
      5. dc:type absent or unrecognised: fall back to title/abstract
         heuristics for repositories that don't expose a usable type.
    """
    type_values = [v.lower() for v in dc.get("type", []) if v]
    type_blob = _strip_diacritics(" ".join(type_values))

    if type_values:
        if any(sig in type_blob for sig in DOCTORAL_TYPE_SIGNALS):
            return "thesis"
        if any(sig in type_blob for sig in MASTER_TYPE_SIGNALS):
            return "memoire"
        if any(hint in type_blob for hint in THESIS_TYPE_HINTS):
            if "master" in type_blob or "maitrise" in type_blob \
                    or "memoire" in type_blob:
                return "memoire"
            return "thesis"
        return None

    blob = _strip_diacritics(" ".join(
        v.lower() for vals in (dc.get("subject", []), dc.get("description", []),
                               dc.get("title", []))
        for v in vals
    ))
    if not any(hint in blob for hint in THESIS_TYPE_HINTS):
        return None

    if any(s in blob for s in ("doctoral", "ph.d", "phd", "doctorat", "doctorate")):
        return "thesis"
    if any(s in blob for s in ("master", "maitrise", "memoire", "m.a.", "m.sc")):
        return "memoire"
    return "thesis"


def _extract_year(dc: dict) -> Optional[int]:
    """Prefer the earliest plausible year across dc:date / dc:issued.

    DSpace exports several dates per record (issued, accessioned, available,
    migration timestamp). The publication year is almost always the earliest
    one — much more reliable than picking the first match.
    """
    years: list[int] = []
    for field in ("date", "issued"):
        for v in dc.get(field, []):
            for m in YEAR_RE.finditer(v):
                year = int(m.group(1))
                if 1800 <= year <= 2100:
                    years.append(year)
    return min(years) if years else None


def _pick_url(dc: dict, oai_identifier: str) -> str:
    """Prefer landing pages (DOI, handle.net) over direct file downloads."""
    candidates = [v for v in dc.get("identifier", [])
                  if v.startswith(("http://", "https://"))]
    candidates += [v for v in dc.get("relation", [])
                   if v.startswith(("http://", "https://"))]

    def score(url: str) -> int:
        u = url.lower()
        if u.endswith((".pdf", ".doc", ".docx")): return 0  # raw file: last resort
        if "doi.org" in u: return 3
        if "handle.net" in u: return 3
        if "/id/eprint/" in u and not u.endswith("/"): return 2
        return 1

    if not candidates:
        return ""
    return max(candidates, key=score)


def normalize_record(payload: dict, source: dict) -> Optional[dict]:
    dc = payload.get("dc", {})
    if not dc:
        return None

    # Authoritative discipline from the source (e.g. DSpace's qualified
    # `subject@discipline`, ETDMS's `degree.discipline`). Stored as its own
    # column AND prepended to subjects so it surfaces in search results.
    auth_disc = (payload.get("authoritative_discipline") or "").strip()
    if auth_disc:
        existing = dc.get("subject") or []
        if auth_disc not in existing:
            dc["subject"] = [auth_disc] + existing

    thesis_type = _classify_type(dc)
    if thesis_type is None:
        return None  # not a thesis — skip

    title = _first(dc.get("title"))
    if not title:
        return None

    return {
        "oai_identifier": payload["oai_identifier"],
        "source_id": source["id"],
        "source_name": source["short"],
        "title": title,
        "authors": _join(dc.get("creator")),
        "abstract": _first(dc.get("description")),
        "subjects": _join(dc.get("subject")),
        "year": _extract_year(dc),
        "type": thesis_type,
        "language": _first(dc.get("language")),
        "publisher": _first(dc.get("publisher")),
        "url": _pick_url(dc, payload["oai_identifier"]),
        "authoritative_discipline": auth_disc or None,
        "datestamp": payload.get("datestamp", ""),
    }
