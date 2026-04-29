/**
 * Backend adapter for the sql.js-httpvfs static variant.
 *
 * The browser pulls SQLite pages from /db/theses.db on demand via HTTP Range
 * requests; queries run client-side against the FTS5 mirror + base table —
 * the same SQL the FastAPI backend runs server-side.
 *
 * The UMD bundle is loaded by static.html before this module via:
 *
 *   <script src="./sqlite-httpvfs/index.js"></script>
 *
 * which exposes `window.createDbWorker`. We keep things this simple to avoid
 * pulling in a JS bundler.
 */

let workerHandle = null;
let workerPromise = null;     // started lazily; awaited only when SQL is needed
let meta = null;
const SOURCE_NAMES = new Map();

// Quote tokens, AND-combine, prefix-match the LAST token only.
//
// Why only the last: prefix matching forces SQLite to scan a portion of
// the FTS5 dictionary for every "x*" pattern. Measured cold cost on Pages:
// "neuroplasticité*" → 1 s + 1 MB of fetches; "neuroplasticité" → 1 ms.
// For multi-word queries we want the user's still-being-typed last word
// to match prefixes ("appren" → "apprentissage"), but the earlier words
// are typically complete and benefit from the 1000× speedup of exact-
// matching. Quoting every token also keeps stray FTS5 operators (AND, *,
// :, parens) from blowing up the parser when users paste raw text.
const TOKEN_RE = /[\p{L}\p{N}\-]+/gu;
function ftsQuery(raw) {
  if (!raw) return "";
  const tokens = (raw.match(TOKEN_RE) || []).filter(t => t.length >= 2);
  if (tokens.length === 0) return "";
  return tokens
    .map((t, i) => {
      const safe = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${safe}*` : safe;
    })
    .join(" ");
}

// Build a parameterized WHERE for filter state. Keeps the SQL short by only
// emitting clauses for active filters; FTS5 MATCH is added by the caller
// (only when a query is present).
//
// `tableAlias` lets the same builder produce clauses against either the
// main `theses` table (alias `t`, used by the row-fetch query that needs
// title/abstract/etc.) or `theses_facets` (alias `f`, used by COUNT and
// the 3 GROUP BYs — much cheaper because rows are 80× denser).
function buildFilters({ type, year_min, year_max, discipline, source }, tableAlias = "t") {
  const a = tableAlias;
  const where = [];
  const params = [];
  if (discipline.size) {
    where.push(`${a}.discipline IN (${[...discipline].map(() => "?").join(",")})`);
    params.push(...discipline);
  }
  if (source.size) {
    where.push(`${a}.source_id IN (${[...source].map(() => "?").join(",")})`);
    params.push(...source);
  }
  if (type) { where.push(`${a}.type = ?`); params.push(type); }
  if (year_min != null) { where.push(`${a}.year >= ?`); params.push(year_min); }
  if (year_max != null) { where.push(`${a}.year <= ?`); params.push(year_max); }
  return { where, params };
}

export default {
  label: "sqlite-httpvfs",
  hasSplash: true,

  // Live transport stats from the worker. Used by the splash overlay to show
  // a real "MB downloaded · N requests" counter during the cold-cache first
  // search (the FTS5 dictionary + B-tree pages are fetched lazily on demand,
  // so the first MATCH typically pulls 5–15 MB before returning anything).
  async getStats() {
    // Don't force the worker to spin up just to poll stats — return null
    // when it hasn't materialised yet. The splash polls this every 250 ms
    // during the first SQL search; before that, there's nothing to report.
    if (!workerHandle) return null;
    try { return await workerHandle.worker.getStats(); }
    catch { return null; }
  },

  async init() {
    if (typeof window.createDbWorker !== "function") {
      throw new Error(
        "sql.js-httpvfs runtime not loaded. Make sure sqlite-httpvfs/index.js " +
        "is included via a <script> tag before this module."
      );
    }
    // We need db_bytes (the DB file size) for chunked-mode config and we
    // need it now, but spinning up the SQLite worker (~5–10 s on first
    // visit: WASM fetch + compile + DB header read) we DO NOT need now.
    // The empty-default landing renders entirely from meta.json's `initial`
    // block — no SQL fires until the user types or filters. Kicking off
    // the worker in the background means init() resolves in a single fetch,
    // the splash dismisses fast, and by the time the user types (a few
    // seconds later) the worker is usually warm.
    meta = await fetch("./meta.json").then(r => r.json());
    for (const s of meta.sources) SOURCE_NAMES.set(s.id, s.name);

    // URLs must be absolute: the worker resolves relative URLs against its
    // own script location (./sqlite-httpvfs/sqlite.worker.js), so a relative
    // "./db/theses.db.000" would resolve to ".../sqlite-httpvfs/db/..." and
    // 404. Anchor everything to the document location.
    const base = new URL(".", document.baseURI);
    const abs = (p) => new URL(p, base).href;

    workerPromise = window.createDbWorker(
      [{
        from: "inline",
        config: {
          serverMode: "chunked",
          urlPrefix: abs("db/theses.db."),
          // Single-chunk layout: server chunk size == DB length. Range
          // requests happen at requestChunkSize granularity; they all hit
          // theses.db.000.
          serverChunkSize: meta.db_bytes,
          databaseLengthBytes: meta.db_bytes,
          // 32 KB per HTTP Range request — 8× the SQLite page size. SQLite
          // still reads pages at 4 KB internally, but the lazyFile layer
          // only refills the cache 32 KB at a time, which collapses
          // sequential page reads (FTS5 dictionary scans, B-tree walks)
          // into one HTTP roundtrip instead of 8. For an FTS search on a
          // cold cache (5–15 MB pulled), that's ~200 requests instead of
          // ~1500, and Pages-edge RTT dominates that math.
          requestChunkSize: 32768,
          suffixLength: 3,
        },
      }],
      abs("sqlite-httpvfs/sqlite.worker.js"),
      abs("sqlite-httpvfs/sql-wasm.wasm"),
      // 2 GB ceiling: well above any single-query reasonable read.
      2 * 1024 * 1024 * 1024,
    ).then(w => { workerHandle = w; return w; });

    return {
      total: meta.total,
      sources: meta.sources,
      builtAt: meta.built_at,
    };
  },

  // Resolve the worker, awaiting its lazy startup if needed. Used by every
  // SQL path (search() + getStats()).
  async _worker() {
    return workerHandle ?? await workerPromise;
  },

  async search(state) {
    const { q, sort, page, size } = state;

    // Empty-default short-circuit: if the user hasn't typed a query, picked
    // a filter, or paged past 1 — return the pre-computed bootstrap state
    // baked into meta.json by build.mjs. Saves the cold-cache visitor 5–15
    // MB of HTTP Range fetches on first paint (the empty-state SELECT +
    // GROUP BYs would otherwise walk the rowid B-tree and 3 secondary
    // indexes). Once they type or filter, we fall through to SQL like
    // normal — that path now happens *behind* user intent, not on landing.
    if (
      meta?.initial &&
      !q &&
      !state.type &&
      state.year_min == null &&
      state.year_max == null &&
      state.discipline.size === 0 &&
      state.source.size === 0 &&
      page === 1 &&
      (sort === "relevance" || !sort)
    ) {
      const init = meta.initial;
      return {
        total: init.total,
        results: init.results.slice(0, size).map(r => ({
          ...r,
          year: r.year != null ? Number(r.year) : null,
          advisors: r.advisors || null,
        })),
        facets: init.facets,
      };
    }

    const fts = ftsQuery(q);
    const { where, params } = buildFilters(state);

    // FTS5 MATCH goes into a separate clause + adds a JOIN on theses_fts.
    // Without a query we read straight from the base table (and pay only the
    // filter index lookups).
    const useFts = fts.length > 0;
    const from = useFts
      ? "FROM theses_fts JOIN theses t ON t.rowid = theses_fts.rowid"
      : "FROM theses t";
    if (useFts) {
      where.unshift("theses_fts MATCH ?");
      params.unshift(fts);
    }
    const whereSQL = where.length ? "WHERE " + where.join(" AND ") : "";

    // Order: relevance (FTS rank) when matching; otherwise by the user's
    // pick. NULLS LAST keeps records with missing year off the front page on
    // year sort.
    let orderSQL;
    if (sort === "year_desc") orderSQL = "ORDER BY t.year DESC NULLS LAST, t.rowid";
    else if (sort === "year_asc") orderSQL = "ORDER BY t.year ASC NULLS LAST, t.rowid";
    else if (sort === "title_asc") orderSQL = "ORDER BY t.title COLLATE NOCASE";
    else if (useFts) orderSQL = "ORDER BY rank";
    else orderSQL = "ORDER BY t.rowid";

    // sql.js binds JS numbers as REAL, but LIMIT/OFFSET require INTEGER and
    // throw "datatype mismatch" on a REAL bound parameter. Both values are
    // under our control (clamped, integer math), so inlining as literals
    // is safe — no SQL injection surface.
    const offset = Math.max(0, Math.floor((page - 1) * size));
    const limitN = Math.max(1, Math.floor(size));

    // snippet() is FTS5's built-in highlight — we mirror Pagefind's <mark>
    // wrapping so the existing UI (which falls back to highlight() when
    // excerpt is null) can render either backend's output verbatim.
    const excerptCol = useFts
      ? "snippet(theses_fts, -1, '<mark>', '</mark>', '…', 30) AS excerpt"
      : "NULL AS excerpt";

    const selectSQL =
      `SELECT t.oai_identifier AS id, t.title, t.authors, t.advisors,
              t.abstract, t.year, t.type, t.source_id, t.source_name,
              t.discipline, t.url, ${excerptCol}
       ${from} ${whereSQL} ${orderSQL} LIMIT ${limitN} OFFSET ${offset}`;

    // Count: pick the cheapest path based on what filters apply.
    //   - FTS-only (no base-table filters): COUNT FROM theses_fts directly.
    //     FTS5 walks its posting lists internally, no row fetches.
    //   - FTS + filters: JOIN theses_fts to theses_facets (NOT theses).
    //     theses_facets has all the filter columns we need at ~50 bytes
    //     per row instead of ~4 KB.
    //   - No FTS: count from theses_facets with the same filters.
    const noTableFilters = !state.type
      && state.discipline.size === 0
      && state.source.size === 0
      && state.year_min == null
      && state.year_max == null;
    const facetFilters = buildFilters(state, "f");
    const facetWhereForCount = facetFilters.where.length
      ? "WHERE " + facetFilters.where.join(" AND ")
      : "";
    let countSQL, countParams;
    if (useFts && noTableFilters) {
      countSQL = "SELECT COUNT(*) AS n FROM theses_fts WHERE theses_fts MATCH ?";
      countParams = [fts];
    } else if (useFts) {
      countSQL =
        `SELECT COUNT(*) AS n FROM theses_fts JOIN theses_facets f ON f.rowid = theses_fts.rowid
         WHERE theses_fts MATCH ? ${facetFilters.where.length ? "AND " + facetFilters.where.join(" AND ") : ""}`;
      countParams = [fts, ...facetFilters.params];
    } else {
      countSQL = `SELECT COUNT(*) AS n FROM theses_facets f ${facetWhereForCount}`;
      countParams = facetFilters.params;
    }

    // Facets run against theses_facets (alias `f`), NOT the main theses
    // table — same shape, ~10 MB instead of 622 MB. With 32 KB chunks the
    // small denser rows mean ~190 unique chunks for an 800-match query
    // vs ~800 against theses (4× fewer HTTP fetches).
    //
    // We omit each facet's own dimension from its WHERE so the user sees
    // all options even after picking one (mirrors api/app.py).
    function facetWhere(exclude) {
      const w = [];
      const p = [];
      if (useFts) { w.push("theses_fts MATCH ?"); p.push(fts); }
      if (exclude !== "discipline" && state.discipline.size) {
        w.push(`f.discipline IN (${[...state.discipline].map(() => "?").join(",")})`);
        p.push(...state.discipline);
      }
      if (exclude !== "source" && state.source.size) {
        w.push(`f.source_id IN (${[...state.source].map(() => "?").join(",")})`);
        p.push(...state.source);
      }
      if (state.type) { w.push("f.type = ?"); p.push(state.type); }
      if (state.year_min != null) { w.push("f.year >= ?"); p.push(state.year_min); }
      if (state.year_max != null) { w.push("f.year <= ?"); p.push(state.year_max); }
      return { sql: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
    }

    const fwDisc = facetWhere("discipline");
    const fwSrc = facetWhere("source");
    const fwDec = facetWhere(null);
    // Decade always wants `year IS NOT NULL` on top of the facet WHERE.
    const decWhere = fwDec.sql
      ? `${fwDec.sql} AND f.year IS NOT NULL`
      : "WHERE f.year IS NOT NULL";

    // FROM clause for facet queries: when an FTS query is present, JOIN
    // theses_facets to theses_fts via rowid; otherwise scan theses_facets
    // directly (the per-dimension indexes on theses_facets carry the load).
    const facetFrom = useFts
      ? "FROM theses_fts JOIN theses_facets f ON f.rowid = theses_fts.rowid"
      : "FROM theses_facets f";

    // sql.js-httpvfs exposes db.query(sql, ...args) but internally calls
    // sql.js's db.exec(sql, params), and sql.js's exec wants params as a
    // single ARRAY. Spreading individually here means the params arg lands
    // as a primitive instead of an array and bindings silently disappear
    // (filters return 0 rows, FTS5 MATCH errors with "syntax error near """
    // because it sees an empty operand). Always pass params as one array.
    //
    // _worker() awaits the lazy worker startup that init() kicked off in
    // the background — this is where the user pays the WASM-compile +
    // DB-header-fetch cost, gated behind their typed action rather than
    // the first paint.
    // Phase 1: rows + count first. These are what the user looks at.
    // Phase 2: 3 facet GROUP BYs, returned via opts.onFacets when ready.
    //
    // The worker has a single SQLite handle, so all queries serialise on
    // its queue. Splitting into phases means rows lands first (the page
    // renders) and the user can already scroll/click while facets are
    // still being computed in the background. Cold-cache "neuroplasticité"
    // measured rows ~3 s, count ~0 ms (skip-JOIN), facets ~1.5 s — phase 1
    // returns in ~3 s instead of ~5 s, even though total work is unchanged.
    const w = await this._worker();
    const [rows, countRow] = await Promise.all([
      w.db.query(selectSQL, params),
      w.db.query(countSQL, countParams),
    ]);

    const results = rows.map(r => ({
      id: r.id,
      title: r.title,
      authors: r.authors,
      advisors: r.advisors || null,
      abstract: r.abstract,
      year: r.year != null ? Number(r.year) : null,
      type: r.type,
      source_id: r.source_id,
      source_name: r.source_name,
      discipline: r.discipline,
      url: r.url,
      excerpt: r.excerpt || null,
    }));

    const facetsPromise = Promise.all([
      w.db.query(
        `SELECT f.discipline AS v, COUNT(*) AS n ${facetFrom} ${fwDisc.sql}
         GROUP BY f.discipline ORDER BY n DESC`,
        fwDisc.params,
      ),
      w.db.query(
        `SELECT f.source_id AS v, f.source_name AS name, COUNT(*) AS n ${facetFrom} ${fwSrc.sql}
         GROUP BY f.source_id, f.source_name ORDER BY n DESC`,
        fwSrc.params,
      ),
      w.db.query(
        `SELECT (f.year/10*10) AS v, COUNT(*) AS n ${facetFrom} ${decWhere}
         GROUP BY (f.year/10*10) ORDER BY v`,
        fwDec.params,
      ),
    ]).then(([discRows, srcRows, decRows]) => ({
      discipline: discRows
        .filter(r => r.v)
        .map(r => ({ value: r.v, label: r.v, n: r.n })),
      source: srcRows
        .filter(r => r.v)
        .map(r => ({
          value: r.v,
          label: r.name || SOURCE_NAMES.get(r.v) || r.v,
          n: r.n,
        })),
      decade: decRows
        .filter(r => r.v != null)
        .map(r => ({ value: `${r.v}s`, label: `${r.v}s`, n: r.n })),
    }));

    return {
      total: countRow[0].n,
      results,
      facets: null,        // populated via facetsPromise when it resolves
      facetsPromise,       // common.js awaits this and re-renders the sidebar
    };
  },
};
