"""Parsers for the OAI-PMH metadata formats our sources expose.

Each parser turns a `<oai:record>` element into the same dict shape that the
rest of the harvester downstream expects::

    {
      "oai_identifier": "oai:host:id",
      "datestamp": "2024-06-15T10:00:00Z",
      "dc": { field: [values] },         # Dublin Core-equivalent fields
      "authoritative_discipline": "..."  # optional, from a qualified field
    }

`authoritative_discipline` is set when the source exposes an explicit
discipline / department field that's lost in the basic `oai_dc` view (e.g.
DSpace's `<dim:field mdschema="dc" element="subject" qualifier="discipline">`
or ETDMS's `<etdms:degree><etdms:discipline>`). The harvester injects that
value into `dc:subject` so the classifier picks it up with high confidence
on a primary-blob (title + subjects) match.

Two sentinel return values:
- `{}` — record is malformed, skip it
- `{"_deleted": True, "oai_identifier": ...}` — tombstone, the harvester
  removes the matching record from the DB
"""
from __future__ import annotations

from xml.etree import ElementTree as ET

OAI_NS       = "http://www.openarchives.org/OAI/2.0/"
DC_NS        = "http://purl.org/dc/elements/1.1/"
DCTERMS_NS   = "http://purl.org/dc/terms/"
OAI_DC_NS    = "http://www.openarchives.org/OAI/2.0/oai_dc/"
DIM_NS       = "http://www.dspace.org/xmlns/dspace/dim"
ETDMS_10_NS  = "http://www.ndltd.org/standards/metadata/etdms/1.0/"
ETDMS_10_NS_DASH = "http://www.ndltd.org/standards/metadata/etdms/1-0/"  # McGill (Hyrax)
ETDMS_11_NS  = "http://www.ndltd.org/standards/metadata/etdms/1.1/"


# ---------------------------------------------------------------- helpers --

def _parse_header(record):
    """Return (oai_identifier, datestamp, is_deleted). All three may be None
    on a malformed record (caller treats as skip)."""
    header = record.find(f"{{{OAI_NS}}}header")
    if header is None:
        return None, None, False
    identifier = header.findtext(f"{{{OAI_NS}}}identifier", default="").strip()
    if header.get("status") == "deleted":
        return identifier, None, True
    datestamp = header.findtext(f"{{{OAI_NS}}}datestamp", default="").strip()
    return identifier, datestamp, False


def _add(fields: dict[str, list[str]], key: str, value: str) -> None:
    if value:
        fields.setdefault(key, []).append(value)


# ---------------------------------------------------------------- oai_dc --

def parse_oai_dc(record):
    """Plain Dublin Core (15 unqualified elements). Our previous default."""
    oai_id, datestamp, deleted = _parse_header(record)
    if oai_id is None:
        return {}
    if deleted:
        return {"_deleted": True, "oai_identifier": oai_id}

    dc_root = record.find(f"{{{OAI_NS}}}metadata/{{{OAI_DC_NS}}}dc")
    if dc_root is None:
        return {}

    fields: dict[str, list[str]] = {}
    for child in dc_root:
        tag = child.tag.split("}", 1)[-1]
        _add(fields, tag, (child.text or "").strip())

    return {
        "oai_identifier": oai_id,
        "datestamp": datestamp,
        "dc": fields,
        "authoritative_discipline": None,
    }


# ---------------------------------------------------------------- dim ----

def parse_dim(record):
    """DSpace Intermediate Metadata. Preserves qualifiers from `dc.*`,
    `thesis.degree.*`, `etd.degree.*`, `etdms.degree.*` (different DSpace
    distros use different schema names for the thesis-specific fields)."""
    oai_id, datestamp, deleted = _parse_header(record)
    if oai_id is None:
        return {}
    if deleted:
        return {"_deleted": True, "oai_identifier": oai_id}

    dim_root = record.find(f".//{{{DIM_NS}}}dim")
    if dim_root is None:
        return {}

    fields: dict[str, list[str]] = {}
    auth_disc: str | None = None

    for f in dim_root.findall(f"{{{DIM_NS}}}field"):
        schema = f.get("mdschema") or ""
        element = f.get("element") or ""
        qualifier = f.get("qualifier")
        text = (f.text or "").strip()
        if not text:
            continue

        # Authoritative discipline. First match wins (they're corroborating).
        if auth_disc is None and qualifier == "discipline" and (
            (schema == "dc" and element == "subject")
            or (schema in ("thesis", "etd", "etdms") and element == "degree")
        ):
            auth_disc = text

        # Project to DC-equivalent shape downstream code expects.
        if schema == "dc":
            # DSpace splits the `contributor` element by qualifier:
            #   author    → dc.creator       (canonical author list)
            #   advisor / thesisadvisor / supervisor → _advisor (own field)
            # Other qualifiers (editor, illustrator) are dropped — not
            # surfaced anywhere yet.
            if element == "contributor":
                if qualifier == "author":
                    _add(fields, "creator", text)
                elif qualifier in ("advisor", "thesisadvisor", "supervisor"):
                    _add(fields, "_advisor", text)
            else:
                _add(fields, element, text)
        elif element == "degree" and qualifier in ("level", "name"):
            # Surface degree level/name as `type` for normalize._classify_type.
            _add(fields, "type", text)

    return {
        "oai_identifier": oai_id,
        "datestamp": datestamp,
        "dc": fields,
        "authoritative_discipline": auth_disc,
    }


