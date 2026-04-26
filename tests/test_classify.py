from classify import classify_discipline, OTHER, DISCIPLINE_RULES


def _rec(title="", subjects="", abstract="", publisher=""):
    return {"title": title, "subjects": subjects,
            "abstract": abstract, "publisher": publisher}


def test_didactique_beats_education():
    # "didactique" is its own canonical discipline and must take precedence
    # over the broader "Sciences de l'éducation" bucket.
    assert classify_discipline(_rec(title="Didactique des mathématiques")) \
        == "Didactique"


def test_psychologie_cognitive():
    assert classify_discipline(_rec(title="Étude en psychologie cognitive")) \
        == "Psychologie"


def test_diacritics_ignored():
    # "ecologie" (no accent) must match the "Écologie" rule keyword "ecologie"
    # — confirms diacritic stripping works.
    got = classify_discipline(_rec(title="Étude en écologie microbienne"))
    assert got == "Écologie"


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
    # Specific sub-category must beat parent "Génie".
    assert classify_discipline(_rec(subjects="Mechanical engineering")) \
        == "Génie mécanique"


def test_english_clinical_oncology():
    assert classify_discipline(_rec(title="A clinical oncology trial")) \
        == "Médecine"


def test_ml_thesis_with_learning_strategies_in_abstract_not_education():
    """Real bug: a CS/ML thesis on NMF was tagged Sciences de l'éducation
    because its abstract mentioned 'autonomous (unsupervised) learning
    strategies'. AI/ML keywords in title+subjects must win."""
    record = _rec(
        title="Meta-Unsupervised Learning: Application to Non-Negative Matrix Factorization",
        subjects="Machine Learning; Matrix Factorization; Dimensionality reduction; Computer Science",
        abstract=(
            "Meta-learning was initially developed for supervised learning... "
            "we apply it to non-negative matrix factorization (NMF), a widely "
            "used technique. We compare with autonomous (unsupervised) "
            "learning strategies. The source code is available."
        ),
        publisher="Bishop's University",
    )
    got = classify_discipline(record)
    assert got == "Intelligence artificielle & apprentissage automatique", got


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


def test_genie_civil_beats_generic_genie():
    # Specific subcategory must win over the catch-all "Génie".
    assert classify_discipline(_rec(subjects="Génie civil; Structures")) \
        == "Génie civil"


def test_genie_electrique_beats_generic_genie():
    assert classify_discipline(_rec(title="Optimisation en génie électrique")) \
        == "Génie électrique"


def test_sciences_pharmaceutiques_beats_medecine():
    # "pharmacologie" used to live inside Médecine; now it's its own bucket.
    assert classify_discipline(_rec(subjects="Pharmacologie; Drug delivery")) \
        == "Sciences pharmaceutiques"


def test_neurosciences_beats_psychologie():
    assert classify_discipline(_rec(title="Neuroimagerie des circuits neuronaux")) \
        == "Neurosciences"


def test_etudes_feministes():
    assert classify_discipline(_rec(subjects="Études féministes; Gender studies")) \
        == "Études féministes / études de genre"


def test_etudes_autochtones():
    assert classify_discipline(_rec(title="Souveraineté des Premières Nations au Canada")) \
        == "Études autochtones"


def test_demographie():
    assert classify_discipline(_rec(subjects="Démographie; Fécondité")) \
        == "Démographie"


def test_traduction():
    assert classify_discipline(_rec(title="Étude en traductologie comparée")) \
        == "Traduction"


def test_etudes_cinematographiques():
    assert classify_discipline(_rec(subjects="Études cinématographiques; Film theory")) \
        == "Études cinématographiques"


def test_archeologie():
    assert classify_discipline(_rec(subjects="Archéologie préhistorique")) \
        == "Archéologie"


def test_finance_beats_administration():
    assert classify_discipline(_rec(subjects="Finance; Investissement")) \
        == "Finance"


def test_intelligence_artificielle_beats_informatique():
    assert classify_discipline(_rec(title="Apprentissage profond pour la vision par ordinateur")) \
        == "Intelligence artificielle & apprentissage automatique"


def test_climatologie_beats_environnement():
    assert classify_discipline(_rec(title="Modélisation du changement climatique")) \
        == "Climatologie"


def test_genetique_beats_biologie():
    assert classify_discipline(_rec(subjects="Génétique humaine; Hérédité")) \
        == "Génétique"


def test_broad_keyword_history_in_abstract_does_not_misclassify():
    """'history' appearing in abstract must NOT trigger Histoire when
    title+subjects make the real discipline obvious."""
    record = _rec(
        title="Modèles bayésiens pour la prédiction génomique",
        subjects="Statistique bayésienne; Génétique",
        abstract="We review the history of Bayesian methods in statistics.",
    )
    # The exact target depends on rule order (Biologie wins via 'génétique');
    # what matters is the result is NOT Histoire.
    assert classify_discipline(record) != "Histoire"
