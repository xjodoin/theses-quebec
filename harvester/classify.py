"""Map a thesis to a canonical discipline.

This is the feature that's broken in Érudit. We use a curated
keyword → discipline map. First match wins, scanned in declared order
so more-specific disciplines (e.g. didactique) take precedence over
broader ones (e.g. éducation).

To extend: add a tuple to DISCIPLINE_RULES. Keep keywords lowercase and
without diacritics — we strip both before matching.

Taxonomy aligned with Érudit's published discipline filter (see
www.erudit.org). We keep a flat list (no hierarchy in DB) but cluster
related entries with comments. Specific subcategories MUST appear
before parent disciplines so they win the first-match scan.
"""
from __future__ import annotations

import re
import unicodedata

# (canonical discipline, [keywords...])
# Order matters: scanned top-to-bottom, first hit wins.
DISCIPLINE_RULES: list[tuple[str, list[str]]] = [
    # --- Éducation ---
    ("Didactique", [
        "didactique", "didactic", "didactics",
        "didactique des mathematiques", "didactique des sciences",
        "didactique des langues", "subject teaching",
    ]),
    ("Sciences de l'éducation", [
        "education", "pedagogie", "enseignement",
        "andragogie", "orthopedagogie", "psychopedagogie",
        "sciences de l'education", "education sciences",
        "educational", "teaching", "teacher", "teachers",
        "curriculum", "schooling", "literacy", "classroom",
        "study and teaching", "second language acquisition",
        "language acquisition", "instructional", "e-learning",
        "online learning", "learning strategies",
    ]),

    # --- Psychologie & sciences cognitives ---
    ("Neurosciences", [
        "neurosciences", "neuroscience", "neurobiologie", "neurobiology",
        "neuroimagerie", "neuroimaging", "neural circuits",
        "circuits neuronaux", "cognitive neuroscience",
        "neurosciences cognitives", "synaptic",
    ]),
    ("Psychologie", [
        "psychologie", "psychology", "psychanalyse", "neuropsychologie",
        "psychopathologie", "cognitive science", "sciences cognitives",
        "psychological", "psychiatric", "psychiatry", "psychiatrie",
        "mental health", "sante mentale",
        "human behavior", "human behaviour", "comportement humain",
        "social behavior", "social behaviour", "comportement social",
    ]),

    # --- Sciences sociales ---
    ("Démographie", [
        "demographie", "demography", "demographic", "demographique",
        "population studies", "etudes de la population",
        "natalite", "mortality rate", "taux de mortalite",
        "migrations humaines", "human migration", "etudes migratoires",
        "migration studies",
    ]),
    ("Études féministes / études de genre", [
        "etudes feministes", "feminist studies", "feminism", "feminisme",
        "etudes de genre", "gender studies", "gender ", "gendered",
        "women's studies", "etudes des femmes", "queer studies",
        "etudes queer",
    ]),
    ("Études autochtones", [
        "etudes autochtones", "indigenous studies", "autochtone", "autochtones",
        "first nations", "premieres nations", "inuit", "metis",
        "decolonization", "decolonisation", "native studies",
    ]),
    ("Études québécoises", [
        "etudes quebecoises", "quebec studies",
        "histoire du quebec", "litterature quebecoise",
        "culture quebecoise", "societe quebecoise",
        "identite quebecoise", "souverainete du quebec",
        "quebec sovereignty",
    ]),
    ("Sociologie", [
        "sociologie", "sociology", "sociological", "socio-",
        "social inequality", "inegalites sociales",
    ]),
    ("Anthropologie", [
        "anthropologie", "anthropology", "anthropological", "ethnologie",
        "ethnography", "ethnographie", "ethnology",
    ]),
    ("Archéologie", [
        "archeologie", "archaeology", "archeologique", "archaeological",
        "prehistory", "prehistoire", "fouille archeologique",
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
    ("Relations industrielles", [
        "relations industrielles", "industrial relations",
        "labour relations", "labor relations", "relations de travail",
    ]),
    ("Travail social", [
        "travail social", "social work", "service social",
        "intervention sociale",
    ]),
    ("Criminologie", [
        "criminologie", "criminology", "criminal justice",
        "justice criminelle", "delinquance",
    ]),

    # --- Droit ---
    ("Droit", [
        "droit", "law ", "jurisprudence", "juridique", " legal",
        "legislation", "constitutional", "droit civil",
        "droit international", "droit penal", "droit du travail",
    ]),

    # --- Histoire & humanités ---
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

    # --- Lettres et langues ---
    ("Linguistique", [
        "linguistique", "linguistics", "linguistic", "phonologie",
        "phonology", "phonetics", "phonetique", "syntaxe", "syntax",
        "sociolinguistics", "sociolinguistique", "morphology", "morphologie",
        "semantics", "semantique",
    ]),
    ("Traduction", [
        "traduction", "translation studies", "traductologie",
        "translation", "translatology", "interpretation ",
    ]),
    ("Littérature", [
        "litterature", "literature", "literary", "litteraire",
        "etudes litteraires", "etudes francaises", "etudes anglaises",
        "creation litteraire", "creative writing", "poetics",
        "poetique", "fiction", "narratology", "narratologie",
    ]),

    # --- Communication & médias ---
    ("Études cinématographiques", [
        "etudes cinematographiques", "film studies", "cinema ",
        "cinematographique", "film theory", "etudes filmiques",
    ]),
    ("Communication", [
        "communication", "media studies", "etudes mediatiques",
        "journalisme", "journalism", "rhetoric", "rhetorique",
    ]),

    # --- Arts ---
    ("Musique", [
        "musique", "music", "musicologie", "musicology",
        "ethnomusicologie", "ethnomusicology", "musical",
    ]),
    ("Théâtre / arts de la scène", [
        "theatre", "theater", "performing arts", "arts de la scene",
        "dramaturgie", "dramaturgy", "scenographie",
    ]),
    ("Danse", [
        "danse", "dance", "choregraphie", "choreography", "ballet",
    ]),
    ("Design", [
        "design industriel", "industrial design", "design graphique",
        "graphic design", "design d'interieur", "interior design",
        "design de mode", "fashion design", "ux design",
    ]),
    ("Arts visuels et médiatiques", [
        "arts visuels", "visual arts", "histoire de l'art", "art history",
        "arts mediatiques", "media arts", "design", "photography",
        "photographie", "sculpture", "peinture",
    ]),

    # --- Santé ---
    ("Sciences pharmaceutiques", [
        "sciences pharmaceutiques", "pharmaceutical sciences",
        "pharmacie", "pharmacy", "pharmacology", "pharmacologie",
        "pharmaceutique", "pharmaceutical", "drug discovery",
        "drug delivery",
    ]),
    ("Sciences infirmières", [
        "sciences infirmieres", "nursing", "infirmier", "infirmiere",
    ]),
    ("Santé publique", [
        "sante publique", "public health", "global health",
        "sante mondiale", "epidemiologie", "epidemiology",
        "promotion de la sante", "health promotion",
    ]),
    ("Kinésiologie & sciences de l'activité physique", [
        "kinesiologie", "kinesiology", "sciences de l'activite physique",
        "education physique", "physical education", "exercise science",
        "sport science", "sciences du sport",
    ]),
    ("Nutrition", [
        "nutrition", "dietetique", "dietetics", "nutritional", "alimentation",
        "food science", "sciences des aliments", "nutritionnel",
    ]),
    ("Sciences de la réadaptation", [
        "readaptation", "rehabilitation", "physiotherapie", "physiotherapy",
        "ergotherapie", "occupational therapy", "orthophonie",
        "speech therapy", "audiologie", "audiology",
    ]),
    ("Médecine dentaire", [
        "medecine dentaire", "dentistry", "dentaire", "dental",
        "odontologie", "orthodontie", "orthodontics",
    ]),
    ("Médecine vétérinaire", [
        "medecine veterinaire", "veterinary medicine", "veterinaire",
        "veterinary",
    ]),
    ("Médecine", [
        "medecine", "medicine", "medical", "medecin", "medicale",
        "clinical", "clinique", "oncology", "oncologie",
        "cardiology", "cardiologie", "neurology", "neurologie",
        "immunology", "immunologie", "pathology", "pathologie",
        "physiology", "physiologie", "surgery", "chirurgie",
        "pediatric", "pediatrique",
    ]),

    # --- Sciences de la vie ---
    ("Biologie cellulaire et moléculaire", [
        "biologie cellulaire", "cell biology", "biologie moleculaire",
        "molecular biology", "biochimie", "biochemistry", "biochemical",
        "proteomique", "proteomics", "genomique", "genomics",
    ]),
    ("Génétique", [
        "genetique", "genetics", "genetic", "genome", "epigenetique",
        "epigenetics", "heredite", "heredity",
    ]),
    ("Microbiologie", [
        "microbiologie", "microbiology", "microbial", "bacteriologie",
        "bacteriology", "virologie", "virology", "mycologie",
    ]),
    ("Biotechnologie", [
        "biotechnologie", "biotechnology", "bioingenierie", "bioengineering",
        "bioinformatique", "bioinformatics",
    ]),
    ("Biologie", [
        "biologie", "biology", "biological", "biologique",
        "zoology", "zoologie", "botany", "botanique",
        "physiologie animale", "physiologie vegetale",
    ]),

    # --- Sciences de l'environnement ---
    ("Écologie", [
        "ecologie", "ecology", "ecological", "ecologique",
        "biodiversite", "biodiversity", "ecosysteme", "ecosystem",
        "ecotoxicologie", "ecotoxicology",
    ]),
    ("Foresterie", [
        "foresterie", "forestry", "sciences forestieres", "forest science",
        "sylviculture", "silviculture",
    ]),
    ("Sciences de la Terre", [
        "sciences de la terre", "earth sciences", "geology", "geologie",
        "geologique", "mineralogie", "mineralogy", "petrologie",
        "geophysique", "geophysics", "sismologie", "seismology",
    ]),
    ("Climatologie", [
        "climatologie", "climate", "climatique", "changement climatique",
        "climate change", "meteorologie", "meteorology",
    ]),
    ("Hydrologie & océanographie", [
        "hydrologie", "hydrology", "oceanography", "oceanographie",
        "limnologie", "limnology", "ressources en eau", "water resources",
    ]),
    ("Sciences de l'environnement", [
        "environnement", "environment", "environmental",
        "developpement durable", "sustainability", "sustainable",
        "pollution", "remediation", "biodegradation",
        "natural resources", "ressources naturelles",
    ]),

    # --- Sciences exactes ---
    ("Astronomie & astrophysique", [
        " astro", "astronomy", "astronomie",
        "astrophysics", "astrophysique", "cosmology", "cosmologie",
    ]),
    ("Chimie", [
        "chimie", "chemistry", "chimique", "chemical",
        "organic chemistry", "inorganic chemistry", "catalyse", "catalysis",
    ]),
    ("Physique", [
        "physique", "physics", "quantum", "quantique", "particle physics",
        "physique des particules", "matiere condensee", "condensed matter",
        "optique", "optics", "photonique", "photonics",
    ]),
    ("Statistique", [
        "statistique", "statistics", "statistical",
        "probability", "probabilite", "biostatistique", "biostatistics",
        "stochastic", "stochastique",
    ]),
    ("Mathématiques", [
        "mathematique", "mathematics", "mathematical",
        "algebra", "algebre", "topology", "topologie",
        "analyse mathematique", "geometrie", "geometry",
    ]),

    # --- Informatique ---
    ("Intelligence artificielle & apprentissage automatique", [
        "intelligence artificielle", "artificial intelligence",
        "apprentissage automatique", "machine learning",
        "deep learning", "apprentissage profond",
        "reinforcement learning", "natural language processing",
        "traitement du langage", "computer vision", "vision par ordinateur",
        "neural network", "reseau de neurones",
    ]),
    ("Informatique", [
        "informatique", "computer science", "computing",
        "data science", "science des donnees",
        "software engineering", "genie logiciel", "algorithmique",
        "algorithms", "cybersecurity", "cybersecurite",
        "base de donnees", "databases",
    ]),

    # --- Génie ---
    ("Génie civil", [
        "genie civil", "civil engineering", "structures",
        "geotechnique", "geotechnical", "transportation engineering",
        "genie des transports", "construction",
    ]),
    ("Génie mécanique", [
        "genie mecanique", "mechanical engineering", "mecanique des fluides",
        "fluid mechanics", "thermodynamique", "thermodynamics",
    ]),
    ("Génie électrique", [
        "genie electrique", "electrical engineering", "electronique",
        "electronics", "puissance electrique", "power electronics",
        "telecommunications", "telecommunication",
    ]),
    ("Génie chimique", [
        "genie chimique", "chemical engineering", "procedes chimiques",
        "chemical processes",
    ]),
    ("Génie biomédical", [
        "genie biomedical", "biomedical engineering", "biomedical devices",
        "ingenierie tissulaire", "tissue engineering",
    ]),
    ("Génie aérospatial", [
        "genie aerospatial", "aerospace engineering", "aeronautique",
        "aeronautics", "aerospace",
    ]),
    ("Génie industriel", [
        "genie industriel", "industrial engineering", "ingenierie industrielle",
        "operations research", "recherche operationnelle",
    ]),
    ("Science des matériaux", [
        "science des materiaux", "materials science", "materials engineering",
        "genie des materiaux", "metallurgie", "metallurgy", "polymeres",
        "polymers", "nanomateriaux", "nanomaterials",
    ]),
    ("Génie", [
        "genie ", "engineering", "ingenierie", "automatique",
        "robotique", "robotics", "manufacturing", "fabrication",
        "mecatronique", "mechatronics",
    ]),

    # --- Études urbaines & architecture ---
    ("Urbanisme & études urbaines", [
        "urbanisme", "urban planning", "etudes urbaines", "urban studies",
        "city planning", "amenagement du territoire",
    ]),
    ("Architecture", [
        "architecture", "architectural",
    ]),

    # --- Administration ---
    ("Comptabilité", [
        "comptabilite", "accounting", "audit ", "fiscalite", "taxation",
    ]),
    ("Finance", [
        "finance", "financial", "financiere", "actuariat", "actuarial",
        "investment", "investissement", "banking", "bancaire",
    ]),
    ("Marketing", [
        "marketing", "consumer behavior", "comportement du consommateur",
        "branding", "publicite", "advertising",
    ]),
    ("Ressources humaines", [
        "ressources humaines", "human resources", "grh ",
        "gestion des ressources humaines",
    ]),
    ("Administration & gestion", [
        "administration", "management", "gestion", "mba",
        "entrepreneurship", "entrepreneuriat",
        "strategy", "strategie", "operations management",
        "sciences de la gestion",
    ]),
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