# ---------------------------------------------------------------- etdms --

def parse_oai_etdms(record):
    """OAI ETDMS (Electronic Theses & Dissertations Metadata Standard).

    Carries `<etdms:thesis>` with explicit `<etdms:degree><etdms:discipline>`.
    Some servers (UQTR) emit the typo `<etdms:subjectsss>` for subjects;
    we accept both spellings.
    """
    oai_id, datestamp, deleted = _parse_header(record)
    if oai_id is None:
        return {}
    if deleted:
        return {"_deleted": True, "oai_identifier": oai_id}

    metadata = record.find(f"{{{OAI_NS}}}metadata")
    if metadata is None:
        return {}

    thesis = None
    ns = None
    for candidate in (ETDMS_10_NS, ETDMS_10_NS_DASH, ETDMS_11_NS):
        thesis = metadata.find(f"{{{candidate}}}thesis")
        if thesis is not None:
            ns = candidate
            break
    if thesis is None:
        return {}

    SIMPLE = {
        "title": "title",
        "creator": "creator",
        "subject": "subject",
        "subjectsss": "subject",   # UQTR typo
        "description": "description",
        "date": "date",
        "language": "language",
        "identifier": "identifier",
        "publisher": "publisher",
        "type": "type",
    }

    fields: dict[str, list[str]] = {}
    auth_disc: str | None = None

    for child in thesis:
        tag = child.tag.split("}", 1)[-1]
        if tag in SIMPLE:
            _add(fields, SIMPLE[tag], (child.text or "").strip())
        elif tag == "contributor":
            # ETDMS 1.0+: <contributor role="advisor|supervisor|thesisAdvisor">.
            # Other roles (committeeMember, examiner) are dropped.
            role = (child.get("role") or "").strip().lower()
            text = (child.text or "").strip()
            if text and role in ("advisor", "supervisor", "thesisadvisor"):
                _add(fields, "_advisor", text)

    degree = thesis.find(f"{{{ns}}}degree")
    if degree is not None:
        disc = degree.find(f"{{{ns}}}discipline")
        if disc is not None and (disc.text or "").strip():
            auth_disc = disc.text.strip()
        for tag in ("level", "name"):
            el = degree.find(f"{{{ns}}}{tag}")
            if el is not None and (el.text or "").strip():
                _add(fields, "type", el.text.strip())
        grantor = degree.find(f"{{{ns}}}grantor")
        if grantor is not None and (grantor.text or "").strip():
            _add(fields, "publisher", grantor.text.strip())

    return {
        "oai_identifier": oai_id,
        "datestamp": datestamp,
        "dc": fields,
        "authoritative_discipline": auth_disc,
    }


# ---------------------------------------------------------------- uketd_dc --

def parse_uketd_dc(record):
    """UK Electronic Theses Dublin Core. Plain DC fields plus
    `uketdterms:department`, `uketdterms:degreelevel`,
    `uketdterms:qualificationname`, `uketdterms:institution`.
    """
    oai_id, datestamp, deleted = _parse_header(record)
    if oai_id is None:
        return {}
    if deleted:
        return {"_deleted": True, "oai_identifier": oai_id}

    metadata = record.find(f"{{{OAI_NS}}}metadata")
    if metadata is None:
        return {}

    # The wrapper element name varies across servers ("uketd_dc",
    # "qualifieddc", "thesis_metadata"...) — just use the first child of
    # <metadata> as root.
    root = next(iter(metadata), None)
    if root is None:
        return {}

    fields: dict[str, list[str]] = {}
    auth_disc: str | None = None

    for child in root:
        full = child.tag
        local = full.split("}", 1)[-1]
        ns = full.split("}", 1)[0].lstrip("{") if "}" in full else ""
        text = (child.text or "").strip()
        if not text:
            continue

        if ns in (DC_NS, DCTERMS_NS):
            _add(fields, local, text)
        elif "uketdterms" in ns or "ethos" in ns or "ukoln" in ns:
            if local == "department" and auth_disc is None:
                auth_disc = text
            elif local in ("degreelevel", "qualificationname",
                           "qualificationlevel"):
                # `qualificationlevel` ("doctoral" / "masters") is what ÉTS,
                # INRS, UQO, UQAC populate; `qualificationname` ("phd",
                # "engd") is set on doctoral records only at INRS/UQAC. Both
                # contribute thesis-type signals to normalize._classify_type.
                _add(fields, "type", text)
            elif local == "institution":
                _add(fields, "publisher", text)

    return {
        "oai_identifier": oai_id,
        "datestamp": datestamp,
        "dc": fields,
        "authoritative_discipline": auth_disc,
    }


# ---------------------------------------------------------------- dispatch --

PARSERS = {
    "oai_dc":    parse_oai_dc,
    "dim":       parse_dim,
    "oai_etdms": parse_oai_etdms,
    "etdms":     parse_oai_etdms,    # some servers use the bare name
    "uketd_dc":  parse_uketd_dc,
}


def parse_record(record, metadata_prefix: str = "oai_dc"):
    """Dispatch on metadata_prefix; falls back to oai_dc for unknown values."""
    return PARSERS.get(metadata_prefix, parse_oai_dc)(record)
