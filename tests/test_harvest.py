from xml.etree import ElementTree as ET

from harvest import record_to_dict

OAI_NS = "http://www.openarchives.org/OAI/2.0/"
DC_NS = "http://purl.org/dc/elements/1.1/"
OAI_DC_NS = "http://www.openarchives.org/OAI/2.0/oai_dc/"


def _build_record(*, deleted=False, creators=None, title="A thesis",
                  extra_fields=None):
    record = ET.Element(f"{{{OAI_NS}}}record")
    header = ET.SubElement(record, f"{{{OAI_NS}}}header")
    if deleted:
        header.set("status", "deleted")
    ET.SubElement(header, f"{{{OAI_NS}}}identifier").text = "oai:test:1"
    ET.SubElement(header, f"{{{OAI_NS}}}datestamp").text = "2024-01-01"

    metadata = ET.SubElement(record, f"{{{OAI_NS}}}metadata")
    dc = ET.SubElement(metadata, f"{{{OAI_DC_NS}}}dc")
    if title is not None:
        ET.SubElement(dc, f"{{{DC_NS}}}title").text = title
    for c in (creators or []):
        ET.SubElement(dc, f"{{{DC_NS}}}creator").text = c
    for tag, value in (extra_fields or []):
        ET.SubElement(dc, f"{{{DC_NS}}}{tag}").text = value
    return record


def test_minimal_valid_record_parses():
    rec = _build_record(creators=["Doe, Jane"],
                        extra_fields=[("type", "Thesis")])
    out = record_to_dict(rec)
    assert out["oai_identifier"] == "oai:test:1"
    assert out["datestamp"] == "2024-01-01"
    assert out["dc"]["title"] == ["A thesis"]
    assert out["dc"]["creator"] == ["Doe, Jane"]
    assert out["dc"]["type"] == ["Thesis"]


def test_deleted_record_signals_deletion():
    """Tombstones must surface so the harvester can remove them from the DB,
    not silently get dropped as malformed."""
    rec = _build_record(deleted=True)
    out = record_to_dict(rec)
    assert out == {"_deleted": True, "oai_identifier": "oai:test:1"}


def test_multivalued_creator_collected_as_list():
    rec = _build_record(creators=["Doe, Jane", "Roe, John", "Tremblay, Marie"])
    out = record_to_dict(rec)
    assert out["dc"]["creator"] == ["Doe, Jane", "Roe, John", "Tremblay, Marie"]


def test_whitespace_only_fields_dropped():
    rec = _build_record(extra_fields=[
        ("subject", "   "),
        ("subject", "physics"),
        ("description", "\n\t  \n"),
    ])
    out = record_to_dict(rec)
    assert out["dc"]["subject"] == ["physics"]
    assert "description" not in out["dc"]
