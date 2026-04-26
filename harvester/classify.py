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
    ]),
    ("Psychologie", [
        "psychologie", "psychology", "psychanalyse", "neuropsychologie",
        "psychopathologie", "cognitive science", "sciences cognitives",
        "comportement", "behavior", "behaviour",
    ]),
    ("Sociologie", ["sociologie", "sociology", "socio-"]),
    ("Anthropologie", ["anthropologie", "anthropology", "ethnologie"]),
    ("Science politique", [
        "science politique", "political science", "relations internationales",
        "international relations", "etudes politiques",
    ]),
    ("Économie", ["economie", "economics", "econometrie", "econometrics"]),
    ("Droit", ["droit", "law ", "jurisprudence", "juridique", " legal"]),
    ("Histoire", ["histoire", " history"]),
    ("Géographie", ["geographie", "geography"]),
    ("Philosophie", ["philosophie", "philosophy", "ethique", "ethics"]),
    ("Études religieuses", [
        "theologie", "theology", "etudes religieuses", "religious studies",
        "sciences des religions",
    ]),
    ("Linguistique", ["linguistique", "linguistics", "phonologie", "syntaxe"]),
    ("Littérature", [
        "litterature", "literature", "etudes litteraires",
        "etudes francaises", "etudes anglaises", "creation litteraire",
    ]),
    ("Communication", [
        "communication", "media studies", "etudes mediatiques", "journalisme",
    ]),
    ("Arts visuels et médiatiques", [
        "arts visuels", "visual arts", "histoire de l'art", "art history",
        "arts mediatiques", "design",
    ]),
    ("Musique", ["musique", "music", "musicologie", "ethnomusicologie"]),
    ("Sciences infirmières", ["sciences infirmieres", "nursing"]),
    ("Médecine", [
        "medecine", "medicine", "medical", "epidemiologie", "epidemiology",
        "pharmacologie", "pharmacology",
    ]),
    ("Santé publique", ["sante publique", "public health"]),
    ("Kinésiologie & sciences de l'activité physique", [
        "kinesiologie", "kinesiology", "sciences de l'activite physique",
        "education physique",
    ]),
    ("Biologie", [
        "biologie", "biology", "ecologie", "ecology", "genetique", "genetics",
        "microbiologie", "biochimie", "biochemistry",
    ]),
    ("Chimie", ["chimie", "chemistry", "chimique"]),
    ("Physique", ["physique", "physics", " astro"]),
    ("Mathématiques", ["mathematique", "mathematics", "statistique", "statistics"]),
    ("Informatique", [
        "informatique", "computer science", "computing", "intelligence artificielle",
        "artificial intelligence", "data science", "apprentissage automatique",
    ]),
    ("Génie", [
        "genie ", "engineering", "ingenierie", "mecanique", "electrique",
        "civil ", "aerospatial", "aerospace", "automatique",
        "telecommunications", "robotique", "robotics",
        "electrokinetic",
    ]),
    ("Sciences de l'environnement", [
        "environnement", "environment", "developpement durable", "sustainability",
        "sciences de la terre", "earth sciences", "climatologie", "climate",
        "biodegradation", "pollution", "remediation", "ecotoxicologie",
        "hydrologie", "hydrology",
    ]),
    ("Administration & gestion", [
        "administration", "management", "gestion", "marketing", "finance",
        "comptabilite", "accounting", "ressources humaines", "mba",
    ]),
    ("Travail social", ["travail social", "social work", "service social"]),
    ("Criminologie", ["criminologie", "criminology"]),
    ("Urbanisme & études urbaines", ["urbanisme", "urban planning", "etudes urbaines"]),
    ("Architecture", ["architecture"]),
]

OTHER = "Autre / non classé"


def _strip(text: str) -> str:
    """lowercase + remove diacritics, for resilient matching."""
    if not text:
        return ""
    nfkd = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c))


# Pre-compile regexes for word-boundary matching where the keyword
# doesn't already contain a leading/trailing space.
_compiled: list[tuple[str, list[re.Pattern]]] = [
    (
        discipline,
        [re.compile(rf"(?:^|[^a-z]){re.escape(kw.strip())}(?:[^a-z]|$)")
         if " " not in kw else re.compile(re.escape(kw))
         for kw in keywords],
    )
    for discipline, keywords in DISCIPLINE_RULES
]


def classify_discipline(record: dict) -> str:
    """Return the canonical discipline string for a normalized thesis record."""
    blob = _strip(" ".join([
        record.get("subjects") or "",
        record.get("title") or "",
        record.get("publisher") or "",
        record.get("abstract") or "",
    ]))
    if not blob:
        return OTHER

    for discipline, patterns in _compiled:
        for pat in patterns:
            if pat.search(blob):
                return discipline
    return OTHER
