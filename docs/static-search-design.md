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

The title field uses stronger length normalization than the first prototype.
That favors exact concise title matches over longer titles that merely contain
the same rare query terms, and improved the measured known-item and topical
quality benches without changing runtime cost.

The builder also emits title bigram/trigram impact terms. They are compact
phrase signals for known-item and title-intent searches without requiring full
positional indexes in the browser.

The latest build adds a separate dependency-feature layer. During indexing, the
builder emits a bounded number of unordered title proximity features per
document into the same sparse shard format. They are not used for recall, result
counts, or minimum-match eligibility. At query time, the runtime first retrieves
with the normal BM25F impact terms, then reranks only the top candidate window
with those dependency features. This keeps the public shape close to a
standalone engine: schemas can declare extra dependency fields without changing
the core inverted-index reader.

The builder also has an optional learned sparse-expansion hook for Doc2Query,
DeepImpact, SPLADE, or any future model that can emit weighted lexical terms.
Expansion is a build-time input, not a browser dependency. The engine accepts
JSONL records such as:

```json
{"doc":0,"terms":[{"term":"apprentissage automatique","weight":0.82}]}
```

`doc` / `doc_index` are zero-based document indexes for the most scalable path.
For this corpus adapter, `id`, `rowid`, `doc_id`, `oai_identifier`, and `url`
are also accepted through a lookup map. The terms are normalized with the same
analyzer, bounded per document, and written as ordinary weighted postings.
Because the output is still just sparse terms, the runtime remains a static
inverted-index reader.

`scripts/generate_tqsearch_sparse_expansions.mjs` is the current standalone
producer prototype for that contract. It learns corpus document frequencies,
optionally learns bounded term associations, and can emit controlled-field
phrases, abstract phrases, and associated lexical terms as weighted JSONL. The
generator is deliberately separate from the indexer: generated expansion is an
experiment input, not an implicit runtime dependency. In the current corpus
benchmarks, broad generated expansion hurt ranking quality, so the production
path keeps sparse expansion disabled until a producer beats the default quality
bench.

## Typo Tolerance

The current prototype uses a static noisy-channel sidecar instead of loading a
large fuzzy automaton or a runtime database. At build time, the indexer emits a
file-backed SymSpell/FastSS-style delete-key dictionary. Delete keys are learned
from raw surface forms, but each candidate points to the normalized index term.
That matters for this corpus because the analyzer can stem a surface word such
as `moteurs` to a short index term such as `mot`; a stem-only typo dictionary
cannot verify `motuers -> moteurs -> mot`.

The sidecar is still static:

- The builder streams per-document surface/index-term pairs into temporary
  delete-key runs, then reduces those runs into adaptive logical binary shards.
  Each logical shard is compressed independently and packed into a small set of
  `tqsearch/typo/packs/*.bin` files.
- Each typo shard has a front-coded delete-key directory and a varint candidate
  pair table. The pair table stores `surface`, normalized `term`, and corpus
  prior once; delete-key lists store compact pair ids.
- Runtime typo work is zero for normal successful queries. The fallback only
  runs for first-page relevance searches whose exact result count is zero.
- Candidate generation range-fetches only the packed byte spans touched by the
  query, verifies candidates with bounded Damerau-Levenshtein distance, ranks
  them with corpus prior plus sequence similarity, and then tests a small set of
  single-token correction plans against the normal exact search path.
- The accepted correction is therefore not just the closest dictionary word; it
  must improve retrieval for the whole query.

The typo shard keys are adaptive like the main term shards: common two-character
prefixes split deeper to reduce cold fallback transfer, while uncommon prefixes
stay shallow. The current default stops at depth 3 with a target of about 12,000
candidates per shard; this keeps file count and disk overhead reasonable while
preserving most of the cold-transfer win. This is a standalone-friendly design.
A future package can expose the same surface-to-index-term contract for any
analyzer, language, or schema, while keeping typo tolerance as optional static
files that are only fetched on zero-result fallbacks.

The sidecar uses HTTP `Range` rather than thousands of deployed physical shard
files. `typo/manifest.json` stores a compact sorted shard list and a parallel
`shard_ranges` table of `[packIndex, offset, length]`. Runtime fallback groups
nearby ranges within the same pack when the unused gap is small, so it can lower
HTTP request count without turning a narrow correction into a large download.
The local preview server implements `206 Partial Content`, matching the static
hosting path used by GitHub Pages.

## Static Index Layout

The build emits:

- `manifest.json`: total count, facets, source dictionaries, shard names, and
  the first default results.
- `codes.bin.gz`: compressed columnar per-document facet/year codes for browser
  filtering and exact facet counts. The runtime loads this lazily, so opening
  the search page no longer downloads the full filter table.
- `docs/*.json`: lazy-loaded result payload chunks. Chunks are intentionally
  small so rendering 10 search cards does not pull large unrelated payloads.
