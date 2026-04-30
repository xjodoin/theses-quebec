# Search Benchmarks

This repo has two benchmark runners for the static search stack:

- `npm run bench:search:performance` measures browser-visible latency for static backends.
- `npm run bench:search:quality` compares static backend rankings against SQLite FTS5.

The benchmarks expect a built `dist/` and a local static server. They use
`playwright-core` against an installed Chrome-compatible browser. By default the
runner tries the `chrome` channel, then `msedge`.

```bash
npm install
npm run build
PORT=5124 npm run serve
```

Leave the server running in one terminal and run benchmarks in another.

If Chrome is not on the default channel, set one of:

```bash
PLAYWRIGHT_CHROME_CHANNEL=msedge npm run bench:search:performance -- --url=http://localhost:5124/
PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome npm run bench:search:performance -- --url=http://localhost:5124/
```

## Performance

Default run, comparing `tqsearch` and Pagefind:

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

- `First ms`: first observed run for that query in the browser session. This includes loading any term/doc chunks not already cached by previous queries.
- `Median ms`: median across `--runs`.
- `P95 ms`: high-percentile latency across `--runs`.

Run the benchmark in a fresh browser session when comparing cold-ish behavior.
Run it multiple times if you want warm-cache behavior.

## Quality

Default run, comparing `tqsearch` and Pagefind against SQLite FTS5:

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

## Recent Reference Run

On the current prototype branch after adding numeric-token and title-shingle
support:

```text
tqsearch known item: Hit@1 83.3%, Hit@3 94.0%, Hit@10 96.0%, MRR@10 0.882
SQLite known item:   Hit@1 90.7%, Hit@3 97.3%, Hit@10 98.0%, MRR@10 0.940
tqsearch vs SQLite known-item Overlap@10: 84.8%
tqsearch vs SQLite topical Overlap@10:    31.6%
```

That means `tqsearch` is close to SQLite for known-item retrieval, but it does
not mimic SQLite ranking for broad topical queries.
