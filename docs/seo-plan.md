# Plan SEO — pages-pivots disciplinaires

État au 27 avril 2026. Document de travail pour la prochaine itération
(v0.7 ou v0.8 selon priorisation).

## Constat

Le site actuel est une SPA Pagefind : Googlebot tente une seconde passe JS
mais avec un budget limité, et le pattern WASM + chunks à la demande lui
fait abandonner avant que du contenu apparaisse. **Aujourd'hui Google
n'indexe que la page d'accueil** ; aucune des 187 459 thèses n'a de surface
crawlable.

Une stratégie « une page HTML pré-rendue par thèse » paraît évidente mais
échoue sur deux points :

1. **Contenu dupliqué.** Titre + résumé + auteurs viennent des dépôts
   institutionnels que Google indexe déjà (Spectrum, Papyrus, Corpus UL…).
   Depuis ~2020 Google laisse en *« Crawled — currently not indexed »*
   tout ce qui n'apporte pas de nouveau signal. Avec `<link rel=canonical>`
   pointant vers la source : on confirme à Google de ne pas indexer notre
   copie. Sans : il décide de toute façon, généralement pareil.
2. **Autorité de domaine.** `xjodoin.github.io/theses-quebec/` est un
   sous-chemin sur un domaine partagé sans backlinks. Soumettre 187 k URL
   d'un coup garantit que la majorité reste en *discovered, not crawled*
   pendant des mois.

Précédent : BASE, CORE, OpenAIRE — agrégateurs financés et établis —
ont exactement ce problème. Ils ont des millions de pages indexées mais
ressortent rarement en SERP. Pour une requête sur un titre de thèse, c'est
toujours le dépôt institutionnel qui gagne.

## Stratégie : le contenu que personne d'autre ne peut produire

Le seul contenu défendable en SEO est celui que **ni les institutions ni
Érudit ne fournissent** :

- **Recherche disciplinaire qui marche réellement.** Érudit a un filtre
  discipline qui ne fonctionne pas ; les institutions n'agrègent pas
  entre elles. Notre taxonomie 74-disciplines Érudit-aligned, appliquée
  uniformément aux 16 dépôts, est unique.
- **Coupes transversales.** « Toutes les thèses en sciences de
  l'éducation au Québec, par décennie » n'existe nulle part — Érudit ne
  segmente pas par décennie utilement, les dépôts sont mono-institution.
- **Vues co-disciplinaires et historiques.** Évolution d'une discipline
  dans le temps, répartition entre universités, comparaisons.

Ces pages sont des **centaines**, pas 187 k. Chacune répond à une requête
réelle qu'aucune page existante n'adresse bien. C'est de l'agrégation à
valeur ajoutée — exactement ce que Google récompense.

Les pages-thèses individuelles peuvent suivre comme couche secondaire,
mais elles ne sont plus le but principal.

## Pages à pré-rendre

### Niveau 1 — Hubs disciplinaires (74 pages)

Une page par discipline canonique. URL : `/discipline/sciences-de-l-education/`.

