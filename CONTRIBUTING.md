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

Suite `pytest` (~75 tests) dans `tests/` couvrant `classify`, `normalize`,
`parsers`, `db`. Lancer :

```bash
.venv/bin/python -m pytest tests/ -q
.venv/bin/python -m pytest tests/test_classify.py::test_didactique_beats_education -q   # un seul
```

Quand tu modifies une règle de classification ou un parseur OAI, ajoute le
cas dans `tests/test_classify.py` ou `tests/test_parsers.py`. Le smoke-test
de classification tourne en CI à chaque push.

### Distribution de la DB

`data/theses.db` n'est plus dans le repo (anciennement LFS, abandonné en
v0.6.3 — ça défonçait le quota gratuit). La DB pré-moissonnée vit comme
asset GitHub Release :

- **Récupérer** : `npm run db:fetch` (télécharge la dernière `db-YYYY-MM-DD`,
  vérifie SHA-256, décompresse). Au premier `connect()` `harvester/db.py`
  reconstruit l'index FTS5 (~8 s, transparent).
- **Publier** une nouvelle version après un harvest : `npm run db:release`
  (strip FTS5 + VACUUM + zstd -19 + `gh release create --latest`). Demande
  `gh` authentifié et `zstd` installé.

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
