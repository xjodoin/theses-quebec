# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Aggregator of Quebec university theses & dissertations. Harvests 16 institutional repositories via OAI-PMH, normalizes Dublin Core variants, classifies into 74 canonical disciplines (Érudit-aligned), and serves search through two interchangeable frontends (FastAPI + static Pagefind). The DB ships in `data/theses.db` via Git LFS — clone with `git lfs install` first.

## Commands

```bash
# Setup
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm install                                    # for the static build

# Run the FastAPI app + frontend (same origin)
.venv/bin/uvicorn api.app:app --host 127.0.0.1 --port 8000

# Build the static (Pagefind) variant — reads data/theses.db, writes dist/
npm run build && npm run serve                 # serve at :5000

# Tests (Python 3.11+)
.venv/bin/python -m pytest tests/ -q
.venv/bin/python -m pytest tests/test_classify.py -q
.venv/bin/python -m pytest tests/test_classify.py::test_didactique_beats_education -q

# Harvest
.venv/bin/python harvester/harvest.py                              # all sources, incremental
.venv/bin/python harvester/harvest.py --only concordia udem        # subset
.venv/bin/python harvester/harvest.py --full --only ets            # ignore checkpoint
.venv/bin/python harvester/harvest.py --max-per-source 200         # smoke
.venv/bin/python harvester/mcgill_harvest.py --full                # McGill is separate (Playwright)
.venv/bin/python harvester/mcgill_harvest.py --headed              # debug Azure WAF visually

# LLM batch classification of records the rules left unclassified
.venv/bin/python harvester/llm_classify.py run --limit 10          # smoke
.venv/bin/python harvester/llm_classify.py run                     # full
.venv/bin/python harvester/llm_classify.py poll BATCH_NAME         # resume after Ctrl-C

# Re-apply rule classifier across the existing DB (won't overwrite stronger sources)
.venv/bin/python harvester/reclassify.py
```

## Architecture: pipeline shape

```
OAI-PMH endpoints  ─►  parsers.py       ─►  normalize.py      ─►  classify.py     ─►  db.py
(4 metadata          (one parser per       (DC variants →         (3-pass rules,      (SQLite + FTS5
 prefixes)            prefix → unified      unified record;        with discipline-     contentless,
                      record dict)          filters out           source rank)         triggers keep
                                            non-theses)                                 FTS in sync)
```

The same `harvest_source()` drives every repository — sources differ only in `metadata_prefix` (chosen per repo to surface qualified discipline/degree fields) and, for McGill, the `record_iter` callable that funnels OAI-PMH calls through Playwright.

## Architecture: the four metadata-prefix worlds

OAI-PMH speaks several Dublin Core dialects. The choice in `harvester/sources.yaml` is **load-bearing** for type classification (thèse vs mémoire) and discipline classification — pick the prefix that exposes degree level + discipline:

| Prefix | Sources | Carries |
|---|---|---|
| `oai_dc` | (none — fallback only) | bare DC; collapses degree to `<dc:type>` |
| `dim` | UdeM, Sherbrooke, Bishop's, Laval | DSpace qualified fields: `dc.subject@discipline`, `thesis.degree.{level,name,discipline}`, `etd.degree.*`, `etdms.degree.*` (schema name varies by distro) |
| `oai_etdms` | Concordia, UQTR, TÉLUQ, Polytechnique, McGill | `<thesis><degree><level/name/discipline/grantor>` — three namespace URIs (1.0, 1.0-dash for Hyrax, 1.1) |
| `uketd_dc` | UQAM, UQAC, UQAR, UQO, UQAT, INRS, ÉTS | `<uketdterms:{department,degreelevel,qualificationlevel,qualificationname,institution}>` |

Two non-obvious points:

1. **Empty-payload fallback**: when a richer prefix returns `<wrapper/>` with no children (UQAM does this on older records), `harvest.ingest_record` re-fetches that single record with `oai_dc` via `_fetch_oai_dc_record`. Counted as `fallback` in stats; data never gets dropped silently.
2. **McGill ETDMS skip-window**: McGill's Blacklight provider aborts a `ListRecords` page with `cannotDisseminateFormat` when any record in the page can't be serialized. `mcgill_harvest._bump_token_offset` parses the resumption token's trailing `:OFFSET` cursor and increments by 1 until a clean page comes back. Lost records keep their previously-harvested data.

## Architecture: classification

`classify.classify_discipline_detailed` returns `(discipline, source_tag)` after up to three passes:

