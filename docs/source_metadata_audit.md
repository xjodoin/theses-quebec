# OAI-PMH metadata audit (2026-04-25, McGill + uketd_dc revisited 2026-04-29)

Per-source comparison: what do our 16 sources expose beyond plain `oai_dc`?
Goal: identify sources where switching to a richer metadata prefix would give
us an explicit, authoritative discipline / department value AND a usable
master/doctoral level signal — instead of relying on keyword-matching against
generic `dc:subject` and an ambiguous `dc:type`.

From `oai_dc` we capture: `dc:title`, `dc:creator`, `dc:subject` (flattened,
no qualifier), `dc:type`, `dc:date`, `dc:identifier`, `dc:relation`,
`dc:description` (abstract), `dc:publisher`, `dc:language`. Any field that
does not map onto one of those — and especially anything qualified or
anything in a non-`dc` schema — is lost on this prefix.

> **2026-04-29 update — type classification audit.** Beyond discipline, the
> metadata prefix is also load-bearing for the thèse-vs-mémoire split (see
> `harvester/normalize.py:_classify_type`). Several sources collapse the
> degree level onto an ambiguous `<dc:type>`:
>
> - McGill (`oai_dc`): `<dc:type>Thesis</dc:type>` for everything → all 55k
>   records were marked `thesis`. Switched to `oai_etdms`, which carries
>   `<degree><name>Doctor of Philosophy / Master of Engineering>`. Result:
>   34,756 mémoires / 20,835 thèses (ratio recovered).
> - ÉTS (`oai_dc`): `<dc:type>Mémoire ou thèse</dc:type>` → all 3,397 records
>   marked `memoire`. ÉTS does expose `uketd_dc` with
>   `<uketdterms:qualificationlevel>doctoral|masters>` (the audit row below
>   was wrong on this point). Switched.
> - INRS / UQO / UQAR / UQAT / UQAC: dc:type is unhelpful; the level lives
>   in `<uketdterms:qualificationlevel>` (parser was reading
>   `degreelevel` and `qualificationname` only). Parser fixed.

## Summary table

| Source | Platform | Best prefix | Authoritative discipline / department | New value vs `oai_dc`? | Recommended action |
|---|---|---|---|---|---|
| bishops | DSpace 7 | `dim` | `dc.subject@discipline` + `thesis.degree.discipline` (e.g. "Computer Science") | **Yes** — qualifier lost in `oai_dc`; `thesis.*` schema not in DC at all | switch to `dim` |
| udem | DSpace 7 | `dim` | `etd.degree.discipline` (e.g. "Science politique", "Droit") | **Yes** — `etd.*` schema not in DC | switch to `dim` |
| usherbrooke | DSpace 7 | `dim` | `thesis.degree.discipline` + `udes.faculte` (e.g. "Génie mécanique" / "Faculté de génie") | **Yes** — neither schema is in DC | switch to `dim` |
| laval | DSpace | `dim` | `etdms.degree.discipline` + `bul.faculte` (e.g. "Maîtrise en sciences géographiques - avec mémoire") | **Yes** — `etdms.*`/`bul.*` not in DC | switch to `dim` |
| concordia | EPrints | `oai_etdms` (or `uketd_dc`) | `etd_ms:discipline` (e.g. "English"); `uketdterms:department` same value | **Yes** — discipline not in `oai_dc` | switch to `oai_etdms` (or `uketd_dc`) |
| uqam | EPrints | `uketd_dc` | `uketdterms:department` (e.g. "Doctorat en psychologie (Essai doctoral)") | **Yes** — department not in `oai_dc` | switch to `uketd_dc` |
| uqtr | EPrints | `oai_etdms` | `etdms:discipline` (e.g. "Études québécoises") | **Yes** — discipline not in `oai_dc`; uketd_dc has no department for UQTR | switch to `oai_etdms` |
| uqac | EPrints | `uketd_dc` | `uketdterms:department` (e.g. "Maîtrise en informatique") | **Yes** — department not in `oai_dc` | switch to `uketd_dc` |
| uqar | EPrints | `uketd_dc` | `uketdterms:department` (e.g. "Département de lettres et humanités") | **Yes** — department not in `oai_dc` | switch to `uketd_dc` |
| uqo | EPrints | `uketd_dc` | `uketdterms:department` (e.g. "Département des sciences de l'éducation") | **Yes** — department not in `oai_dc` | switch to `uketd_dc` |
| uqat | EPrints | `uketd_dc` | `uketdterms:department` (e.g. "Sciences appliquées") | **Yes** — department not in `oai_dc` | switch to `uketd_dc` |
| inrs | EPrints | `uketd_dc` | `uketdterms:department` (e.g. "Doctorat en études urbaines") | **Yes** — department not in `oai_dc` | switch to `uketd_dc` |
| ets | EPrints | `uketd_dc` | `uketdterms:qualificationlevel` (`doctoral`/`masters`) — no department, but degree level is the critical signal here because `dc:type="Mémoire ou thèse"` is uniformly ambiguous | **Yes for type, not for discipline** — 2026-04-29 correction | switched to `uketd_dc` |
| rlibre | EPrints | `oai_etdms` | `etd_ms:discipline` (e.g. "Informatique cognitive"); `uketd_dc` lacks department | **Yes** — discipline not in `oai_dc` | switch to `oai_etdms` |
| polymtl | EPrints | `oai_etdms` | `etd_ms:discipline` (e.g. "Génie informatique") | **Yes** — discipline not in `oai_dc`; `uketd_dc` returns `cannotDisseminateFormat` here | switch to `oai_etdms` |
| mcgill | Hyrax/Blacklight (WAF) | `oai_etdms` | `<degree><discipline>` (e.g. "Department of Psychology") + `<degree><name>` (e.g. "Doctor of Philosophy") | **Yes** — `oai_dc` collapses everything to `<dc:type>Thesis</dc:type>` | switched to `oai_etdms` (with skip-window for `cannotDisseminateFormat`, see `mcgill_harvest.py`) |

