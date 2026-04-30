# Static Search Design

`tqsearch` is a prototype for a standalone static search engine. The builder
reads `data/theses.db` as source data, but ranking is computed by the builder's
own retrieval model and shipped as static files. It does not precompute or cache
SQLite answers.

## Retrieval Model

The index uses BM25F-style fielded scoring:

- Field term frequencies are weighted and length-normalized first.
- BM25 saturation is applied once to the combined weighted frequency.
- IDF is applied when final term shards are reduced.

This follows Robertson, Zaragoza, and Taylor's BM25F argument that field scores
should not be linearly combined after independent saturation. For thesis search,
the current fields are `title`, `authors`, `advisors`, `subjects`,
`discipline`, `abstract`, `source`, and `year`.

The builder also emits title bigram/trigram impact terms. They are compact
phrase signals for known-item and title-intent searches without requiring full
positional indexes in the browser.

## Static Index Layout

The build emits:

- `manifest.json`: total count, facets, source dictionaries, shard names, and
  the first default results.
- `codes.bin.gz`: compressed columnar per-document facet/year codes for browser
  filtering and facet counts.
- `docs/*.json`: lazy-loaded result payload chunks. Chunks are intentionally
  small so rendering 10 search cards does not pull large unrelated payloads.
- `terms/*.bin.gz`: gzip-compressed binary term shards containing
  impact-sorted postings.

Each term shard has a compact term directory followed by varint-encoded
`[docIndex, impact]` postings. The browser fetches the compressed shard,
inflates it with the browser's native `DecompressionStream`, parses the
directory, and decodes postings lazily only for query terms.

Shard keys are adaptive. The builder first writes temporary three-character
posting runs, then splits only oversized prefixes to four or five characters
before writing final shards. Common prefixes such as `int` and `app` therefore
no longer force the browser to download every term with that prefix, while
uncommon prefixes keep the simpler three-character layout.

## Scalable Builder

The builder is file-backed:

1. Stream rows once to measure average BM25F field lengths.
2. Stream rows again to write document chunks and temporary posting runs.
3. Reduce one posting shard at a time into the final static term shard.
4. Delete the temporary `_build` directory.

Peak memory is therefore bounded by the current document, small posting buffers,
facet/code arrays, and one shard reducer. It does not keep all source rows or all
postings in memory.

## Research Basis

- BM25F: fielded term frequencies are combined before BM25 saturation.
  See Robertson, Zaragoza, and Taylor, "Simple BM25 extension to multiple
  weighted fields" (CIKM 2004): https://dblp.org/rec/conf/cikm/RobertsonZT04
- Block-Max WAND: static shards can later add per-block max impacts for safe
  skipping during top-k evaluation. See Ding and Suel, "Faster Top-k Document
  Retrieval Using Block-Max Indexes" (SIGIR 2011):
  https://research.engineering.nyu.edu/~suel/papers/bmw.pdf
- Impact-ordered indexes: the current postings are already impact-sorted, which
  is compatible with score-at-a-time and anytime retrieval work. See Lin and
  Trotman, "Anytime Ranking for Impact-Ordered Indexes" (ICTIR 2015):
  https://cs.uwaterloo.ca/~jimmylin/publications/Lin_Trotman_ICTIR2015.pdf
- Learned sparse expansion: a future standalone engine could add optional
  offline expansion weights while keeping the browser index sparse and lexical.
  See SPLADE: https://arxiv.org/abs/2107.05720

## Next Engine Work

- Add block metadata to the binary postings format and use it for safe top-k
  skipping once the UI can accept approximate facet counts for early results.
- Add delta coding for doc IDs in optional document-ordered posting blocks while
  preserving the current impact-ordered path for fast first results.
- Add an optional offline sparse-expansion hook. The output should be just extra
  weighted terms in the same impact index, not a runtime model requirement.
