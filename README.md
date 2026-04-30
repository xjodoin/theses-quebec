# Thèses du Québec

> Recherche unifiée des thèses et mémoires des universités québécoises,
> avec **vraie recherche par discipline** — la fonctionnalité qui manque
> à Érudit.

**[🔎 Démo en ligne — xjodoin.github.io/theses-quebec](https://xjodoin.github.io/theses-quebec/)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.11%2B-blue)](https://www.python.org/)
[![Pages](https://img.shields.io/badge/demo-live-success)](https://xjodoin.github.io/theses-quebec/)
[![Records](https://img.shields.io/badge/records-187%2C463-success)]()
[![Sources](https://img.shields.io/badge/sources-16%20d%C3%A9p%C3%B4ts-success)]()

187 463 thèses et mémoires moissonnés depuis 16 dépôts institutionnels (Concordia,
McGill, UdeM, Sherbrooke, Bishop's, Laval, Polytechnique, le réseau UQ, INRS, ÉTS,
TÉLUQ), classés dans 74 disciplines canoniques (taxonomie alignée sur Érudit),
indexés en plein texte avec facettes par université, type, année et discipline.

![Capture de l'agrégateur — recherche par discipline](v3-after-llm.png)

---

## Sommaire

- [Pourquoi ce projet](#pourquoi-ce-projet)
- [Architecture](#architecture)
- [Démarrage rapide](#démarrage-rapide)
- [Build statique pour GitHub Pages](#build-statique-pour-github-pages)
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
3. **Classe** chaque thèse dans une discipline canonique (74 catégories, taxonomie alignée sur Érudit) via
   un classificateur règle-base + un classificateur LLM (Gemini 3 Flash) en
   batch pour le résidu.
4. **Indexe** en SQLite FTS5 avec facettes.
5. **Expose** une API REST + une interface web sobre (Tailwind, vanilla JS).

Résultat : 28,6 % de thèses non classées par les règles → **0,02 %** après le
batch LLM.

> **v0.6** ajoute la suggestion « *Did you mean?* » sur 0 résultat (Levenshtein
> sur le vocabulaire des facettes) et un graphique temporel par décennie dans
> la sidebar.

---

## Architecture

```
                ┌──────────────────────────────────┐
                │  16 dépôts institutionnels QC    │
                │  (EPrints · DSpace · Hyrax)      │
                └────────────────┬─────────────────┘
                                 │  OAI-PMH 2.0 (oai_dc · dim · oai_etdms · uketd_dc)
                                 │  + Playwright (McGill, Azure WAF)
                                 ▼
                    ┌─────────────────────────┐
                    │   harvester/            │
                    │   ├ harvest.py          │  multi-format DC
                    │   ├ parsers.py          │  4 parseurs (oai_dc/dim/etdms/uketd)
                    │   ├ normalize.py        │  schéma unifié
                    │   ├ classify.py         │  règles 3-pass (auth/primary/abstract)
                    │   └ llm_classify.py     │  Gemini 3 Flash batch (résidu)
                    └────────────┬────────────┘
                                 ▼
                    ┌─────────────────────────┐
                    │   data/theses.db        │  SQLite + FTS5
                    │   (GitHub Releases,     │  ~76 MB compressé
                    │    asset zstd)          │  (~666 MB raw)
                    └────────────┬────────────┘
                                 ▼
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
    ┌──────────────────┐                  ┌──────────────────┐
    │ Variante FastAPI │                  │ Variante statique│
    │ api/app.py       │                  │ scripts/build.mjs│
    │ /api/search …    │                  │ → dist/pagefind/ │
    └────────┬─────────┘                  └────────┬─────────┘
             ▼                                     ▼
    ┌──────────────────┐                  ┌──────────────────┐
    │ web/common.js    │  partagé →       │ web/common.js    │
    │ + backends/fast… │                  │ + backends/page… │
    └──────────────────┘                  └──────────────────┘
```

| Composant | Pile | Pourquoi |
|---|---|---|
| Moissonneur | Python + `requests` + Playwright | OAI-PMH partout sauf McGill (WAF Azure → vraie session navigateur) |
| Index serveur | SQLite **FTS5** | Aucun service externe ; tokenizer `unicode61 remove_diacritics` |
| Index statique | **Pagefind** (WASM, chunked) | ~50 KB initial, chargement à la demande, scaling à 177 k records |
| Classification | 3-pass règles + Gemini 3 Flash batch | Auth → règles primaires → règles+abstract → LLM pour le résidu |
| API | FastAPI | Auto-doc OpenAPI sur `/docs` |
| UI | Tailwind CDN, vanilla JS, ES modules | Aucun build, `web/common.js` partagé entre les deux variantes |

---

## Démarrage rapide

```bash
# 1. Cloner
git clone https://github.com/xjodoin/theses-quebec
cd theses-quebec

# 2. Installer
python3 -m venv .venv                            # Python ≥ 3.10
.venv/bin/pip install -r requirements.txt
npm install                                      # pour npm run db:fetch

# 3. Récupérer la DB pré-moissonnée (zstd, ~75 Mo) depuis la dernière
#    release GitHub. L'index FTS5 sera reconstruit automatiquement au
#    premier `connect()` (quelques secondes).
npm run db:fetch

# 4. Lancer l'API + le frontend (servi sur la même origine)
.venv/bin/uvicorn api.app:app --host 127.0.0.1 --port 8000

# 5. Ouvrir
open http://127.0.0.1:8000/
```

La DB pré-moissonnée n'est plus versionnée dans le repo — elle est publiée
comme **release GitHub** (asset zstd compressé, ~75 Mo). On évite ainsi de
saturer le quota Git LFS (1 Go gratuit), et le clone reste léger (~5 Mo).
Pour publier une nouvelle version après un harvest : `npm run db:release`.

---

## Build statique pour GitHub Pages

Une seconde version 100 % statique est générée à chaque push : **Pagefind**
découpe l'index plein-texte en chunks WASM *à la compilation* ; le navigateur
ne charge que ~50 KB initial puis fetch à la demande les chunks qui
correspondent à la requête (typ. 100–300 KB par session). **Recherche locale,
sans serveur, hébergement gratuit sur GitHub Pages, scaling à 177 k records.**

```bash
# Installer Node 20+ et les deps
npm install

# Builder dist/ (lit data/theses.db, produit dist/{index.html,pagefind/,meta.json})
npm run build

# Servir localement (http://localhost:5000)
npm run serve
```

Les benchmarks de recherche sont documentés dans
[`docs/search-benchmarks.md`](docs/search-benchmarks.md). Ils couvrent la
latence navigateur et la qualité de ranking contre SQLite FTS5.

Le déploiement Pages est automatique : le workflow
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) tourne à chaque
push qui touche `data/theses.db`, `scripts/build.mjs` ou `web/static.html`.

Le moissonnage hebdomadaire commit la DB rafraîchie → déclenche Pages → le
site est à jour automatiquement.

| Caractéristique | Version FastAPI | Version statique (Pages) |
|---|---|---|
| Hébergement | VPS / PaaS | GitHub Pages (gratuit, CDN) |
| Coût mensuel | 0 – 5 $ | 0 $ |
| Recherche | SQLite FTS5 (server) | Pagefind (WASM chunks, browser) |
| Latence requête | 10–50 ms (HTTP + SQL) | 30–80 ms (premier fetch chunk) |
| Premier chargement | < 1 s | ~50 KB index entry (chunks à la demande) |
| Maintenance | Service à surveiller | Aucune |
| Re-utilisation des données | API JSON | `pagefind/` + `meta.json` ouverts |

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
| Polytechnique Montréal (PolyPublie) | EPrints | `/cgi/oai2` (set `types=thesis`) |
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
  des 74 disciplines canoniques. La sortie est garantie d'être une étiquette
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
│   ├── common.js             UI partagée (search loop, facettes, modal, citations)
│   ├── backends/
│   │   ├── fastapi.js        Adapter pour /api/search
│   │   └── pagefind.js       Adapter pour le bundle Pagefind
│   ├── index.html            Frontend pour la version FastAPI
│   └── static.html           Frontend pour la version statique (Pages)
├── scripts/
│   ├── build.mjs             SQLite → Pagefind chunks → dist/
│   ├── serve.mjs             Serveur local de prévisualisation
│   ├── fetch_db.mjs          gh release download → zstd -d → data/theses.db
│   └── release_db.mjs        slim FTS5 + zstd → gh release create db-YYYY-MM-DD
├── tests/                    Suite pytest (75+ tests : classify, normalize, parsers, db)
├── data/
│   └── theses.db             Base SQLite (récupérée via `npm run db:fetch`,
│                             non versionnée — voir GitHub Releases)
├── .env.example              Template pour les secrets
├── package.json              Build pipeline statique
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

Trois voies typiques, par ordre croissant de complexité :

- **GitHub Pages (statique)** — déjà en place. `npm run build` → push →
  déploiement auto. Coût : 0 $. Voir
  [Build statique pour GitHub Pages](#build-statique-pour-github-pages).
- **Fly.io free tier** — Dockerfile + `fly.toml`, volume persistant pour le
  SQLite, machine planifiée pour le harvest. Coût : 0–3 $/mois.
  Pas encore matérialisé — ouvre une issue si intéressé.
- **Self-hosted** — `systemd` + Caddy (HTTPS auto) sur n'importe quel VPS
  Linux. Cron pour le harvest. ~5 fichiers de config, stable des années.
  Pas encore matérialisé.

---

## Statut & limites

- **Suite pytest** (75+ tests autour de `classify`, `normalize`, `parsers`,
  `db`). Smoke-test classifier exécuté en CI à chaque push.
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
- **UI** : `web/common.js` est partagé entre les deux variantes. Modifie-le
  pour faire évoluer les deux d'un coup. Aucun build.
- **Tests** : `python3 -m pytest tests/ -q` (Python 3.11+).

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
