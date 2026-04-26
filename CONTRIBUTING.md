# Contribuer à theses-quebec

Merci de l'intérêt — voici les chemins les plus utiles pour contribuer.

## Cas faciles d'abord

### Ajouter une source OAI-PMH

La majorité des dépôts canadiens exposent OAI-PMH. Pour en ajouter un :

1. Vérifier que l'endpoint répond :

   ```bash
   curl "https://EXEMPLE.ca/oai/request?verb=Identify"
   ```

2. Append à `harvester/sources.yaml` :

   ```yaml
   - id: monnouveaudepot
     name: Mon Université (Mon Dépôt)
     short: MonU
     platform: dspace        # ou eprints
     base_url: https://exemple.ca/oai/request
     set: null               # ou un setSpec si tu veux filtrer
   ```

3. Tester :

   ```bash
   .venv/bin/python harvester/harvest.py --only monnouveaudepot --max-per-source 50
   ```

4. PR avec ton ajout + une note de la taille du dépôt et de tout
   comportement particulier rencontré.

### Étendre les mots-clés disciplinaires

`harvester/classify.py` contient `DISCIPLINE_RULES`. Ordre = priorité.

- Mots-clés en minuscules, sans accents (le matcher en strippe).
- Évite les termes trop génériques (« étude », « analyse ») qui matchent
  partout.
- Garde l'ordre : disciplines spécifiques (didactique) avant générales
  (éducation).

Pour vérifier ton ajout :

```bash
.venv/bin/python -c "
import sys; sys.path.insert(0, 'harvester')
from classify import classify_discipline
print(classify_discipline({
    'title': 'Ton titre de test',
    'subjects': '', 'abstract': '', 'publisher': '',
}))
"
```

### Améliorer le frontend

`web/index.html` est self-contained — un seul fichier, Tailwind via CDN,
pas de build. Cibles utiles :

- Accessibilité (ARIA, focus traps, navigation clavier dans les facettes)
- Mode sombre
- Export CSV/BibTeX des résultats
- Vue détaillée d'une thèse

## Cas plus structurels

### Source sans OAI-PMH

Cf. `harvester/mcgill_harvest.py` pour le patron Playwright (utile si la
source est protégée par WAF). Pour une source qui n'a vraiment aucune API,
écris un scraper séparé qui produit des records `<oai:record>` simulés et
réutilise `harvest.harvest_source(source, conn, record_iter=...)`.

### Tests

Aucun pour l'instant. Une suite ciblée sur `normalize.py` (extraction
d'année, détection thèse/mémoire) et `classify.py` (mots-clés) serait
bienvenue. `pytest` recommandé.

### Dump statique pour Cloudflare Pages

Une issue ouverte propose de convertir le projet en version 100 % statique
(SQLite → JSON, MiniSearch côté navigateur, GitHub Action pour le harvest).
Si ça t'intéresse, prends-la.

## Workflow

```bash
git checkout -b ma-feature
# édits, commits ...
git push origin ma-feature
gh pr create
```

Conventions de commit : descriptifs, pas de format strict imposé. Les
messages courts mais précis sont préférés (« add UQTR EPrints set filter »
plutôt que « update »).

## Code de conduite

Le projet suit le [Contributor Covenant](https://www.contributor-covenant.org/).
Sois respectueux·se ; on est là pour rendre la recherche plus accessible.
