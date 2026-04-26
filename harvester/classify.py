"""Map a thesis to a canonical discipline.

This is the feature that's broken in Érudit. We use a curated
keyword → discipline map. First match wins, scanned in declared order
so more-specific disciplines (e.g. didactique) take precedence over
broader ones (e.g. éducation).

To extend: add a tuple to DISCIPLINE_RULES. Keep keywords lowercase and
without diacritics — we strip both before matching.
"""
from __future__ import annotations

import re
import unicodedata

# (canonical discipline, [keywords...])
# Order matters: scanned top-to-bottom, first hit wins.
DISCIPLINE_RULES: list[tuple[str, list[str]]] = [
    ("Sciences de l'éducation", [
        "education", "didactique", "pedagogie", "enseignement",
        "andragogie", "orthopedagogie", "psychopedagogie",
        "sciences de l'education", "education sciences",
        "educational", "teaching", "teacher", "teachers",
        "curriculum", "schooling", "literacy", "classroom",
        "study and teaching", "second language acquisition",
        "language acquisition", "instructional", "e-learning",
        "online learning", "learning strategies",
    ]),
    ("Psychologie", [
        "psychologie", "psychology", "psychanalyse", "neuropsychologie",
        "psychopathologie", "cognitive science", "sciences cognitives",
        "psychological", "psychiatric", "psychiatry", "psychiatrie",
        "mental health", "sante mentale",
        "human behavior", "human behaviour", "comportement humain",
        "social behavior", "social behaviour", "comportement social",
    ]),
    ("Sociologie", [
        "sociologie", "sociology", "sociological", "socio-",
        "social inequality", "inegalites sociales",
    ]),
    ("Anthropologie", [
        "anthropologie", "anthropology", "anthropological", "ethnologie",
        "ethnography", "ethnographie",
    ]),
    ("Science politique", [
        "science politique", "political science", "relations internationales",
        "international relations", "etudes politiques", "politics ",
        "public policy", "politiques publiques", "geopolitics",
    ]),
    ("Économie", [
        "economie", "economics", "econometrie", "econometrics",
        "economic", "economique",
    ]),
    ("Droit", [
        "droit", "law ", "jurisprudence", "juridique", " legal",
        "legislation", "constitutional",
    ]),
    ("Histoire", [
        "histoire", " history", "historical", "historiography",
        "historiographie",
    ]),
    ("Géographie", [
        "geographie", "geography", "geographic", "geographique",
        "cartographie", "cartography", "geomatique",
    ]),
    ("Philosophie", [
        "philosophie", "philosophy", "philosophical", "philosophique",
        "ethique", "ethics", "ethical", "metaphysics", "metaphysique",
    ]),
    ("Études religieuses", [
        "theologie", "theology", "theological", "etudes religieuses",
        "religious studies", "sciences des religions", "religion ",
        "biblical", "biblique",
    ]),
    ("Linguistique", [
        "linguistique", "linguistics", "linguistic", "phonologie",
        "phonology", "phonetics", "phonetique", "syntaxe", "syntax",
        "sociolinguistics", "sociolinguistique",
    ]),
    ("Littérature", [
        "litterature", "literature", "literary", "litteraire",
        "etudes litteraires", "etudes francaises", "etudes anglaises",
        "creation litteraire", "creative writing", "poetics",
        "poetique", "fiction", "narratology", "narratologie",
    ]),
    ("Communication", [
        "communication", "media studies", "etudes mediatiques",
        "journalisme", "journalism", "rhetoric", "rhetorique",
    ]),
    ("Arts visuels et médiatiques", [
        "arts visuels", "visual arts", "histoire de l'art", "art history",
        "arts mediatiques", "media arts", "design", "cinema ",
        "film studies", "etudes cinematographiques", "photography",
        "photographie",
    ]),
    ("Musique", [
        "musique", "music", "musicologie", "musicology",
        "ethnomusicologie", "ethnomusicology", "musical",
    ]),
    ("Sciences infirmières", [
        "sciences infirmieres", "nursing", "infirmier", "infirmiere",
    ]),
    ("Médecine", [
        "medecine", "medicine", "medical", "medecin", "medicale",
        "epidemiologie", "epidemiology", "pharmacologie", "pharmacology",
        "clinical", "clinique", "oncology", "oncologie",
        "cardiology", "cardiologie", "neurology", "neurologie",
        "immunology", "immunologie", "pathology", "pathologie",
        "physiology", "physiologie", "surgery", "chirurgie",
        "pediatric", "pediatrique", "rehabilitation", "readaptation",
    ]),
    ("Santé publique", [
        "sante publique", "public health", "global health",
        "sante mondiale", "epidemiology",
    ]),
    ("Kinésiologie & sciences de l'activité physique", [
        "kinesiologie", "kinesiology", "sciences de l'activite physique",
        "education physique", "physical education", "exercise science",
        "sport science", "sciences du sport",
    ]),
    ("Biologie", [
        "biologie", "biology", "biological", "biologique",
        "ecologie", "ecology", "ecological", "ecologique",
        "genetique", "genetics", "genetic", "microbiologie",
        "microbiology", "biochimie", "biochemistry", "biochemical",
        "biotechnology", "biotechnologie", "molecular biology",
        "cell biology", "biologie cellulaire", "zoology", "zoologie",
        "botany", "botanique",
    ]),
    ("Chimie", [
        "chimie", "chemistry", "chimique", "chemical",
        "organic chemistry", "inorganic chemistry",
    ]),
    ("Physique", [
        "physique", "physics", " astro", "astronomy", "astronomie",
        "astrophysics", "astrophysique", "quantum", "quantique",
    ]),
    ("Mathématiques", [
        "mathematique", "mathematics", "mathematical",
        "statistique", "statistics", "statistical",
        "probability", "probabilite",
        "algebra", "algebre",
    ]),
    ("Informatique", [
        "informatique", "computer science", "computing",
        "intelligence artificielle", "artificial intelligence",
        "data science", "apprentissage automatique", "machine learning",
        "deep learning", "reinforcement learning", "natural language processing",
        "traitement du langage", "software engineering", "genie logiciel",
    ]),
    ("Génie", [
        "genie ", "engineering", "ingenierie", "mecanique", "mechanical",
        "electrique", "electrical", "civil ", "aerospatial", "aerospace",
        "automatique", "telecommunications", "robotique", "robotics",
        "electrokinetic", "materials science", "science des materiaux",
        "manufacturing", "fabrication",
    ]),
    ("Sciences de l'environnement", [
        "environnement", "environment", "environmental",
        "developpement durable", "sustainability", "sustainable",
        "sciences de la terre", "earth sciences", "geology", "geologie",
        "climatologie", "climate", "climatique",
        "biodegradation", "pollution", "remediation", "ecotoxicologie",
        "ecotoxicology", "hydrologie", "hydrology", "oceanography",
        "oceanographie", "forestry", "foresterie", "natural resources",
        "ressources naturelles",
    ]),
    ("Administration & gestion", [
        "administration", "management", "gestion", "marketing", "finance",
        "comptabilite", "accounting", "ressources humaines",
        "human resources", "mba", "entrepreneurship", "entrepreneuriat",
        "strategy", "strategie", "operations management",
    ]),
    ("Travail social", [
        "travail social", "social work", "service social",
        "intervention sociale",
    ]),
    ("Criminologie", [
        "criminologie", "criminology", "criminal justice",
        "justice criminelle",
    ]),
    ("Urbanisme & études urbaines", [
        "urbanisme", "urban planning", "etudes urbaines", "urban studies",
        "city planning",
    ]),
    ("Architecture", ["architecture", "architectural"]),
]