**Headline (post-2026-04-29 update):** all 16 OAI sources are now on a
prefix that exposes either authoritative discipline, degree level, or both.
ÉTS doesn't surface discipline but does surface `qualificationlevel`, which
is the load-bearing field there given the ambiguous dc:type. McGill, the
last unknown in the original audit, was switched to `oai_etdms` and now has
authoritative_discipline populated for 81 % of records (44k of 55k).

## Per-source detail

### bishops — DSpace 7 (IRis)

`ListMetadataFormats`: `didl mods ore mets xoai dim rioxx uketd_dc qdc oai_dc rdf marc etdms`

Sample (`oai:ubishops.scholaris.ca:20.500.14633/263`) via `dim`:

```xml
<dim:field mdschema="dc" element="contributor" qualifier="advisor">Hedjam, Rachid</dim:field>
<dim:field mdschema="dc" element="subject" qualifier="discipline" lang="en">Computer Science</dim:field>
<dim:field mdschema="thesis" element="degree" qualifier="discipline" lang="en">Computer Science</dim:field>
<dim:field mdschema="thesis" element="degree" qualifier="level" lang="en">Master&apos;s</dim:field>
<dim:field mdschema="thesis" element="degree" qualifier="grantor">Bishop&apos;s University</dim:field>
<dim:field mdschema="dc" element="identifier" qualifier="doi">https://doi.org/10.71661/91</dim:field>
```

Recommendation: switch to `dim`. Two corroborating discipline fields, plus
explicit advisor (currently flattened into a generic `dc:contributor`), DOI as
a typed identifier, and degree level/grantor.

### udem — DSpace 7 (Papyrus)

`ListMetadataFormats`: `etdms11 etdms10 didl mods ore mets xoai marc21 dim oai_openaire uketd_dc qdc oai_dc rdf marc oai_openaire4science oai_etdms etdms`

Sample thesis via `dim`:

```xml
<dim:field mdschema="dc" element="contributor" qualifier="advisor">Noël, Alain</dim:field>
<dim:field mdschema="dc" element="contributor" qualifier="author">Ben Jelili, Emna</dim:field>
<dim:field mdschema="etd" element="degree" qualifier="discipline">Science politique</dim:field>
<dim:field mdschema="etd" element="degree" qualifier="grantor">Université de Montréal</dim:field>
<dim:field mdschema="etd" element="degree" qualifier="level">Maîtrise / Master&apos;s</dim:field>
<dim:field mdschema="etd" element="degree" qualifier="name">M. Sc.</dim:field>
```

Recommendation: switch to `dim`. UdeM uses an `etd.*` schema (not `thesis.*`)
with `qualifier="discipline"`. Currently invisible in `oai_dc`.

### usherbrooke — DSpace 7 (Savoirs UdeS)

`ListMetadataFormats`: `didl mods ore mets xoai dim rioxx uketd_dc qdc oai_dc rdf marc etdms`