1. **Pass 0 — `auth`**: scan only the source-curated `authoritative_discipline` string (DSpace `subject@discipline`, ETDMS `degree.discipline`, UKETD `department`).
2. **Pass 1 — `rule`**: scan title + subjects + publisher (the "primary blob"). All keywords count.
3. **Pass 2 — `rule_abstract`**: scan the abstract, but skip keywords listed in `BROAD_KEYWORDS` (e.g. "education" appearing as a control variable in an econometrics abstract).

Within each pass, `DISCIPLINE_RULES` is scanned **in declared order** — specific disciplines (Didactique) must appear before parent ones (Sciences de l'éducation) so the first match wins. `BROAD_KEYWORDS` exists because abstracts are noisy: keywords like "education", "law", "literature" hijack classification when they appear incidentally.

`db.upsert_thesis` enforces a precedence rank so weaker classifications never overwrite stronger ones across re-harvests:

```
manual (4) > auth (3) > llm (2) > rule_abstract (1) > rule (0)
```

The `type` column (thesis/memoire) is updated unconditionally; only `discipline` and `discipline_source` are gated by rank.

## Architecture: type detection (thèse vs mémoire)

`normalize._classify_type` looks at `dc:type` first (the explicit field, populated by parsers from `degree.level`/`qualificationlevel`/`qualificationname`), then falls back to scanning title/subjects/abstract for thesis hints. Scan order: `DOCTORAL_TYPE_SIGNALS` → `MASTER_TYPE_SIGNALS` → `THESIS_TYPE_HINTS` (generic). When a generic hint matches, the code re-checks for "master"/"maitrise"/"memoire" before defaulting to doctoral. Bare uketd_dc tokens (`"doctoral"`, `"masters"`) and ETDMS `degree.name` strings (`"doctor of"`) are recognized — required because `dc:type="Mémoire ou thèse"` (ÉTS) or `dc:type="Thèse"` (INRS, UQO) is ambiguous on its own.

Adding a new source: pick the richest prefix it advertises. If degree level isn't surfaced anywhere, masters records will fall through to the default ("thesis"). Audit by checking `SELECT type, COUNT(*) FROM theses WHERE source_id=? GROUP BY type` against the institution's known degree mix.

## Architecture: the two frontends

`web/common.js` is the shared UI controller (search loop, facets, modal, citations, "did you mean?", decade chart). It's loaded by both `index.html` (FastAPI) and `static.html` (Pagefind) and dispatches every search to a backend adapter:

- `web/backends/fastapi.js` → `/api/search`, `/api/facets`, `/api/sources`
- `web/backends/pagefind.js` → Pagefind WASM chunks at `dist/pagefind/`

The static build (`scripts/build.mjs`) reads `data/theses.db`, writes per-record HTML pages, runs Pagefind to index them, and emits `dist/{index.html,pagefind/,meta.json}`. The static frontend is not a separate UI — same JS, different backend.

## Repo conventions

- **Discipline taxonomy is fixed**: 74 canonical labels in `harvester/classify.py:DISCIPLINE_RULES`. The Gemini batch in `llm_classify.py` constrains its `responseSchema` to the same enum, so labels stay coherent across rule and LLM passes. Adding/renaming a label requires updating both.
- **`harvester/sources.yaml` is the only place to add a repo** for OAI-PMH-speaking sources. Pick `metadata_prefix` based on what qualified fields the repo exposes (run `?verb=ListMetadataFormats` and inspect a sample record). McGill-style sources need a separate harvester module that supplies `record_iter` to `harvest_source`.
- **DB is distributed via GitHub Releases, not committed**. After a harvest, run `npm run db:release` to publish a new `db-YYYY-MM-DD` release (zstd-compressed, ~75 MB; ~666 MB raw). Contributors run `npm run db:fetch` after cloning to download it. Pages CI does the same in `.github/workflows/pages.yml` and triggers on `release: [published]`. The earlier LFS approach (one ~666 MB blob per commit) blew through the 1 GB free quota.
- **FTS5 mirror auto-rebuilds**. `slim_db()` (in `harvester/db.py`) drops the `theses_fts` mirror before publishing — saves ~34%. Any subsequent `connect()` repopulates it from the base table (~8 s; checks the `theses_fts_idx` shadow table, not COUNT, since external-content FTS5 proxies COUNT to the base table even when empty).
- **Incremental harvest is default**. `harvest_state.last_harvest_started` is checkpointed only on clean completion; crashed runs re-harvest the same window next time. Use `--full` to force full re-harvest after fixing a parser/classifier bug that needs to revisit existing records.
- **Tests are pytest**, in `tests/`. `conftest.py` provides shared fixtures (in-memory DB, sample OAI XML). Run a single test with `pytest tests/test_X.py::test_name -q`.
