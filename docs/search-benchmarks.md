# Search Benchmarks

This repo has two benchmark runners for the static search stack:

- `npm run bench:search:performance` measures browser-visible latency for static backends.
- `npm run bench:search:quality` compares static backend rankings against SQLite FTS5, with Apache Lucene still available as an opt-in fuzzy-search reference.

The benchmarks expect a built `dist/` and a local static server. They use
`playwright-core` against an installed Chrome-compatible browser. By default the
runner tries the `chrome` channel, then `msedge`.

The optional Lucene quality baseline requires Java and Maven. It builds an in-memory
Lucene index from `data/theses.db` at benchmark startup; it does not use the
static TQSearch artifact.

```bash
npm install
npm run build:bench
PORT=5124 npm run serve
```

`npm run build` is the production GitHub Pages build and ships `tqsearch` only.
Use `npm run build:bench` when comparing against Rangefind. Use
`node scripts/build.mjs --with-pagefind` only for legacy Pagefind checks. Use
`npm run build:expanded` only when evaluating generated sparse expansion; it is
not the default production path unless the expansion improves the measured
quality/performance tradeoff.

Rangefind typo indexing is enabled in the thesis comparison build by default.
Disable it with `node scripts/build.mjs --with-rangefind --no-rangefind-typo`
only when isolating base ranking and artifact size.

Leave the server running in one terminal and run benchmarks in another.

If Chrome is not on the default channel, set one of:

```bash
PLAYWRIGHT_CHROME_CHANNEL=msedge npm run bench:search:performance -- --url=http://localhost:5124/
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome npm run bench:search:performance -- --url=http://localhost:5124/
```

## Performance

Default run, comparing `tqsearch` and Rangefind from a `build:bench` artifact:

```bash
npm run bench:search:performance -- --url=http://localhost:5124/
```

Useful options:

```bash
# More repetitions per query
npm run bench:search:performance -- --url=http://localhost:5124/ --runs=5

# Only one backend
npm run bench:search:performance -- --url=http://localhost:5124/ --engines=tqsearch

# Compare first-stage tqsearch against the dependency reranker
npm run bench:search:performance -- --url=http://localhost:5124/ \
  --engines=tqsearch --variants

# Custom query set. Separate queries with |
npm run bench:search:performance -- --url=http://localhost:5124/ \
  --queries='sante|education|diabete type 1|intelligence artificielle'

# Filtered search path. Separate multi-select filters with |
npm run bench:search:performance -- --url=http://localhost:5124/ \
  --engines=tqsearch \
  --queries='sante|education|intelligence artificielle|diabete type 1' \
  --source=udem --discipline='Psychologie' --year-min=2010

# Machine-readable output
npm run bench:search:performance -- --url=http://localhost:5124/ --json
```

Other useful switches:

- `--no-rerank`: disables the tqsearch dependency-feature reranker.
- `--no-exact-refine`: measures only the fast first-page response and skips the
  exact follow-up request.
- `--dist=/path/to/dist`: changes the local artifact directory used for index
  file-count and byte-size reporting.

The performance report has two sections. `Index / build artifact` reports local
index footprint plus manifest stats when available: file count, bytes, terms,
postings, logical shards, term bytes/files/packs, typo-sidecar bytes/files/packs
/delete keys, scoring model, and whether learned sparse expansion is baked into
the artifact.

`Query path` reports:

- `Total`: result count reported by the backend. A `+` suffix means a fast
  lower-bound response; the UI issues an exact refinement after rendering the
  first results.
- `Init req` / `Init KB`: backend initialization requests and transfer size for
  the static engine files loaded before the first query.
- `Fast req` / `Fast KB`: requests and transfer size observed during the first
  run for that query. This is the best proxy for cold shard/doc-chunk cost.
- `Fast ms`: first observed fast run for that query in the browser session.
  This includes loading any term/doc chunks not already cached by previous
  queries.
- `Refine req` / `Refine KB` / `Refine ms`: extra work for an exact follow-up
  request when the fast response is approximate. This mimics the UI path after
  the first page paints.
- `First KB`: fast plus exact-refinement transfer for the first-page path.
- `Median ms`: median across `--runs`.
- `P95 ms`: high-percentile latency across `--runs`.
- `Blocks`, `Postings`, and `Skip`: first-stage shard work from tqsearch's
  runtime stats.
- `Rerank` and `Dep hits`: dependency-feature reranker candidate count and
  matched candidate features.
- `Exact@10`: top-10 overlap between the fast page and exact refinement for that
  query.