- `terms/ranges.bin.gz` and `terms/packs/*.bin`: range-addressed term shards
  containing impact-sorted postings, including optional dependency-feature and
  learned sparse-expansion postings. Each logical term shard is independently
  compressed inside a pack.
- `typo/manifest.json` and `typo/packs/*.bin`: optional typo-tolerance
  delete-key sidecar. The packs contain independently compressed logical shards
  addressed through HTTP byte ranges.

Each term shard has a compact term directory followed by varint-encoded
`[docIndex, impact]` postings. Directory entries include 128-posting block
metadata with each block's byte offset, max remaining impact, and generic filter
summaries. The browser lazily fetches `terms/ranges.bin.gz` on the first real
term query, range-fetches only the compressed shard members it needs from
`terms/packs/*.bin`, inflates them with the browser's native
`DecompressionStream`, parses the directories, and decodes postings lazily only
for query terms.

Block filter summaries are schema-driven, not hardcoded into the shard logic.
The current site config emits:

- Facet bitsets for `source`, `discipline`, and `type`.
- Numeric min/max ranges for `year`.

For another corpus, a standalone builder can provide a different
`block_filters` schema while keeping the same shard format and runtime
interpreter.

Shard keys are adaptive. The builder first writes temporary three-character
posting runs, then splits only oversized prefixes to four or five characters
before writing final shards. Common prefixes such as `int` and `app` therefore
no longer force the browser to download every term with that prefix, while
uncommon prefixes keep the simpler three-character layout.

The physical term files are also packed for static hosting. The range directory
is deliberately separate from the main manifest so an empty/default page load
does not pay for term offsets. A search query pays one cached directory fetch,
then subsequent queries range directly into the pack files.

For first-page relevance searches, the runtime uses the block metadata as an
impact-ordered top-k bound. With active filters, it first checks the generic
block summaries and skips blocks whose facet bitsets or numeric ranges cannot
match the query. It then decodes the highest-impact remaining blocks and stops
when no unseen or partially seen document can enter the current top results.
That response carries lower-bound totals and global facets so it can render
immediately. The UI then issues an exact refinement request, which loads
`codes.bin.gz` only if needed and updates exact totals/facets.

After top-k scoring, relevance-sorted searches rerank the top candidate window
with the dependency-feature postings. Because the reranker touches only already
eligible candidates, it cannot change recall or facet totals; it can only refine
the order of the first page.

## Scalable Builder

The builder is file-backed:

1. Stream rows once to measure average BM25F field lengths.
2. Stream rows again to write document chunks and temporary posting runs.
3. Reduce one posting shard at a time into final adaptive shards, adding block
   metadata while each term is already local to the reducer.
4. Delete the temporary `_build` directory.

Peak memory is therefore bounded by the current document, small posting buffers,
facet/code arrays, and one shard reducer. It does not keep all source rows or all
postings in memory.

For learned sparse expansion, the scalable standalone contract is to emit
zero-based `doc` ids in JSONL. Keyed lookups are convenient for this prototype,
but a standalone package should prefer adapter-assigned document indexes so the
builder can stream model output without retaining corpus keys.

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
- Term dependence: the dependency-feature reranker follows the Markov Random
  Field / Sequential Dependence Model direction: combine unigram evidence with
  ordered and unordered phrase/proximity evidence, but keep those features
  weighted and bounded. See Metzler and Croft, "Modeling Query Term Dependencies
  in Information Retrieval with Markov Random Fields":
  https://ciir.cs.umass.edu/pubfiles/ir-484.pdf
- Learned sparse expansion: a future standalone engine could add optional
  offline expansion weights while keeping the browser index sparse and lexical.
  See Doc2Query, DeepImpact, and SPLADE:
  https://arxiv.org/abs/1904.08375
  https://arxiv.org/abs/2104.12016
  https://arxiv.org/abs/2109.10086
- Delete-based spelling correction: the typo sidecar follows the static
  deletion-dictionary family popularized by SymSpell/FastSS, with explicit
  edit-distance verification and query-level retrieval-gain acceptance.

## Next Engine Work

- Move the generic engine pieces into a standalone package with a public schema
  for ranking fields, result fields, filters, and block summaries.
- Add delta coding for doc IDs in optional document-ordered posting blocks while
  preserving the current impact-ordered path for fast first results.
- Promote the dependency-feature layer into the standalone schema so fields can
  opt into ordered phrases, unordered windows, field weights, and candidate
  windows.
- Replace the current corpus-generated sparse-expansion producer with a real
  trained Doc2Query, DeepImpact, or SPLADE-style producer, and only promote it
  to the default build if it beats the quality bench without unacceptable index
  or network cost.
- Optimize typo-sidecar shard layout and candidate probing so zero-result typo
  fallbacks keep the current quality while reducing cold transfer size.
