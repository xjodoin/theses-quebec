# Thèses du Québec

> Recherche unifiée des thèses et mémoires des universités québécoises,
> avec **vraie recherche par discipline** — la fonctionnalité qui manque
> à Érudit.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue)](https://www.python.org/)
[![Status](https://img.shields.io/badge/status-prototype-orange)](#statut--limites)
[![Records](https://img.shields.io/badge/records-5%2C002-success)]()
[![Sources](https://img.shields.io/badge/sources-13%20d%C3%A9p%C3%B4ts-success)]()

5 002 thèses et mémoires moissonnés depuis 13 dépôts institutionnels (Concordia,
McGill, UdeM, Sherbrooke, Bishop's, Laval, le réseau UQ, INRS, ÉTS), classés
dans 33 disciplines canoniques, indexés en plein texte avec facettes par
université, type, année et discipline.

![Capture de l'agrégateur — recherche par discipline](v3-after-llm.png)

---

## Sommaire

- [Pourquoi ce projet](#pourquoi-ce-projet)
- [Architecture](#architecture)
- [Démarrage rapide](#démarrage-rapide)
- [Moissonner les dépôts](#moissonner-les-dépôts)
- [Classificateur LLM (Gemini 3 Flash)](#classificateur-llm-gemini-3-flash)
- [Structure du projet](#structure-du-projet)
- [Configuration (.env)](#configuration-env)
- [Déploiement](#déploiement)
- [Statut & limites](#statut--limites)
- [Contribuer](#contribuer)
- [Licence](#licence)
- [Remerciements](#remerciements)

---

## Pourquoi ce projet

Érudit indexe les thèses québécoises mais sa **recherche par discipline ne
fonctionne pas vraiment** : taper « éducation » dans le filtre disciplinaire
ne retourne pas de manière fiable les thèses en sciences de l'éducation, parce
que chaque université renseigne ses métadonnées Dublin Core différemment
(« sciences de l'éducation » vs « éducation » vs « didactique »).

Ce projet :

1. **Moissonne** les métadonnées via OAI-PMH (le protocole standard que tous
   les dépôts EPrints / DSpace / Hyrax exposent).
2. **Normalise** Dublin Core dans un schéma commun.
3. **Classe** chaque thèse dans une discipline canonique (33 catégories) via
   un classificateur règle-base + un classificateur LLM (Gemini 3 Flash) en
   batch pour le résidu.
4. **Indexe** en SQLite FTS5 avec facettes.
5. **Expose** une API REST + une interface web sobre (Tailwind, vanilla JS).

Résultat : 28,6 % de thèses non classées par les règles → **0,02 %** après le
batch LLM.

---

## Architecture

```
                ┌──────────────────────────────────┐
                │  13 dépôts institutionnels QC    │
                │  (EPrints · DSpace · Hyrax)      │
                └────────────────┬─────────────────┘
                                 │  OAI-PMH 2.0
                                 │  + Playwright (McGill, Azure WAF)
                                 ▼
                    ┌─────────────────────────┐
                    │   harvester/            │
                    │   ├ harvest.py          │  Dublin Core
                    │   ├ normalize.py        │  schéma unifié
                    │   ├ classify.py         │  règles (~71 %)
                    │   └ llm_classify.py     │  Gemini 3 (le résidu)
                    └────────────┬────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │   data/theses.db        │  SQLite + FTS5
                    └────────────┬────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │   api/app.py            │  FastAPI
                    │   /api/search · facets  │
                    └────────────┬────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │   web/index.html        │  Tailwind + vanilla JS
                    └─────────────────────────┘
```

| Composant | Pile | Pourquoi |
|---|---|---|
| Moissonneur | Python + `requests` + Playwright | OAI-PMH partout sauf McGill (WAF Azure → vraie session navigateur) |
| Index | SQLite **FTS5** | Aucun service externe ; sub-50 ms pour 5 k records ; tokenizer `unicode61 remove_diacritics` |
| Classification | Règles + Gemini 3 Flash batch | Règles couvrent les cas faciles ; LLM résout le résidu (titres opaques sans abstract) |
| API | FastAPI | Auto-doc OpenAPI sur `/docs` |
| UI | Tailwind CDN, vanilla JS | Aucun build, déploiement = `cp` |

---

## Démarrage rapide

```bash
# 1. Cloner (avec LFS — la DB de 24 Mo se télécharge automatiquement)
git lfs install                                  # une fois par machine
git clone https://github.com/xjodoin/theses-quebec
cd theses-quebec

# 2. Installer
python3 -m venv .venv                            # Python ≥ 3.10
.venv/bin/pip install -r requirements.txt

# 3. Lancer l'API + le frontend (servi sur la même origine)
.venv/bin/uvicorn api.app:app --host 127.0.0.1 --port 8000

# 4. Ouvrir
open http://127.0.0.1:8000/
```

La DB pré-moissonnée (`data/theses.db`) est versionnée via Git LFS — tu peux
explorer immédiatement, sans dépendre de la disponibilité des serveurs OAI.

---

## Moissonner les dépôts

```bash
# Tout moissonner (~10–60 min selon la santé des serveurs OAI)
.venv/bin/python harvester/harvest.py

# Limiter à N records par source (utile pour tester)
.venv/bin/python harvester/harvest.py --max-per-source 200

# Cibler une ou plusieurs sources
.venv/bin/python harvester/harvest.py --only concordia udem laval

# McGill nécessite un harvester séparé (Azure WAF + Hyrax)
.venv/bin/python harvester/mcgill_harvest.py
.venv/bin/python harvester/mcgill_harvest.py --headed   # debug, navigateur visible
```

Sources actuellement configurées dans
[`harvester/sources.yaml`](harvester/sources.yaml) :

| Université | Plateforme | Endpoint |
|---|---|---|
| Concordia (Spectrum) | EPrints | `/cgi/oai2` |
| UdeM (Papyrus) | DSpace · Scholaris | `/server/oai/request` |
| Sherbrooke (Savoirs UdeS) | DSpace · Scholaris | `/server/oai/request` |
| Bishop's (IRis) | DSpace · Scholaris | `/server/oai/request` |
| UQAM (Archipel) | EPrints | `/cgi/oai2` |
| UQTR (Cognitio) | EPrints | `/cgi/oai2` |
| UQAC (Constellation) | EPrints | `/cgi/oai2` |
| UQAR (Sémaphore) | EPrints | `/cgi/oai2` |
| UQO (Dépôt institutionnel) | EPrints | `/cgi/oai2` |
| UQAT (Depositum) | EPrints | `/cgi/oai2` |
| INRS (EspaceINRS) | EPrints | `/cgi/oai2` |
| ÉTS (Espace ETS) | EPrints | `/cgi/oai2` |
| TÉLUQ (R-Libre) | EPrints | `/cgi/oai2` |
| Laval (Corpus UL) | DSpace | `/oai/request` |
| McGill (eScholarship) | Hyrax / Blacklight | `/catalog/oai` (via Playwright) |

Pour ajouter une source, append au YAML — pas de code à toucher tant que c'est
EPrints ou DSpace.

---

## Classificateur LLM (Gemini 3 Flash)

Le classificateur règle-base couvre ~71 % des cas. Pour le reste — titres
opaques sans abstract, sans `dc:subject` — on délègue à Gemini 3 Flash en
mode **batch** (réponse en quelques minutes à 1 h, ~50 % moins cher que le
synchrone).

```bash
# 1. Crée une clé sur https://aistudio.google.com/apikey
cp .env.example .env
$EDITOR .env                      # colle GEMINI_API_KEY=...

# 2. Test avec 10 records
.venv/bin/python harvester/llm_classify.py run --limit 10

# 3. Plein régime (1 400+ records)
.venv/bin/python harvester/llm_classify.py run

# Le run est resumable : si tu Ctrl-C, le batch continue côté Google.
# Reprends-le avec :
.venv/bin/python harvester/llm_classify.py poll BATCH_NAME
```

Caractéristiques clés :

- **Schéma JSON enforcé** côté serveur : `responseSchema` avec `enum` strict
  des 33 disciplines canoniques. La sortie est garantie d'être une étiquette
  valide.
- **`thinkingBudget: 0`** : Gemini 3 utilise des thinking tokens par défaut.
  Pour de la classification mono-label on n'en veut pas — sinon ils mangent
  le budget de réponse.
- **Mêmes étiquettes** que le classificateur règle-base — les facettes
  restent cohérentes.
- **Sub-commandes** `preview` / `submit` / `poll` / `run` pour découpler
  soumission et application.

---

## Structure du projet

```
theses-quebec/
├── api/
│   └── app.py                FastAPI: /api/search /api/facets /api/sources
├── harvester/
│   ├── sources.yaml          Config des dépôts à moissonner
│   ├── harvest.py            Boucle OAI-PMH générique
│   ├── mcgill_harvest.py     Harvester Playwright pour McGill (WAF Azure)
│   ├── normalize.py          DC → schéma unifié, filtre thèse/mémoire
│   ├── classify.py           Classificateur règle-base (~150 mots-clés)
│   ├── llm_classify.py       Classificateur Gemini 3 Flash batch
│   └── db.py                 Schéma SQLite + FTS5 + triggers
├── web/
│   └── index.html            Frontend Tailwind + vanilla JS
├── data/
│   └── theses.db             Base SQLite pré-moissonnée (LFS)
├── .env.example              Template pour les secrets
├── requirements.txt
├── LICENSE                   MIT
├── NOTICE                    Provenance des métadonnées moissonnées
└── README.md
```

---

## Configuration (.env)

Créer `.env` à la racine (déjà gitignoré) :

```env
# Requis pour harvester/llm_classify.py
GEMINI_API_KEY=AIza...

# Optionnel — par défaut "gemini-flash-latest"
GEMINI_MODEL=gemini-flash-latest
```

Voir [`.env.example`](.env.example) pour le modèle.

---

## Déploiement

Le frontend statique + l'API tiennent dans une seule instance Python. Trois
voies typiques :

- **Tout statique (le moins cher)** — dump SQLite → JSON, frontend +
  MiniSearch sur Cloudflare Pages, harvest via GitHub Actions. Coût : 0 $/mois.
- **Fly.io free tier** — Dockerfile + `fly.toml`, volume persistant pour le
  SQLite, machine planifiée pour le harvest. Coût : 0–3 $/mois.
- **Self-hosted** — `systemd` + Caddy (HTTPS auto) sur n'importe quel VPS
  Linux. Cron pour le harvest. ~5 fichiers de config, stable des années.

Aucun de ces modèles n'est encore matérialisé dans le repo — ouvre une issue
si tu en veux un en particulier.

---

## Statut & limites

- **Prototype**. Code volontairement compact, pas de tests automatisés à
  ce stade.
- **2 dépôts intermittents** (UQAM, TÉLUQ) — leurs serveurs OAI ne répondent
  pas toujours. Le harvester est résilient (retry + skip).
- **Métadonnées datées** — la dernière passe est figée dans `data/theses.db`.
  Re-moissonner avant un travail sérieux.
- **Classification LLM = pas une vérité** — elle est rapide, cohérente et
  bonne, mais reste une heuristique. Pour la précision absolue, croiser
  avec `thesis.degree.discipline` quand le dépôt l'expose.
- **Pas encore d'authoring de revues / abstracts depuis Érudit** — c'est
  un agrégateur de dépôts institutionnels seulement.

---

## Contribuer

Les contributions sont les bienvenues, surtout :

- **Nouvelles sources** : ajoute une entrée dans `sources.yaml`. Si la source
  n'expose pas OAI-PMH, suis le patron de `mcgill_harvest.py`.
- **Mots-clés disciplinaires** : `harvester/classify.py` est trivial à
  étendre. Voir le commentaire en tête du fichier.
- **UI** : `web/index.html` est self-contained. Pas de build.
- **Tests** : un suite minimale autour de `normalize.py` et `classify.py`
  serait bienvenue.

Workflow standard :

```bash
git checkout -b ma-feature
# ... commits ...
git push origin ma-feature
gh pr create
```

---

## Licence

[MIT](LICENSE) pour le code source. Voir [`NOTICE`](NOTICE) pour la
provenance des métadonnées moissonnées (qui restent la propriété de chaque
université).

---

## Remerciements

- **Maude Jodoin**, qui a posé la question : « pourquoi je peux pas chercher
  les thèses en éducation ? ».
- **ENAP** pour la liste de référence des dépôts institutionnels québécois
  (`espace.enap.ca/autre_depot.html`).
- **Open Archives Initiative** pour OAI-PMH, le protocole qui rend ce
  projet possible en moins de 1 000 lignes de Python.
- Les **équipes des bibliothèques universitaires** qui maintiennent ces
  dépôts en accès libre.
