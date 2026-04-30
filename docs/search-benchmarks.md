# Search Benchmarks

This repo has two benchmark runners for the static search stack:

- `npm run bench:search:performance` measures browser-visible latency for static backends.
- `npm run bench:search:quality` compares static backend rankings against SQLite FTS5.

The benchmarks expect a built `dist/` and a local static server. They use
`playwright-core` against an installed Chrome-compatible browser. By default the
runner tries the `chrome` channel, then `msedge`.

```bash
npm install
npm run build:bench
PORT=5124 npm run serve
```

`npm run build` is the production GitHub Pages build and ships `tqsearch` only.
Use `npm run build:bench` when comparing against Pagefind.

Leave the server running in one terminal and run benchmarks in another.

If Chrome is not on the default channel, set one of:

```bash
PLAYWRIGHT_CHROME_CHANNEL=msedge npm run bench:search:performance -- --url=http://localhost:5124/
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome npm run bench:search:performance -- --url=http://localhost:5124/
```

## Performance

Default run, comparing `tqsearch` and Pagefind from a `build:bench` artifact:

```bash
npm run bench:search:performance -- --url=http://localhost:5124/
```

Useful options:

```bash
# More repetitions per query
npm run bench:search:performance -- --url=http://localhost:5124/ --runs=5

# Only one backend
npm run bench:search:performance -- --url=http://localhost:5124/ --engines=tqsearch

# Custom query set. Separate queries with |
npm run bench:search:performance -- --url=http://localhost:5124/ \
  --queries='sante|education|diabete type 1|intelligence artificielle'

# Machine-readable output
npm run bench:search:performance -- --url=http://localhost:5124/ --json
```

The table reports:

- `Init req` / `Init KB`: backend initialization requests and transfer size for
  the static engine files loaded before the first query.
- `First req` / `First KB`: requests and transfer size observed during the first
  run for that query. This is the best proxy for cold shard/doc-chunk cost.
- `First ms`: first observed run for that query in the browser session. This includes loading any term/doc chunks not already cached by previous queries.
- `Median ms`: median across `--runs`.
- `P95 ms`: high-percentile latency across `--runs`.

Run the benchmark in a fresh browser session when comparing cold-ish behavior.
Run it multiple times if you want warm-cache behavior.

## Quality

Default run, comparing `tqsearch` and Pagefind against SQLite FTS5 from a
`build:bench` artifact:

```bash
npm run bench:search:quality -- --url=http://localhost:5124/
```

Useful options:

```bash
# Only one browser backend
npm run bench:search:quality -- --url=http://localhost:5124/ --engines=tqsearch

# Larger known-item sample
npm run bench:search:quality -- --url=http://localhost:5124/ --known=300

# Custom topical query set
npm run bench:search:quality -- --url=http://localhost:5124/ \
  --topical='sante|education|diabete type 1|changements climatiques'

# Full JSON with example disagreements
npm run bench:search:quality -- --url=http://localhost:5124/ --json
```

Quality has two sections:

- Known-item retrieval: builds deterministic queries from thesis titles and checks whether the original thesis appears in the top 10. Metrics are `Hit@1`, `Hit@3`, `Hit@10`, and `MRR@10`.
- Agreement with SQLite top 10: checks whether SQLite's top result appears in the browser backend top 1/3/10, and reports average `Overlap@10`.

SQLite is a reference, not ground truth. Low agreement can mean the static
backend is worse, but it can also mean the ranking objective differs. Use the
JSON output to inspect disagreements before changing scoring.

## Recent Reference Runs

Production `tqsearch` build after adding adaptive gzip term shards and
compressed columnar code tables:

```text
tqsearch known item: Hit@1 97.3%, Hit@3 99.3%, Hit@10 99.3%, MRR@10 0.983
SQLite known item:   Hit@1 94.0%, Hit@3 99.3%, Hit@10 99.3%, MRR@10 0.963

tqsearch vs SQLite known-item Overlap@10: 88.1%
tqsearch vs SQLite topical Overlap@10:    38.5%
```

The same production build kept `tqsearch` warm-query medians around 0-4 ms for
the default query set. `tqsearch` initialized with 6 search-asset requests /
700.7 KB, and first-query shard/doc fetches for the default non-empty queries
ranged from 5-12 requests / 228.0-523.6 KB / 26-48 ms.

Latest Pagefind comparison from a `build:bench` artifact:

```text
Pagefind known item: Hit@1 90.7%, Hit@3 97.3%, Hit@10 97.3%, MRR@10 0.939
Pagefind vs SQLite topical Overlap@10: 19.0%
Pagefind init: 9 requests / 2069.7 KB
Pagefind first-query range: 10-15 requests / 52.8-1911.8 KB / 223-4381 ms
```

The implementation notes for the standalone static engine are in
[`docs/static-search-design.md`](static-search-design.md).