Sample (`oai:usherbrooke.scholaris.ca:11143/6186`) via `dim`:

```xml
<dim:field mdschema="thesis" element="degree" qualifier="discipline">Génie mécanique</dim:field>
<dim:field mdschema="thesis" element="degree" qualifier="level">Maîtrise</dim:field>
<dim:field mdschema="thesis" element="degree" qualifier="name">M. Sc. A.</dim:field>
<dim:field mdschema="udes" element="faculte">Faculté de génie</dim:field>
```

Recommendation: switch to `dim`. Bonus: a custom `udes:faculte` element is
exposed (not in any standard schema, definitely not in `oai_dc`).

### laval — DSpace (Corpus UL)

`ListMetadataFormats`: `etdms11 didl mods ore mets xoai dim rioxx uketd_dc qdc oai_dc rdf marc etdms`

Sample (handle `20.500.11794/129084`) via `dim` — Laval is the richest of the
15 sources by a wide margin. Selection of fields:

```xml
<dim:field mdschema="dc" element="subject" qualifier="rvm" lang="fr_CA">Gestion intégrée de l'eau par bassin versant</dim:field>
<dim:field mdschema="bul" element="faculte">Faculté de foresterie, de géographie et de géomatique.</dim:field>
<dim:field mdschema="bul" element="contributor" qualifier="advisor-marc100">Lasserre, Frédéric|=$aLasserre, Frédéric,$d1967-</dim:field>
<dim:field mdschema="etdms" element="degree" qualifier="discipline">G 60 UL MEM</dim:field>
<dim:field mdschema="etdms" element="degree" qualifier="discipline">Maîtrise en sciences géographiques - avec mémoire</dim:field>
<dim:field mdschema="bul" element="identifier" qualifier="controlNumber">1409133999</dim:field>
<dim:field mdschema="dc" element="identifier" qualifier="nothese">39545</dim:field>
```

Recommendation: switch to `dim`. We gain: RVM (Répertoire de vedettes-matière)
qualified subjects, faculty, MARC100-formatted authors with controlled
authority IDs, ETDMS discipline (often *two* values: a Laval internal code
plus a human label), and the `nothese` registration number. Note: laval's
first records may be deleted-status — we already handle this.

Caveat: Corpus UL has been documented to require a browser-like UA (its F5
WAF rejects `python-requests`). We already do this in `harvest.py::DEFAULT_UA`.

### concordia — EPrints (Spectrum)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc oai_etdms oai_openaire oai_ore_atom oai_ore_rdf rdf uketd_dc`

Sample (`oai:https://spectrum.library.concordia.ca:1`) via `oai_etdms`:

```xml
<etd_ms:contributor role="advisor">Butovsky, M</etd_ms:contributor>
<etd_ms:degree>
  <etd_ms:name>M.A.</etd_ms:name>
  <etd_ms:level>masters</etd_ms:level>
  <etd_ms:discipline>English</etd_ms:discipline>
  <etd_ms:grantor>Concordia University</etd_ms:grantor>
</etd_ms:degree>
```

Same value also appears in `uketd_dc` as `<uketdterms:department>English</uketdterms:department>`.

Recommendation: switch to `oai_etdms` (canonical NDLTD ETD-MS); `uketd_dc`
also works. Both provide structured advisor + discipline.

### uqam — EPrints (Archipel)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc rdf uketd_dc` (no `oai_etdms`).

Sample via `uketd_dc`:

```xml
<uketdterms:institution>Université du Québec à Montréal</uketdterms:institution>
<uketdterms:department>Doctorat en psychologie (Essai doctoral)</uketdterms:department>
<uketdterms:qualificationname>phd</uketdterms:qualificationname>
```

Recommendation: switch to `uketd_dc`. Note: UQAM's OAI is **slow** — `ListRecords`
on the thesis set returned ~19 MB after about 30 s; expect occasional timeouts
on bulk harvests. The harvester will need a longer per-request timeout for
this source.

### uqtr — EPrints (Cognitio)

`ListMetadataFormats`: `didl etd_ms_uqtr mets oai_bibl oai_dc oai_etdms oai_openaire rdf uketd_dc`

Sample (`oai:depot-e.uqtr.ca:1153`) via `oai_etdms`:

```xml
<etdms:degree>
  <etdms:name>Mémoire</etdms:name>
  <etdms:level>Maîtrise</etdms:level>
  <etdms:discipline>Études québécoises</etdms:discipline>
  <etdms:grantor>Université du Québec à Trois-Rivières</etdms:grantor>
</etdms:degree>
```

