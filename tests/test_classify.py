from classify import classify_discipline, OTHER, DISCIPLINE_RULES


def _rec(title="", subjects="", abstract="", publisher=""):
    return {"title": title, "subjects": subjects,
            "abstract": abstract, "publisher": publisher}


def test_didactique_beats_education():
    # Both keywords are in the same rule (Sciences de l'éducation),
    # but didactique appearing should still resolve to that bucket
    # ahead of any broader hit.
    assert classify_discipline(_rec(title="Didactique des mathématiques")) \
        == "Sciences de l'éducation"


def test_psychologie_cognitive():
    assert classify_discipline(_rec(title="Étude en psychologie cognitive")) \
        == "Psychologie"


def test_diacritics_ignored():
    # "ecologie" (no accent) must match keyword "ecologie" in Biologie
    # (Sciences de l'environnement does not contain "ecologie"; it has
    # "environnement", "ecotoxicologie" etc.)
    got = classify_discipline(_rec(title="Étude en ecologie microbienne"))
    assert got == "Biologie"


def test_empty_record_returns_other():
    assert classify_discipline(_rec()) == OTHER
    assert classify_discipline({}) == OTHER


def test_title_only_signal():
    assert classify_discipline(_rec(title="Approche en sociologie urbaine")) \
        == "Sociologie"


def test_subjects_only_signal():
    assert classify_discipline(_rec(subjects="informatique; algorithmes")) \
        == "Informatique"


def test_first_rule_wins_ordering():
    # "education" appears in rule 1 (Sciences de l'éducation) and the
    # record also mentions "psychologie" (rule 2). Rule 1 must win.
    rec = _rec(title="Sciences de l'éducation et psychologie scolaire")
    assert classify_discipline(rec) == "Sciences de l'éducation"


def test_no_false_positive_on_generic_word():
    # "art" alone (e.g. inside "partie", "départ") shouldn't classify as
    # Arts visuels — that rule only matches multi-word keywords.
    rec = _rec(title="La participation citoyenne au départ",
               abstract="cette partie traite de l'art de la délibération")
    assert classify_discipline(rec) != "Arts visuels et médiatiques"