Contenu pré-rendu :
- `<h1>` avec le nom de la discipline
- Compteur (« 12 847 thèses et mémoires en sciences de l'éducation »)
- Top 50 thèses (les plus récentes ou un mix récent + cité)
- Répartition par université (liste avec compteurs)
- Répartition par décennie (graphique inline SVG, pas Chart.js)
- Liens vers les sous-coupes : par décennie, par université, voir aussi
- JSON-LD `CollectionPage` + `ItemList`

Cible SEO : « thèses en X au Québec », « mémoire X québécois », etc.

### Niveau 2 — Coupes discipline × décennie (74 × 8 ≈ 600 pages)

URL : `/discipline/sciences-de-l-education/2010s/`.

Contenu : top thèses de cette tranche, contexte historique court généré
au build (« Cette décennie a vu N thèses publiées, contre M la précédente »),
liens latéraux vers les autres décennies.

Cible : recherche académique pointue, citations historiques.

### Niveau 3 — Coupes discipline × université (74 × 16 ≈ 1 200 pages)

URL : `/discipline/sciences-de-l-education/udem/`.

Contenu : toutes les thèses de cette discipline dans cette université,
avec direction (advisors) extraits — utile pour repérer un·e directeur·trice
de recherche dans un champ donné.

Cible : étudiant·es cherchant un·e directeur·trice, comparaison inter-institution.

### Niveau 4 — Hubs université (16 pages)

URL : `/universite/udem/`. Vue globale d'un dépôt avec ses disciplines
dominantes, sa courbe temporelle.

Filtrer doublons internes : `<link rel=canonical>` vers le dépôt si on
n'apporte rien (à éviter pour ne pas devenir un crawl gaspillé).

### Niveau 5 — Hubs direction (10 000–15 000 pages, optionnel)

URL : `/direction/jodoin-maude/`. Toutes les thèses dirigées par une
personne. La direction n'est exposée que par UdeM, Sherbrooke, Laval,
Bishop's (~70 400 records, v0.6.1) — c'est de la donnée que les autres
agrégateurs n'ont pas.

À phaser après que les niveaux 1–4 montrent un signal d'indexation
positif.

### Niveau 6 — Pages-thèses (187 k, dernier en priorité)

URL : `/t/{source_id}/{slug}-{short_hash}.html`.

Contenu minimal : titre, résumé, auteurs, direction, discipline, lien
vers la source. JSON-LD `ScholarlyArticle`. `<link rel=canonical>` vers
le dépôt institutionnel.

Utilité même sans indexation Google : URL deep-link pour partage humain
(Slack, mail, citations), Google Scholar lit le `ScholarlyArticle`,
fallback si la source disparaît un jour.

**Décision à prendre avant ce niveau** : rester sur GitHub Pages (1 GB
limite, ~700 MB attendu, c'est tendu) ou migrer Cloudflare Pages (pas
de plafond pratique).

## Implémentation

### Génération

Étendre `scripts/build.mjs`. Le SQL existant remonte déjà tout ce qu'il
faut ; ajouter des passes d'agrégation après le `SELECT` principal :

```js
// Pseudo-code
const byDiscipline = groupBy(rows, 'discipline');
for (const [discipline, theses] of Object.entries(byDiscipline)) {
  writeDisciplineHub(discipline, theses);
  for (const decade of decades(theses)) writeDisciplineDecade(...);
  for (const sourceId of universities(theses)) writeDisciplineUni(...);
}
```

Templates HTML statiques minimalistes (pas de Tailwind CDN à la requête —
inline du CSS critique pour que la page soit lisible sans JS). Hydrate
optionnel pour ajouter la recherche Pagefind après chargement.

Effort : `M` (½–2 jours pour niveaux 1–4 ; templates + agrégations + tests).

### Sitemap

Remplacer le sitemap mono-URL par un **sitemap index** :

```
sitemap.xml (index)
  ├ sitemap-hubs.xml          (niveaux 1–4, ~1 900 URLs)
  ├ sitemap-direction.xml     (niveau 5, si activé)
  └ sitemap-theses-{n}.xml    (niveau 6, shardé à 50 k URLs/fichier)
```

Lastmod = `meta.built_at` pour les hubs (rebuild hebdo), date de
moisson pour les thèses individuelles si on l'a.

### Liens internes

Crucial pour le crawl. Chaque page doit linker vers ses voisines :
- Hub discipline ⇄ ses 8 coupes décennie + 16 coupes université
- Page thèse → hub de sa discipline + page de sa direction (si existe)
- Sidebar « disciplines voisines » sur les hubs (ex. sociologie → 
  anthropologie, science politique)

Sans ce maillage Google ne propage pas l'autorité ; chaque page reste
une île.

### Search Console

À la mise en ligne :
1. Vérifier la propriété (`xjodoin.github.io` ou domaine custom).
2. Soumettre le sitemap index.
3. Surveiller *Couverture* : ratio crawled/indexed après 4 semaines.
4. Si < 20 % indexé : ajouter du contenu unique (citations, contexte
   généré, signaux de fraîcheur).

## Hébergement

| Niveau | Pages | Taille estimée | GH Pages OK ? |
|---|---|---|---|
| 1–4 | ~1 900 | ~30 MB | ✅ |
| + 5 | ~17 000 | ~100 MB | ✅ |
| + 6 | ~204 000 | ~700–900 MB | ⚠️ tendu |

Recommandation : phaser. Niveaux 1–4 (et 5) sur GitHub Pages, sans
hâte. Migration Cloudflare Pages **uniquement** si le niveau 6
prouve son utilité (signal d'indexation positif sur 1–4 d'abord).

## Domaine custom

`theses-quebec.ca` ou similaire change la donne SEO. Sous-chemin sur
`xjodoin.github.io` est un handicap connu (Google traite le domaine
comme le tien partagé). **Pré-requis** avant de pousser le niveau 1.

Effort : `S` (achat domaine + DNS + GH Pages custom domain config).
Coût : ~15 $/an.

## Phasage proposé

### Phase 1 — Fondations (sprint d'~1 semaine)

1. **Domaine custom** (`S`) — pré-requis tout le reste.
2. **Niveau 1 : 74 hubs disciplinaires** (`M`) — JSON-LD, maillage,
   sitemap.
3. Soumission Search Console + observation 4 semaines.

Critère de succès : ≥ 30 % des hubs indexés à 4 semaines, au moins 5
hubs apparaissent en SERP top-20 pour leur requête cible.

### Phase 2 — Profondeur (~1 semaine si phase 1 valide)

4. **Niveau 2 : décennies** (`M`) — 600 pages, plus de surface long-tail.
5. **Niveau 3 : université × discipline** (`M`) — 1 200 pages.
6. **Niveau 4 : hubs université** (`S`) — vues globales.

Critère : > 50 % des nouvelles pages indexées à 6 semaines.

### Phase 3 — Direction (~3 jours, conditionnel)

7. **Niveau 5 : pages direction** (`L`) — 10–15 k pages. Justifié seulement
   si des requêtes type *« thèses dirigées par X »* apparaissent en
   Search Console à la phase 2.

### Phase 4 — Pages-thèses (~1 semaine, conditionnel + migration host)

8. **Migration Cloudflare Pages** (`M`) si décision GO.
9. **Niveau 6** (`M`) — 187 k pages, sitemap shardé, canonical vers source.

Conditions GO : Phase 1–3 valides, Search Console montre du trafic
disciplinaire stable, et identifier un usage concret (deep-link partage,
Google Scholar) qui justifie le coût d'opération.

## Métriques de suivi

À ajouter dans le rapport hebdo :
- Nombre de pages indexées (Search Console)
- Impressions / clics par niveau
- Top requêtes — sont-elles disciplinaires (signal positif) ou
  navigationnelles (« thèses québec » seul = on n'a rien gagné) ?
- Pages avec 0 impression à 8 semaines = candidates à `noindex`
  (rétrécir l'index, augmenter la qualité moyenne perçue)

## Risques

- **Google ignore quand même.** Réaliste. Mitigations : domaine custom,
  contenu génératif unique au-delà des chiffres bruts, backlinks
  (mention sur Mastodon académique, Reddit r/Quebec, listes universitaires).
- **Maintenance qui dérive.** Chaque rebuild régénère 1 900+ pages ;
  templater proprement dès le départ pour éviter de réécrire en v0.9.
- **Contenu trop fin = thin content penalty.** Un hub discipline avec
  3 thèses ne mérite pas une page indexable — `noindex` automatique
  sous un seuil (ex. < 20 records) pour les coupes croisées.
- **Doublons internes.** Discipline × décennie × université peut créer
  des combos quasi-vides ou redondants. Supprimer ou `noindex` les
  pages avec moins de N records ou trop similaires à un parent.

## Décisions ouvertes

1. **Canonical-to-self ou canonical-to-source** sur les pages-thèses ?
   Self = on parie qu'on apporte de la valeur (discipline curée, liens
   internes). Source = on cède la SEO mais reste safe.
2. **Domaine** : `theses-quebec.ca`, `theses.quebec`, `tq.cc` ?
3. **Hydratation Pagefind** sur les hubs : oui (UX continue) ou non
   (HTML pur, plus rapide, demande un clic vers `/` pour chercher) ?
4. **Génération contenu** : juste compteurs et listes, ou résumés
   générés (LLM) du type « cette discipline a connu une croissance
   forte dans les années 2000, portée par X universités » ?
   Le LLM génère un signal *unique* mais coûte un budget Gemini et
   risque l'hallucination factuelle.