UQTR's `uketd_dc` is unusable as a discipline source here: it omits
`uketdterms:department` entirely. UQTR also exposes a custom `etd_ms_uqtr`
prefix, but the body is identical to `oai_etdms` save for a quirky
`<etdms:subjectsss>` typo on the subject element — stick with `oai_etdms`.

Recommendation: switch to `oai_etdms`.

### uqac — EPrints (Constellation)

`ListMetadataFormats`: `didl oai_bibl oai_dc` (in `ListMetadataFormats`) — but
when probed at `metadataPrefix=uketd_dc`, the server actually answers (the
formats list is incomplete on this repo). So `uketd_dc` is available even
though not advertised.

Sample (`oai:constellation.uqac.ca:114`) via `uketd_dc`:

```xml
<dc:subject>Informatique</dc:subject>
<uketdterms:qualificationlevel>masters</uketdterms:qualificationlevel>
<uketdterms:institution>Université du Québec à Chicoutimi</uketdterms:institution>
<uketdterms:department>Maîtrise en informatique</uketdterms:department>
```

Bonus: UQAC's OAI `setSpec` values encode an internal LCSH-like taxonomy
(e.g. `subjects=SN:SN_SM:SN_SM_INFO` for "Sciences naturelles → Sciences
mathématiques → Informatique") — this is harvestable from the header even on
`oai_dc`, but is more useful as a structured taxonomy than as flat keywords.

Recommendation: switch to `uketd_dc`. Note that the formats list is
under-reported by this repo; trust the actual response not the catalogue.

### uqar — EPrints (Sémaphore)

`ListMetadataFormats`: `oai_bibl oai_dc uketd_dc` (smallest catalogue of all 15).

Sample via `uketd_dc`:

```xml
<uketdterms:qualificationlevel>masters</uketdterms:qualificationlevel>
<uketdterms:institution>Université du Québec à Rimouski</uketdterms:institution>
<uketdterms:department>Département de lettres et humanités</uketdterms:department>
```

Recommendation: switch to `uketd_dc`. UQAR exposes department names that
identify a real Quebec departmental unit (good for routing/filtering).

### uqo — EPrints (Dépôt institutionnel)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc rdf uketd_dc`

Sample (`oai:di.uqo.ca:34`) via `uketd_dc`:

```xml
<uketdterms:department>Département des sciences de l'éducation</uketdterms:department>
<uketdterms:institution>Université du Québec à Hull</uketdterms:institution>
```

Recommendation: switch to `uketd_dc`.

### uqat — EPrints (Depositum)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc rdf uketd_dc`

Sample (`oai:depositum.uqat.ca:1`) via `uketd_dc`:

```xml
<uketdterms:department>Sciences appliquées</uketdterms:department>
```

UQAT additionally encodes an internal `divisions` taxonomy in its setSpecs
(e.g. `divisions=prg_gen:pro_min` for "génie minier"). Decoded, these reveal
a department code that `uketdterms:department` only partially captures.

Recommendation: switch to `uketd_dc`; consider also parsing setSpecs to
recover the divisions code.

### inrs — EPrints (EspaceINRS)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc rdf uketd_dc`

Sample (`oai:espace.inrs.ca:2`) via `uketd_dc`:

```xml
<uketdterms:qualificationname>phd</uketdterms:qualificationname>
<uketdterms:institution>Université du Québec, Institut national de la recherche scientifique</uketdterms:institution>
<uketdterms:department>Doctorat en études urbaines</uketdterms:department>
```

INRS also has 1241 OAI sets — an unusually large taxonomy.

Recommendation: switch to `uketd_dc`.

### ets — EPrints (Espace ETS)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc rdf uketd_dc`

Sample (`oai:espace.etsmtl.ca:1`) via `uketd_dc`: **no department, no
discipline field**. The repo also has only 2 OAI sets total (one of which is
the OpenAIRE driver set), so there is no taxonomy in the headers either.
`oai_dc` carries the same content as `uketd_dc` for ÉTS.

Recommendation: **stay on `oai_dc`**. There is nothing additional to harvest
in any richer prefix at ÉTS. (If a discipline tag is needed, it would have to
come from the institution's web pages or from the thesis title heuristics —
the OAI feed simply does not contain it.)

### rlibre — EPrints (R-Libre / TÉLUQ)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc oai_etdms rdf uketd_dc`

Sample (`oai:r-libre.teluq.ca:362`) via `oai_etdms`:

```xml
<etd_ms:degree>
  <etd_ms:name>Ph. D.</etd_ms:name>
  <etd_ms:level>phd</etd_ms:level>
  <etd_ms:discipline>Informatique cognitive</etd_ms:discipline>
  <etd_ms:grantor>Université TÉLUQ</etd_ms:grantor>
</etd_ms:degree>
```

R-Libre's `uketd_dc` does not include `uketdterms:department` — `oai_etdms`
is the only way to recover the discipline. Surprise: this thesis is also
cross-deposited at UQAM (the record's `dcterms:isReferencedBy` points to
`archipel.uqam.ca`), so we may already have it from that source as well.

Recommendation: switch to `oai_etdms`.

### polymtl — EPrints (PolyPublie)

`ListMetadataFormats`: `didl mets oai_bibl oai_dc oai_etdms oai_openaire rdf rem_atom`

Sample (`oai:publications.polymtl.ca:114`) via `oai_etdms`:

```xml
<etd_ms:degree>
  <etd_ms:discipline>Génie informatique</etd_ms:discipline>
  <etd_ms:grantor>École Polytechnique de Montréal</etd_ms:grantor>
</etd_ms:degree>
```

Quirk: although Polymtl's `ListMetadataFormats` advertises `uketd_dc`, asking
for `metadataPrefix=uketd_dc&set=74797065733D746865736973` returns
`error code="cannotDisseminateFormat"`. `oai_etdms` works fine; that is the
right prefix here.

Recommendation: switch to `oai_etdms`.

### mcgill — Hyrax/Blacklight, behind WAF

Not probed today. McGill's OAI endpoint sits behind an Azure WAF that drops
unauthenticated/script-shaped requests; we currently work around it via a
Playwright harvester (`harvester/mcgill_harvest.py`). A separate audit pass —
ideally driven through that same Playwright path — should:

1. Hit `?verb=ListMetadataFormats` to enumerate prefixes (Hyrax typically
   exposes `oai_dc` plus `xoai`/`mods`/`oai_etdms`).
2. Sample a thesis record in the richest prefix.
3. Update this audit with findings.

## Recommendation

Yes, we should add a per-source `metadata_prefix` (and optional fallback)
field to `sources.yaml`. The mapping that comes out of this audit:

| Source | metadata_prefix |
|---|---|
| bishops, udem, usherbrooke, laval | `dim` |
| concordia, uqtr, rlibre, polymtl | `oai_etdms` |
| uqam, uqac, uqar, uqo, uqat, inrs | `uketd_dc` |
| ets | `oai_dc` (no upgrade available) |
| mcgill | TBD (separate Playwright audit) |

Implementation cost is small: `harvester/harvest.py::iter_records` already
accepts a `metadata_prefix` parameter, the change is purely in
`sources.yaml` plus the per-record extraction code in
`harvester/normalize.py` (which currently expects `oai_dc` only).

## Operational notes / surprises

- **UQAM** is *very slow*: a full thesis `ListRecords` is ~19 MB and took
  about 30 seconds; bulk harvests will need a longer timeout.
- **TÉLUQ (R-Libre)** was *not* flaky on this run, contrary to its
  reputation: every probe returned 200 within seconds.
- **UQAC** under-reports its `ListMetadataFormats` (advertises only
  `didl, oai_bibl, oai_dc`) but actually accepts `uketd_dc` requests — trust
  the response, not the catalogue.
- **Polymtl** does the opposite: it *advertises* `uketd_dc` but returns
  `cannotDisseminateFormat` when asked for it; use `oai_etdms` instead.
- **ÉTS** is the only source with no usable discipline anywhere in its OAI
  feed. Filtering by ÉTS discipline will require either web-scraping
  individual records or an external mapping.
- **Laval** has an unusual quirk where `etdms:degree.discipline` is emitted
  *twice* per record: once as an internal Laval code (e.g. "G 60 UL MEM"),
  once as the human-readable label ("Maîtrise en sciences géographiques -
  avec mémoire"). Take the longer / non-coded one.
- **UQTR**'s `uketd_dc` lacks `uketdterms:department` entirely. Use
  `oai_etdms` for UQTR, not `uketd_dc`.
- **R-Libre**'s thesis records also reference an UQAM Archipel URL via
  `dcterms:isReferencedBy` — there may be cross-deposit duplicates between
  these two sources worth deduplicating on harvest.