Run the benchmark in a fresh browser session when comparing cold-ish behavior.
Run it multiple times if you want warm-cache behavior.

## Quality

Default run, comparing `tqsearch` and Rangefind against SQLite FTS5 from
a `build:bench` artifact:

```bash
npm run bench:search:quality -- --url=http://localhost:5124/
```

Useful options:

```bash
# Only one browser backend
npm run bench:search:quality -- --url=http://localhost:5124/ --engines=tqsearch

# Add the Lucene reference backend
npm run bench:search:quality -- --url=http://localhost:5124/ \
  --engines=tqsearch,rangefind,lucene

# Disable the automatic tqsearch-base / tqsearch reranker split
npm run bench:search:quality -- --url=http://localhost:5124/ \
  --engines=tqsearch --no-variants

# Larger known-item sample
npm run bench:search:quality -- --url=http://localhost:5124/ --known=300

# Larger deterministic typo-recovery sample
npm run bench:search:quality -- --url=http://localhost:5124/ --typos=300

# Custom topical query set
npm run bench:search:quality -- --url=http://localhost:5124/ \
  --topical='sante|education|diabete type 1|changements climatiques'

# Full JSON with example disagreements
npm run bench:search:quality -- --url=http://localhost:5124/ --json
```

Other useful switches:

- `--exact-check=N`: controls how many mixed known-item/topical queries are
  checked against tqsearch's exact path. The default is `50`.

Quality has five sections:

- Known-item retrieval: builds deterministic queries from thesis titles and checks whether the original thesis appears in the top 10. Metrics are `Hit@1`, `Hit@3`, `Hit@10`, and `MRR@10`.
- Agreement with SQLite top 10: checks whether SQLite's top result appears in the browser backend top 1/3/10, and reports average `Overlap@10` plus rank-sensitive `NDCG@10`.
- Typo recovery: mutates one deterministic token in known-item queries, checks
  whether the target thesis is recovered, compares typo results with clean-query
  results, and reports typo fallback diagnostics.
- Fast vs exact agreement: checks whether tqsearch's fast top-k path preserves
  exact top-1/top-10 ordering for the sampled queries.
- Runtime diagnostics: averages approximate response rate, decoded blocks,
  decoded postings, skipped blocks, rerank candidates, and dependency-feature
  candidate hits across the quality run.

SQLite is a reference, not ground truth. Low agreement can mean the static
backend is worse, but it can also mean the ranking objective differs. Use the
JSON output to inspect disagreements before changing scoring.

## Learned Sparse Expansion Builds

External learned sparse expansion is a build-time input. The file is JSONL and
can be generated by Doc2Query, DeepImpact, SPLADE, or a smaller domain-specific
model:

```bash
npm run search:expand -- --out=/tmp/expansions.jsonl

npm run build:tqsearch -- \
  --sparse-expansions=/path/to/expansions.jsonl \
  --sparse-expansion-limit=48 \
  --sparse-expansion-scale=1
```

The whole site can also be built with the repo's current corpus-generated
expansion producer:

```bash
npm run build:expanded
```

Records should prefer zero-based `doc` indexes for scalable standalone builds:

```json
{"doc":0,"terms":[{"term":"apprentissage automatique","weight":0.82}]}
```

The builder writes sparse-expansion stats into `tqsearch/manifest.json`, and the
performance bench includes those stats in `--json` plus the index summary table.

Current measured status: the broad corpus-generated expansion variants were not
promoted to the default build. The tested 3.37M-term association/abstract/subject
variant reduced known-item `MRR@10` from `0.990` to `0.986` and topical
`NDCG@10` from `45.9%` to `37.1%`. The conservative subject/discipline phrase
variant preserved known-item `MRR@10` but still reduced topical `NDCG@10` to
about `41.8%`. Keep expansion builds experimental until a learned producer beats
the default path on the quality bench.

## Recent Reference Runs

Production `tqsearch` build after tuning title BM25F normalization, adding a
dependency-feature reranker, and packing both the main term index and the
surface-form typo sidecar behind HTTP Range requests:

