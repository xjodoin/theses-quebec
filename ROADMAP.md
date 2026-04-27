# Feuille de route — theses-quebec

État au 26 avril 2026. Document vivant : ouvre une PR pour proposer un
ajout, ou réagis dans une issue pour discuter d'une priorité.

**v0.2 livrée le 26 avril 2026** — Sprint 1 quasi complet (1.1 à 1.6),
plus 2.3 (investigué) et 3.1 (24 tests). Le seul item Sprint 1 restant
est 1.7 (highlight diacritiques-aware, faible valeur).

**v0.3 livrée le 26 avril 2026** — Cap 500→2 000/source (5 002 → 20 171
records, ×4), Polytechnique ajoutée, taxonomie 33 → 74 disciplines
Érudit-aligned, classifieur bilingue, audit a11y FastAPI, SEO
(sitemap + JSON-LD Dataset). 1,04 % records non classés (vs 28,6 %
au prototype, 0,02 % avec LLM en v0.2).

**v0.4 livrée le 27 avril 2026** — Cap totalement levé (×6.7 → **123 824
records**) ; harvest incrémental + suppressions OAI honorées (25 993
tombstones traités) ; toutes les sources passent à des prefixes riches
(`dim` / `oai_etdms` / `uketd_dc`) qui exposent une discipline qualifiée
par l'institution ; **3-pass classifier** avec attribution de provenance
explicite (`auth` 60 % / `rule` 18 % / `rule_abstract` 6 % / `llm` 17 %).
0,21 % records non classés. Couverture : 16 sources québécoises,
toutes répondent (UQAM/TÉLUQ inclus).

**v0.5 livrée le 27 avril 2026** — Migration **Pagefind** : MiniSearch
(26 MB initial) → Pagefind chunks à la demande (~50 KB initial + 100-300 KB
par requête). Abstracts re-indexés (1 500 chars). Stemming
français + anglais natif. Excerpts surlignés natifs.

**v0.5.1 livrée le 27 avril 2026** — Refactor : extraction de toute la
logique UI partagée (~780 lignes) dans `web/common.js` + adaptateurs
`web/backends/{fastapi,pagefind}.js`. L'a11y de `web/index.html` est
désormais automatiquement disponible sur `web/static.html` (fini le
backport). Click sur titre ouvre le modal détail (et non la source).

**Légende**

- **Effort** : `S` ≤ 4 h · `M` ½–2 jours · `L` une semaine et plus
- **Valeur** : ✶ marginal · ✶✶ utile · ✶✶✶ change l'utilité du produit
- **Statut** : ⏳ à faire · 🟡 en cours · ✅ fait · 🚫 abandonné

---

## Sprint 1 — Quick wins UX (~1 jour total)

> Ce qui ferait passer le projet de démo à outil de travail pour un·e chercheur·se.

| # | Amélioration | Effort | Valeur | Statut |
|---|---|---|---|---|
| 1.1 | **Vue détail par thèse** — modal au clic d'une carte, abstract complet, tous les champs DC, lien vers le PDF source. | M | ✶✶✶ | ✅ `738434a` |
| 1.2 | **Export citation** — bouton « Copier la citation » dans le détail (BibTeX, APA, RIS). | S | ✶✶✶ | ✅ `738434a` |
| 1.3 | **Auteur cliquable** — clic sur un nom → filtre par auteur. Stockage : facette dédiée. | S | ✶✶✶ | ✅ `208a4bf` |
| 1.4 | **Discipline cliquable** sur les cartes — clic sur la pill → sélectionne la facette. | S | ✶✶ | ✅ `208a4bf` |
| 1.5 | **Mode sombre** — `dark:` Tailwind + toggle dans le header. Respect `prefers-color-scheme`. | S | ✶✶ | ✅ `229ff0c` |
| 1.6 | **Bouton « Copier le lien »** — visible quand des filtres sont actifs. URL est déjà sync, juste rendre le geste explicite. | S | ✶ | ✅ `229ff0c` |
| 1.7 | **Surlignage diacritiques-aware** — actuellement le `<mark>` rate les variantes accentuées. Index par char-pos pour highlighter exact. | S | ✶ | ⏳ |

---

## Sprint 2 — Couverture & données (~1 weekend)

> Le projet vit ou meurt sur la profondeur du corpus.

