"""Tests for the per-format OAI-PMH parsers (dim, oai_etdms, uketd_dc)."""
from xml.etree import ElementTree as ET

import pytest

from parsers import (
    parse_record, parse_oai_dc, parse_dim, parse_oai_etdms, parse_uketd_dc,
)


def _wrap(metadata_inner: str, deleted: bool = False, identifier: str = "oai:t:1") -> ET.Element:
    """Build a fake <oai:record> envelope."""
    status = ' status="deleted"' if deleted else ""
    xml = f"""
    <record xmlns="http://www.openarchives.org/OAI/2.0/">
      <header{status}>
        <identifier>{identifier}</identifier>
        <datestamp>2024-06-15T10:00:00Z</datestamp>
      </header>
      {'' if deleted else '<metadata>' + metadata_inner + '</metadata>'}
    </record>
    """
    return ET.fromstring(xml)


# ---------------------------------------------------------------- oai_dc --

def test_oai_dc_parses_basic_record():
    rec = _wrap("""
      <oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Une thèse</dc:title>
        <dc:creator>Doe, Jane</dc:creator>
        <dc:type>Thesis</dc:type>
        <dc:subject>Biology</dc:subject>
      </oai_dc:dc>
    """)
    out = parse_record(rec, "oai_dc")
    assert out["oai_identifier"] == "oai:t:1"
    assert out["dc"]["title"] == ["Une thèse"]
    assert out["dc"]["subject"] == ["Biology"]
    assert out["authoritative_discipline"] is None


def test_deleted_record_signals_deletion_for_any_prefix():
    rec = _wrap("", deleted=True, identifier="oai:t:42")
    for prefix in ("oai_dc", "dim", "oai_etdms", "uketd_dc"):
        out = parse_record(rec, prefix)
        assert out == {"_deleted": True, "oai_identifier": "oai:t:42"}


# ---------------------------------------------------------------- dim ----

def test_dim_extracts_qualified_discipline():
    rec = _wrap("""
      <dim:dim xmlns:dim="http://www.dspace.org/xmlns/dspace/dim">
        <dim:field mdschema="dc" element="title">Une thèse</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="author">Doe, Jane</dim:field>
        <dim:field mdschema="dc" element="subject" qualifier="discipline">Computer Science</dim:field>
        <dim:field mdschema="thesis" element="degree" qualifier="discipline">Computer Science</dim:field>
        <dim:field mdschema="thesis" element="degree" qualifier="level">Master's</dim:field>
        <dim:field mdschema="dc" element="type">Thesis</dim:field>
      </dim:dim>
    """)
    out = parse_record(rec, "dim")
    assert out["authoritative_discipline"] == "Computer Science"
    # dc.* elements project to DC shape
    assert out["dc"]["title"] == ["Une thèse"]
    # `contributor@author` is mapped onto `creator` (the canonical DC field
    # for authors); other contributor qualifiers stay under `contributor`.
    assert out["dc"]["creator"] == ["Doe, Jane"]
    # degree level surfaces as `type` so the type classifier sees it
    assert "Master's" in out["dc"]["type"]


def test_dim_handles_etd_schema_for_udem():
    """UdeM uses `etd.degree.discipline` (not `thesis.degree.discipline`)."""
    rec = _wrap("""
      <dim:dim xmlns:dim="http://www.dspace.org/xmlns/dspace/dim">
        <dim:field mdschema="dc" element="title">Thèse</dim:field>
        <dim:field mdschema="etd" element="degree" qualifier="discipline">Science politique</dim:field>
        <dim:field mdschema="etd" element="degree" qualifier="level">Maîtrise</dim:field>
      </dim:dim>
    """)
    out = parse_record(rec, "dim")
    assert out["authoritative_discipline"] == "Science politique"
    assert "Maîtrise" in out["dc"]["type"]


def test_dim_handles_multiple_authors():
    """Multi-author records: every contributor@author should land in creator
    in source order, so downstream `_join` produces a `; `-separated string."""
    rec = _wrap("""
      <dim:dim xmlns:dim="http://www.dspace.org/xmlns/dspace/dim">
        <dim:field mdschema="dc" element="title">Co-authored thesis</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="author">Smith, John</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="author">Doe, Jane</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="author">García, María</dim:field>
        <dim:field mdschema="dc" element="type">Mémoire de maîtrise</dim:field>
      </dim:dim>
    """)
    out = parse_record(rec, "dim")
    assert out["dc"]["creator"] == ["Smith, John", "Doe, Jane", "García, María"]


def test_dim_separates_author_from_advisor():
    """DSpace records have multiple contributor qualifiers — only `author`
    should land in `creator`. Advisors and editors stay under `contributor`."""
    rec = _wrap("""
      <dim:dim xmlns:dim="http://www.dspace.org/xmlns/dspace/dim">
        <dim:field mdschema="dc" element="title">Une thèse</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="author">Chahine, Karim</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="advisor">Pâquet, Martin</dim:field>
        <dim:field mdschema="dc" element="type">Mémoire de maîtrise</dim:field>
      </dim:dim>
    """)
    out = parse_record(rec, "dim")
    assert out["dc"]["creator"] == ["Chahine, Karim"]
    assert out["dc"]["contributor"] == ["Pâquet, Martin"]