```text
SQLite known item:        Hit@1 94.0%, Hit@3 99.3%, Hit@10 99.3%, MRR@10 0.963
tqsearch-base known item: Hit@1 97.3%, Hit@3 99.3%, Hit@10 100.0%, MRR@10 0.985
tqsearch known item:      Hit@1 98.7%, Hit@3 99.3%, Hit@10 100.0%, MRR@10 0.992
Lucene known item:        Hit@1 90.7%, Hit@3 92.0%, Hit@10 92.7%, MRR@10 0.914

tqsearch-base vs SQLite known-item Overlap@10: 88.0%
tqsearch vs SQLite known-item Overlap@10:      88.0%
tqsearch vs SQLite topical Overlap@10:         38.2%
tqsearch vs SQLite known-item NDCG@10:         91.5%
tqsearch vs SQLite topical NDCG@10:            46.7%
Lucene vs SQLite topical Overlap@10:           29.7%
Lucene vs SQLite topical NDCG@10:              30.9%

SQLite typo target Hit@10:   0.8%, MRR@10 0.008
tqsearch typo target Hit@10: 96.7%, MRR@10 0.963
Lucene typo target Hit@10: 88.3%, MRR@10 0.865

tqsearch fast vs exact top-10 match: 100.0%
```

The same production build kept `tqsearch` warm-query medians around 0-9 ms for
the default query set. The local `tqsearch` artifact was 353.5 MB by raw file
bytes, about 377 MB by disk usage, with 3,729,571 terms, 18,811,831 postings,
and 23,396 adaptive logical term shards packed into 29 range files plus one lazy
binary range directory. The typo sidecar was 69.0 MB with 11,414,864 delete keys
across 8,801 logical typo shards packed into 18 range files plus one manifest.
The whole artifact had 1,926 files.

It initialized with 4 search-asset requests / 178.9 KB. The first real term
query in a fresh browser pays one lazy `terms/ranges.bin.gz` request; later
queries reuse that directory. Fast first-page responses for the default
non-empty queries were 6-14 requests / 247.0-685.1 KB / 22-67 ms in the latest
run and return lower-bound totals marked with `+`. Exact refinement added 0-1
extra requests / 0-270.8 KB / 0-10 ms in that run, and every default query had
100% top-10 overlap with the exact result.

Representative zero-result typo fallbacks from the same artifact:

```text
allumage alcools motuers:          16 requests / 972.5 KB / 81 ms cold
specialisees renouveau plastiqyes: 11 requests / 702.8 KB / 65 ms cold
horeur peur ecoute:                 8 requests / 273.6 KB / 40 ms cold
fundry pipe probe:                 13 requests / 781.6 KB / 61 ms cold
```

Filtered fast-path run with `--source=udem --discipline='Psychologie'
--year-min=2010`:

```text
sante: 204+ results, 12 requests / 680.0 KB / 41 ms first run
education: 29+ results, 11 requests / 388.6 KB / 42 ms first run
intelligence artificielle: 7+ results, 8 requests / 305.1 KB / 33 ms first run
diabete type 1: 1+ results, 4 requests / 315.7 KB / 17 ms first run
```

For those filtered queries, fast top 10 matched exact top 10. The generic block
filter summaries skipped 7, 67, 6, and 50 candidate blocks respectively before
decoding.

Latest Rangefind comparison from a `build:bench` artifact, with Rangefind typo
enabled:

```text
tqsearch known item:  Hit@1 99.0%, Hit@3 100.0%, Hit@10 100.0%, MRR@10 0.995
Rangefind known item: Hit@1 99.0%, Hit@3 100.0%, Hit@10 100.0%, MRR@10 0.995

tqsearch vs SQLite known-item Overlap@10: 87.0%
Rangefind vs SQLite known-item Overlap@10: 87.2%
tqsearch vs SQLite topical NDCG@10: 46.7%
Rangefind vs SQLite topical NDCG@10: 47.6%

tqsearch typo target Hit@10: 95.9%, MRR@10 0.954
Rangefind typo target Hit@10: 95.9%, MRR@10 0.954

tqsearch local artifact: 353.5 MB raw bytes, 1,926 files
Rangefind local artifact: 356.4 MB raw bytes, 1,927 files
tqsearch init: 4 requests / 178.9 KB
Rangefind init: 10 requests / 169.5 KB
tqsearch first-query range: 6-14 requests / 247.0-685.1 KB / 27-56 ms
Rangefind first-query range: 7-14 requests / 298.1-702.2 KB / 32-60 ms
```

Rangefind now matches `tqsearch` on the deterministic known-item and typo
samples while slightly improving SQLite agreement on this run. Multi-term
Rangefind queries can now return block-max top-k lower bounds; the exact
refinement check had 100% top-10 overlap for the approximate queries in the
default performance run. The cost is a bench artifact in the same size class as
`tqsearch` and a higher initialization request count because the standalone
runtime still loads more small static modules.

The implementation notes for the standalone static engine are in
[`docs/static-search-design.md`](static-search-design.md).