| # | Amélioration | Effort | Valeur | Statut |
|---|---|---|---|---|
| 2.1 | **Lever le cap 500/source** — re-harvester sans `--max-per-source`. Estimation : ~50 000 records, DB ~250 MB. | S | ✶✶✶ | ✅ v0.4 (cap totalement levé · 123 824 records) |
| 2.2 | **Migrer vers Pagefind** — à 50k records l'index MiniSearch dépasse 30 MB. Pagefind charge des chunks à la demande, ~100–500 KB par session. | M | ✶✶✶ | ✅ v0.5 |
| 2.3 | **Ajouter Érudit** — `oai.erudit.org`, couvre revues + thèses. Le déclencheur initial du projet. Investigué : OAI-PMH ne sert que des articles de revues (aucun set thèses, `dc:type=text`); les thèses Érudit sont fédérées depuis Papyrus/Savoirs UdeS/Archipel — déjà moissonnés directement. Voir notes dans `sources.yaml`. | M | ✶✶✶ | ✅ investigué |
| 2.4 | **Étendre la taxonomie disciplinaire** — passer de 33 à 60+ catégories (sous-disciplines). Re-classifier en batch. | M | ✶✶ | ✅ v0.3 (74 disciplines, Érudit-aligned) |
| 2.5 | **Re-classifier l'historique** quand `classify.py` évolue — bouton CLI `classify-existing`. | S | ✶✶ | ⏳ |
| 2.6 | **Dépôts canadiens hors Québec** — UofT, UBC, McMaster, Dalhousie. OAI-PMH partout. Renomme en `theses-canada` ? | L | ✶✶ | ⏳ |
| 2.7 | **Fallback PDF text extraction** — pour les records sans abstract, extraire les 500 premiers mots du PDF (institutions qui le permettent). Améliore la classif LLM. | L | ✶✶ | éthique |

---

## Sprint 3 — Qualité & confiance (~1 semaine cumulée)

| # | Amélioration | Effort | Valeur | Statut |
|---|---|---|---|---|
| 3.1 | **Tests Python** — `pytest` sur `normalize.py` (extraction année, type), `classify.py` (mots-clés). Ajouter à `ci.yml`. | S | ✶✶ | ✅ `e00c3b3` (24 tests) |
| 3.2 | **Audit accessibilité** — ARIA labels sur facettes/pagination, traversée clavier des résultats, contraste. Test lighthouse. | M | ✶✶ | ✅ v0.3 (FastAPI) + v0.5.1 (auto-applique aux 2 versions via common.js partagé) |
| 3.3 | **i18n EN** — toggle FR/EN dans le header. Interface uniquement, pas de traduction des résumés. | M | ✶ | ⏳ |
| 3.4 | **OGP / cartes sociales** — `<meta>` pour partages X/Bluesky/LinkedIn. Capture statique du site. | S | ✶ | ⏳ |
| 3.5 | **Sitemap.xml + JSON-LD `Dataset`** — visibilité Google Scholar / Datasets. | S | ✶✶ | ✅ v0.3 |
| 3.6 | **Documentation interne (`docs/`)** — schéma DB, format JSONL Gemini, règles de classif. | M | ✶ | ⏳ |
| 3.7 | **CONTRIBUTORS.md auto-généré** — `gh contributor list`. | S | ✶ | ⏳ |

---

## Sprint 4 — Écosystème open data (~2 semaines)

| # | Amélioration | Effort | Valeur | Statut |
|---|---|---|---|---|
| 4.1 | **Endpoint OAI-PMH ré-exposant le corpus enrichi** — autres agrégateurs peuvent moissonner notre classification. Ironie : on devient une source. | M | ✶✶ | ⏳ |
| 4.2 | **API JSON publique stable** — `/api/v1/search`, `/api/v1/sources`. Doc OpenAPI. Hébergée Fly.io ou Cloudflare Workers + D1. | L | ✶✶ | dépend de 4.3 |
| 4.3 | **Déploiement Cloudflare Workers + D1** — backend serverless qui sert l'API et le frontend. Coût quasi-nul. | M | ✶ | ⏳ |
| 4.4 | **Webhook de re-publication** — quand un dépôt source met à jour un record, on reflète sous 24 h. | L | ✶ | infrastructure |
| 4.5 | **Dataset HuggingFace** — uploader le corpus normalisé comme dataset libre. | S | ✶✶ | doc seulement |

---

## Sprint 5 — Recherche avancée (selon l'appétit)

