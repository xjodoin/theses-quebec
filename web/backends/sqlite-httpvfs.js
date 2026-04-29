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
let meta = null;
const SOURCE_NAMES = new Map();

// Mirrors api/app.py:fts_query — quoted prefix tokens, AND-combined. Quoting
// each token also keeps stray FTS5 operators (`AND`, `*`, `:`, parens) from
// blowing up the parser when users paste raw text.
const TOKEN_RE = /[\p{L}\p{N}\-]+/gu;
function ftsQuery(raw) {
  if (!raw) return "";
  const tokens = (raw.match(TOKEN_RE) || []).filter(t => t.length >= 2);
  return tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

// Build a parameterized WHERE for filter state. Keeps the SQL short by only
// emitting clauses for active filters; FTS5 MATCH is added by the caller
// (only when a query is present).
function buildFilters({ type, year_min, year_max, discipline, source }) {
  const where = [];
  const params = [];
  if (discipline.size) {
    where.push(`t.discipline IN (${[...discipline].map(() => "?").join(",")})`);
    params.push(...discipline);
  }
  if (source.size) {
    where.push(`t.source_id IN (${[...source].map(() => "?").join(",")})`);
    params.push(...source);
  }
  if (type) { where.push("t.type = ?"); params.push(type); }
  if (year_min != null) { where.push("t.year >= ?"); params.push(year_min); }
  if (year_max != null) { where.push("t.year <= ?"); params.push(year_max); }
  return { where, params };
}

export default {
  label: "sqlite-httpvfs",
  hasSplash: true,

  async init() {
    if (typeof window.createDbWorker !== "function") {
      throw new Error(
        "sql.js-httpvfs runtime not loaded. Make sure sqlite-httpvfs/index.js " +
        "is included via a <script> tag before this module."
      );
    }
    // The DB is ~700 MB. We pass a generous maxBytesToRead ceiling so the
    // worker doesn't abort if a query touches an unusually large index page;
    // it's a guardrail, not a target.
    workerHandle = await window.createDbWorker(
      [{
        from: "inline",
        config: {
          serverMode: "full",
          url: "./db/theses.db",
          requestChunkSize: 4096,
        },
      }],
      "./sqlite-httpvfs/sqlite.worker.js",
      "./sqlite-httpvfs/sql-wasm.wasm",
      // 2 GB ceiling: well above any single-query reasonable read.
      2 * 1024 * 1024 * 1024,
    );

    meta = await fetch("./meta.json").then(r => r.json());
    for (const s of meta.sources) SOURCE_NAMES.set(s.id, s.name);

    return {
      total: meta.total,
      sources: meta.sources,
      builtAt: meta.built_at,
    };
  },

  async search(state) {
    const { q, sort, page, size } = state;
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

    const offset = (page - 1) * size;

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
       ${from} ${whereSQL} ${orderSQL} LIMIT ? OFFSET ?`;
    const countSQL = `SELECT COUNT(*) AS n ${from} ${whereSQL}`;

    // Facets re-run the filter (without FTS rank) for each grouping. We omit
    // each facet's own dimension from its WHERE so the user sees all options
    // even after picking one — same trick the FastAPI backend uses, but
    // pushed into SQL via dedicated queries (cheaper than fetching all rows).
    function facetWhere(exclude) {
      const w = [];
      const p = [];
      if (useFts) { w.push("theses_fts MATCH ?"); p.push(fts); }
      if (exclude !== "discipline" && state.discipline.size) {
        w.push(`t.discipline IN (${[...state.discipline].map(() => "?").join(",")})`);
        p.push(...state.discipline);
      }
      if (exclude !== "source" && state.source.size) {
        w.push(`t.source_id IN (${[...state.source].map(() => "?").join(",")})`);
        p.push(...state.source);
      }
      if (state.type) { w.push("t.type = ?"); p.push(state.type); }
      if (state.year_min != null) { w.push("t.year >= ?"); p.push(state.year_min); }
      if (state.year_max != null) { w.push("t.year <= ?"); p.push(state.year_max); }
      return { sql: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
    }

    const fwDisc = facetWhere("discipline");
    const fwSrc = facetWhere("source");
    const fwDec = facetWhere(null);
    // Decade always wants `year IS NOT NULL` on top of the facet WHERE.
    const decWhere = fwDec.sql
      ? `${fwDec.sql} AND t.year IS NOT NULL`
      : "WHERE t.year IS NOT NULL";

    // Run the data + 4 aggregates in parallel — each one is its own series of
    // Range fetches but the worker will overlap them.
    const [rows, countRow, discRows, srcRows, decRows] = await Promise.all([
      workerHandle.db.query(selectSQL, ...params, size, offset),
      workerHandle.db.query(countSQL, ...params),
      workerHandle.db.query(
        `SELECT t.discipline AS v, COUNT(*) AS n ${from} ${fwDisc.sql}
         GROUP BY t.discipline ORDER BY n DESC`,
        ...fwDisc.params,
      ),
      workerHandle.db.query(
        `SELECT t.source_id AS v, t.source_name AS name, COUNT(*) AS n ${from} ${fwSrc.sql}
         GROUP BY t.source_id, t.source_name ORDER BY n DESC`,
        ...fwSrc.params,
      ),
      workerHandle.db.query(
        `SELECT (t.year/10*10) AS v, COUNT(*) AS n ${from} ${decWhere}
         GROUP BY (t.year/10*10) ORDER BY v`,
        ...fwDec.params,
      ),
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

    return {
      total: countRow[0].n,
      results,
      facets: {
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
      },
    };
  },
};