# ---------------------------------------------------------------- etdms --

def test_oai_etdms_extracts_discipline_and_level():
    rec = _wrap("""
      <etdms:thesis xmlns:etdms="http://www.ndltd.org/standards/metadata/etdms/1.0/">
        <etdms:title>Thèse en génie</etdms:title>
        <etdms:creator>Tremblay, Marie</etdms:creator>
        <etdms:subject>Sujet 1</etdms:subject>
        <etdms:description>Résumé</etdms:description>
        <etdms:degree>
          <etdms:name>Ph.D.</etdms:name>
          <etdms:level>doctoral</etdms:level>
          <etdms:discipline>Génie informatique</etdms:discipline>
          <etdms:grantor>Polytechnique Montréal</etdms:grantor>
        </etdms:degree>
      </etdms:thesis>
    """)
    out = parse_record(rec, "oai_etdms")
    assert out["authoritative_discipline"] == "Génie informatique"
    assert out["dc"]["title"] == ["Thèse en génie"]
    assert "doctoral" in out["dc"]["type"] or "Ph.D." in out["dc"]["type"]
    assert "Polytechnique Montréal" in out["dc"]["publisher"]


def test_etdms_uqtr_typo_subjectsss_still_picked_up():
    rec = _wrap("""
      <etdms:thesis xmlns:etdms="http://www.ndltd.org/standards/metadata/etdms/1.0/">
        <etdms:title>T</etdms:title>
        <etdms:subjectsss>Études québécoises</etdms:subjectsss>
        <etdms:degree>
          <etdms:discipline>Études québécoises</etdms:discipline>
          <etdms:level>Maîtrise</etdms:level>
        </etdms:degree>
      </etdms:thesis>
    """)
    out = parse_record(rec, "oai_etdms")
    assert out["authoritative_discipline"] == "Études québécoises"
    assert out["dc"]["subject"] == ["Études québécoises"]


# ---------------------------------------------------------------- uketd_dc --

def test_uketd_dc_extracts_department_as_authority():
    rec = _wrap("""
      <uketd_dc:uketd_dc xmlns:uketd_dc="http://naca.central.cranfield.ac.uk/ethos-oai/2.0/"
                          xmlns:dc="http://purl.org/dc/elements/1.1/"
                          xmlns:dcterms="http://purl.org/dc/terms/"
                          xmlns:uketdterms="http://naca.central.cranfield.ac.uk/ethos-oai/2.0/">
        <dc:title>Une thèse</dc:title>
        <dc:creator>Doe, Jane</dc:creator>
        <dc:subject>Sujet</dc:subject>
        <uketdterms:department>Département des sciences de l'éducation</uketdterms:department>
        <uketdterms:degreelevel>doctorat</uketdterms:degreelevel>
        <uketdterms:institution>UQO</uketdterms:institution>
      </uketd_dc:uketd_dc>
    """)
    out = parse_record(rec, "uketd_dc")
    assert out["authoritative_discipline"] == "Département des sciences de l'éducation"
    assert out["dc"]["title"] == ["Une thèse"]
    assert "doctorat" in out["dc"]["type"]
    assert "UQO" in out["dc"]["publisher"]


# ---------------------------------------------------------------- normalize integration --

def test_authoritative_discipline_injected_into_subjects():
    """Verify the harvest pipeline's normalize step actually sees the
    authoritative_discipline. End-to-end: parse → normalize → classify."""
    from normalize import normalize_record
    from classify import classify_discipline

    rec = _wrap("""
      <dim:dim xmlns:dim="http://www.dspace.org/xmlns/dspace/dim">
        <dim:field mdschema="dc" element="title">Meta-Unsupervised Learning: Application to NMF</dim:field>
        <dim:field mdschema="dc" element="contributor" qualifier="author">Khan, Ameer Ahmed</dim:field>
        <dim:field mdschema="dc" element="subject" qualifier="discipline">Computer Science</dim:field>
        <dim:field mdschema="thesis" element="degree" qualifier="discipline">Computer Science</dim:field>
        <dim:field mdschema="thesis" element="degree" qualifier="level">Master's</dim:field>
        <dim:field mdschema="dc" element="type">Thesis</dim:field>
        <dim:field mdschema="dc" element="description" qualifier="abstract">
          We compare with autonomous (unsupervised) learning strategies.
        </dim:field>
      </dim:dim>
    """)
    payload = parse_record(rec, "dim")
    source = {"id": "bishops", "short": "Bishop's"}
    norm = normalize_record(payload, source)
    assert norm is not None
    assert "Computer Science" in norm["subjects"]
    record_for_classifier = {
        "title": norm["title"], "subjects": norm["subjects"],
        "abstract": norm["abstract"], "publisher": norm["publisher"],
    }
    # Without the authoritative injection this would have been
    # Sciences-de-l'éducation due to "learning strategies" in the abstract.
    assert classify_discipline(record_for_classifier) == "Informatique"