| # | Amélioration | Effort | Valeur | Statut |
|---|---|---|---|---|
| 5.1 | **Recherche sémantique** — embeddings sentence-transformer multilingue (LaBSE / paraphrase-multilingual-MiniLM), index FAISS / WASM, recherche par similarité. ~50 MB. | L | ✶✶✶ | scale |
| 5.2 | **« Did you mean? »** — suggestions de correction sur 0 résultat. Trigramme + dist. Levenshtein. | S | ✶✶ | ⏳ |
| 5.3 | **Recherche par auteur fuzzy** — variantes nom/prénom (« Jodoin, M. » vs « Maude Jodoin »). | M | ✶✶ | ⏳ |
| 5.4 | **Compare 2+ disciplines / décennies** — vue côte-à-côte, courbes temporelles. | M | ✶ | ⏳ |
| 5.5 | **Graphique temporel** — distribution annuelle par discipline (chart.js / svg natif). | S | ✶✶ | ⏳ |
| 5.6 | **Sauvegarder une recherche** — localStorage, retour facile à 5 dernières requêtes. | S | ✶ | ⏳ |
| 5.7 | **Détection de doublons** — même thèse archivée à plusieurs endroits (rare mais existe). | M | ✶ | ⏳ |

---

## Sprint 6 — Opérations & déploiement alternatif

| # | Amélioration | Effort | Valeur | Statut |
|---|---|---|---|---|
| 6.1 | **`Dockerfile` + `fly.toml`** — pour ceux qui veulent l'auto-héberger avec backend FastAPI. | S | ✶ | ⏳ |
| 6.2 | **`deploy/systemd/` + `Caddyfile`** — recettes self-host VPS Linux. | S | ✶ | ⏳ |
| 6.3 | **Monitoring de santé OAI** — page `/status` qui ping chaque endpoint chaque 6 h, affiche un status board. | M | ✶ | ⏳ |
| 6.4 | **Export régulier sur archive.org** — preservation des snapshots de la DB. | S | ✶✶ | ⏳ |
| 6.5 | **Mirroirs LFS alternatifs** — GitHub LFS a un quota. Backup vers R2 / S3. | M | ✶ | si besoin |

---

## Idées exploratoires (pas planifiées)

- **PWA / offline-first** — installable, fonctionne sans connexion une fois chargé. Cache `search.json` via Service Worker.
- **Mode chercheur·se connecté·e** — sauvegarder ses thèses pertinentes, annoter, exporter une bibliographie. Demande auth → augmente la complexité d'un cran.
- **Notifications nouvelle thèse** — RSS / Atom feed des nouveaux records par discipline.
- **Visualisation des co-auteurs** — graphe par université, par décennie.
- **API LLM publique pour Q&A sur le corpus** — RAG sur les abstracts. Coûts variables.

---

## v0.2 — livrée ✅
1.1 Vue détail · 1.2 Export citation · 1.3 Auteur cliquable · 1.4 Discipline cliquable · 1.5 Mode sombre · 1.6 Copier le lien · 2.3 Érudit (investigué) · 3.1 Tests Python (24)

## v0.3 — livrée ✅ (saut quantitatif)
2.1 partiel (cap 2000) · 2.4 Taxonomie 33→74 · 3.2 a11y FastAPI · 3.5 Sitemap+JSON-LD

## v0.4 — livrée ✅ (richesse + incrémental)
- **2.1** Cap totalement levé : **123 824 records** (×6.7)
- **Métadonnées riches** : 14/16 sources sur `dim` / `oai_etdms` / `uketd_dc` au lieu d'`oai_dc`
- **Authoritative discipline** : 100 775 records avec discipline curée par l'institution
- **3-pass classifier** : Pass 0 (auth) / Pass 1 (primary) / Pass 2 (abstract) avec provenance trackée
- **Harvest incrémental** + tombstones honorés (25 993 suppressions)
- 1.7 highlight, encore ⏳

## v0.5 — livrée ✅ (scaling de la recherche)
- **2.2** Migration Pagefind — bundle initial ÷500
- Abstracts re-indexés (perdus en v0.3-v0.4 pour cause de taille)
- Stemming français + anglais natif

## v0.5.1 — livrée ✅ (architecture)
- **Refactor majeur** : `web/common.js` (UI partagée) + 2 backends (`fastapi.js`/`pagefind.js`)
- 780+ lignes de duplication JS éliminées
- A11y backportée automatiquement (3.2 désormais complet)
- UX : click sur titre ouvre le modal au lieu de naviguer

## v0.6 — proposition (qualité + données)
1. **5.2** « Did you mean? » sur 0 résultat
2. **5.5** Graphique temporel (distribution annuelle par discipline)
3. **3.6** Documentation interne (`docs/` schema DB, format JSONL Gemini)
4. **2.7** Fallback PDF text extraction pour records sans abstract
5. **1.7** Highlight diacritiques-aware
6. **5.6** Sauvegarder les recherches récentes (localStorage)

## v0.7+ — propositions ouvertes
- **2.6** Dépôts canadiens hors-Québec (rebrand `theses-canada`?)
- **5.1** Recherche sémantique (embeddings)
- **4.5** Dataset sur HuggingFace
- **4.1** OAI-PMH ré-exposant le corpus enrichi
