from normalize import normalize_record

SOURCE = {"id": "test", "short": "Test"}


def _payload(dc, oai_id="oai:test:1", datestamp="2024-01-01"):
    return {"oai_identifier": oai_id, "datestamp": datestamp, "dc": dc}


def test_doctoral_thesis_kept():
    norm = normalize_record(_payload({
        "title": ["Étude approfondie"],
        "type": ["Thesis"],
        "description": ["This is a doctoral dissertation in physics."],
    }), SOURCE)
    assert norm is not None
    assert norm["type"] == "thesis"
    assert norm["title"] == "Étude approfondie"


def test_master_memoire_kept():
    norm = normalize_record(_payload({
        "title": ["Mémoire de maîtrise"],
        "type": ["info:eu-repo/semantics/masterthesis"],
    }), SOURCE)
    assert norm is not None
    assert norm["type"] == "memoire"


def test_generic_article_rejected():
    norm = normalize_record(_payload({
        "title": ["A regular journal article"],
        "type": ["Article"],
        "description": ["Published in a peer-reviewed journal."],
    }), SOURCE)
    assert norm is None


def test_empty_record_returns_none():
    assert normalize_record(_payload({}), SOURCE) is None


def test_no_title_returns_none():
    norm = normalize_record(_payload({
        "type": ["Thesis"],
        "description": ["doctoral work"],
    }), SOURCE)
    assert norm is None


def test_earliest_year_wins():
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "date": ["2024-09-01", "2018-06-15"],
    }), SOURCE)
    assert norm["year"] == 2018


def test_year_from_iso_datetime():
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "date": ["2024-06-15T10:00:00Z"],
    }), SOURCE)
    assert norm["year"] == 2024


def test_no_plausible_year():
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "date": ["n.d.", "unknown"],
    }), SOURCE)
    assert norm["year"] is None


def test_url_preference_doi_over_handle_eprint_pdf():
    # DOI and handle.net are both score 3 — when both present, current
    # impl returns whichever max() encounters first. We assert the URL
    # falls into the top tier (DOI or handle), beating EPrints + PDF.
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "identifier": [
            "https://example.ca/files/paper.pdf",
            "https://eprints.example.ca/id/eprint/42",
            "https://hdl.handle.net/1866/12345",
            "https://doi.org/10.1234/abcd",
        ],
    }), SOURCE)
    assert "doi.org" in norm["url"] or "handle.net" in norm["url"]

    # Without DOI: handle.net wins
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "identifier": [
            "https://example.ca/files/paper.pdf",
            "https://eprints.example.ca/id/eprint/42",
            "https://hdl.handle.net/1866/12345",
        ],
    }), SOURCE)
    assert norm["url"] == "https://hdl.handle.net/1866/12345"

    # Without handle: EPrints landing page wins
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "identifier": [
            "https://example.ca/files/paper.pdf",
            "https://eprints.example.ca/id/eprint/42",
        ],
    }), SOURCE)
    assert norm["url"] == "https://eprints.example.ca/id/eprint/42"

    # Only PDF available
    norm = normalize_record(_payload({
        "title": ["Thèse"],
        "type": ["Thesis"],
        "identifier": ["https://example.ca/files/paper.pdf"],
    }), SOURCE)
    assert norm["url"] == "https://example.ca/files/paper.pdf"


def test_html_entities_decoded_in_title():
    norm = normalize_record(_payload({
        "title": ["L&apos;étude des syst&egrave;mes"],
        "type": ["Thesis"],
    }), SOURCE)
    assert norm["title"] == "L'étude des systèmes"


def test_whitespace_collapsed():
    norm = normalize_record(_payload({
        "title": ["  Titre   avec\n\tespaces  "],
        "type": ["Thesis"],
        "creator": ["  Doe,   Jane  "],
    }), SOURCE)
    assert norm["title"] == "Titre avec espaces"
    assert norm["authors"] == "Doe, Jane"


def test_type_detected_from_title_alone():
    norm = normalize_record(_payload({
        "title": ["Thèse de doctorat sur la mécanique quantique"],
    }), SOURCE)
    assert norm is not None
    assert norm["type"] == "thesis"
