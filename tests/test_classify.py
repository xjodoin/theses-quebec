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


def test_english_subject_education_only():
    # McGill-style: English subject 'Education' must hit Sciences de l'éducation
    # rather than fall through to OTHER.
    assert classify_discipline(_rec(subjects="Education")) \
        == "Sciences de l'éducation"


def test_english_curriculum_keyword():
    assert classify_discipline(_rec(title="A study of curriculum design")) \
        == "Sciences de l'éducation"


def test_english_literacy_keyword():
    assert classify_discipline(_rec(subjects="Literacy intervention; Reading")) \
        == "Sciences de l'éducation"


def test_english_teaching_keyword():
    assert classify_discipline(_rec(subjects="English language -- Study and teaching")) \
        == "Sciences de l'éducation"


def test_english_psychology_mental_health():
    assert classify_discipline(_rec(title="Mental health interventions")) \
        == "Psychologie"


def test_english_sociology_subject():
    assert classify_discipline(_rec(subjects="Rural sociology")) \
        == "Sociologie"


def test_english_biology_zoology():
    assert classify_discipline(_rec(subjects="Zoology; Marine biology")) \
        == "Biologie"


def test_english_chemistry():
    assert classify_discipline(_rec(title="Organic chemistry of natural products")) \
        == "Chimie"


def test_english_engineering_mechanical():
    assert classify_discipline(_rec(subjects="Mechanical engineering")) \
        == "Génie"


def test_english_clinical_oncology():
    assert classify_discipline(_rec(title="A clinical oncology trial")) \
        == "Médecine"


def test_broad_keyword_education_in_abstract_does_not_misclassify():
    """Real bug from user feedback: an econometrics thesis with 'éducation' as
    a covariate in its abstract was tagged Sciences de l'éducation."""
    record = _rec(
        title="Essays in applied microeconometrics with risk-taking and savings",
        subjects="Microéconomie; Économétrie; Épargne",
        abstract=(
            "Cette thèse présente trois chapitres en microéconométrie. "
            "Conditionnant sur des variables observables comme l'éducation "
            "et le genre, suggérant des réseaux liés à la capacité cognitive."
        ),
    )
    assert classify_discipline(record) == "Économie"


def test_broad_keyword_education_still_works_in_title():
    record = _rec(title="L'éducation préscolaire au Québec")
    assert classify_discipline(record) == "Sciences de l'éducation"


def test_broad_keyword_history_in_abstract_does_not_misclassify():
    record = _rec(
        title="Modèles bayésiens pour la prédiction génomique",
        subjects="Statistique bayésienne; Génétique",
        abstract="We review the history of Bayesian methods in statistics.",
    )
    # Subjects has 'genetique', 'statistique' — Mathématiques wins via 'statistique'.
    assert classify_discipline(record) == "Mathématiques"