OTHER = "Autre / non classé"

# Keywords too broad to be matched in abstracts: they appear frequently as
# covariates / context in unrelated theses (e.g. "education" as a control
# variable in an econometrics thesis, "art" inside "state of the art").
# These only match in the authoritative fields: title + subjects.
BROAD_KEYWORDS = frozenset({
    "education", "art", "history", "law", "design",
})


def _strip(text: str) -> str:
    """lowercase + remove diacritics, for resilient matching."""
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


def _make_pattern(kw: str) -> re.Pattern:
    if " " in kw:
        return re.compile(re.escape(kw))
    return re.compile(rf"(?:^|[^a-z]){re.escape(kw.strip())}(?:[^a-z]|$)")


# Each entry: (discipline, [(pattern, is_broad), ...]).
# A "broad" keyword only matches when it appears in title + subjects, not
# in the abstract — this is the simplest defense against incidental mentions
# (see BROAD_KEYWORDS docstring).
_compiled: list[tuple[str, list[tuple[re.Pattern, bool]]]] = [
    (
        discipline,
        [(_make_pattern(kw), kw.strip() in BROAD_KEYWORDS) for kw in keywords],
    )
    for discipline, keywords in DISCIPLINE_RULES
]


def classify_discipline(record: dict) -> str:
    """Return the canonical discipline string for a normalized thesis record."""
    primary_blob = _strip(" ".join([
        record.get("subjects") or "",
        record.get("title") or "",
        record.get("publisher") or "",
    ]))
    full_blob = primary_blob + " " + _strip(record.get("abstract") or "")
    if not full_blob.strip():
        return OTHER

    for discipline, patterns in _compiled:
        for pat, broad in patterns:
            target = primary_blob if broad else full_blob
            if pat.search(target):
                return discipline
    return OTHER
