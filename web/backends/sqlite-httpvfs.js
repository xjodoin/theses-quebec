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
    // MB of HTTP Range fetches on first paint.
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
    const useFts = fts.length > 0;
    const w = await this._worker();

    return useFts
      ? searchFts(w, state, fts)
      : searchIndexed(w, state);
  },
};

// ===== FTS path ===========================================================
//
// Why two queries (rows + meta) instead of five (rows + count + 3 facets):
// sql.js holds a single SQLite handle, so Promise.all on multiple db.query
// calls *queues* them in the worker — every query waits for the previous
// one. Cold-cache "biodiversité" measured: rows 600 ms, COUNT 3000 ms
// (4 MB of fetches just to count FTS matches via the JOIN), facets
// ~70 ms each (warm from COUNT's page reads). 5 sequential queries.
//
// Collapsing the count + 3 GROUP BYs into one "fetch the facet columns for
// every match" query and aggregating in JS gives us ONE worker round-trip
// for everything-except-the-displayed-rows. For 700 matches × 4 cols ×
// ~50 bytes = ~140 KB, ~5 chunked HTTP requests. Faster *and* it makes
// the result-row query itself the head of the queue, so it lands first.
async function searchFts(w, state, fts) {
  const { sort, page, size } = state;
  const { whereSQL, params } = ftsWhere(fts, state);
  const orderSQL = pickOrderClause(sort, /* useFts */ true);
  const offset = Math.max(0, Math.floor((page - 1) * size));
  const limitN = Math.max(1, Math.floor(size));

  const FROM = "FROM theses_fts JOIN theses t ON t.rowid = theses_fts.rowid";
  const rowsSQL =
    `SELECT t.oai_identifier AS id, t.title, t.authors, t.advisors,
            t.abstract, t.year, t.type, t.source_id, t.source_name,
            t.discipline, t.url,
            snippet(theses_fts, -1, '<mark>', '</mark>', '…', 30) AS excerpt
     ${FROM} ${whereSQL} ${orderSQL} LIMIT ${limitN} OFFSET ${offset}`;

  // Facet meta query: only the columns we group on. Same WHERE as rows so
  // total + facet counts reflect the user's full filter set. JS aggregates
  // for total + the 3 facet histograms.
  //
  // To get "show all options on the dimension I'm currently filtering"
  // semantics (so the user can switch their discipline pick), we drop the
  // discipline+source filters from the meta query and re-apply them in JS
  // per-facet. Every other filter (FTS, year, type) stays in SQL — those
  // narrow the set the most and we don't want them in JS.
  const { whereSQL: metaWhere, params: metaParams } = ftsWhere(fts, state, {
    skipDiscipline: true, skipSource: true,
  });
  const metaSQL =
    `SELECT t.discipline, t.source_id, t.source_name, t.year ${FROM} ${metaWhere}`;

  const [rowsRaw, metaRaw] = await Promise.all([
    w.db.query(rowsSQL, params),
    w.db.query(metaSQL, metaParams),
  ]);

  const aggregated = aggregateFacets(metaRaw, state);
  return {
    total: aggregated.total,
    results: rowsRaw.map(shapeRow),
    facets: aggregated.facets,
  };
}

// ===== Non-FTS path =======================================================
//
// Without an FTS query, our 4 secondary indexes (year, discipline, source,
// type) make per-dimension GROUP BY queries fast: each is a covering-index
// scan with no row fetches. The 5-query approach actually beats the
// consolidated one here — the meta query without a narrowing FTS clause
// could easily fetch most of the table.
async function searchIndexed(w, state) {
  const { sort, page, size } = state;
  const { whereSQL, params } = baseFilters(state);
  const orderSQL = pickOrderClause(sort, /* useFts */ false);
  const offset = Math.max(0, Math.floor((page - 1) * size));
  const limitN = Math.max(1, Math.floor(size));

  const FROM = "FROM theses t";
  const rowsSQL =
    `SELECT t.oai_identifier AS id, t.title, t.authors, t.advisors,
            t.abstract, t.year, t.type, t.source_id, t.source_name,
            t.discipline, t.url, NULL AS excerpt
     ${FROM} ${whereSQL} ${orderSQL} LIMIT ${limitN} OFFSET ${offset}`;
  const countSQL = `SELECT COUNT(*) AS n ${FROM} ${whereSQL}`;

  // Each facet query drops its own filter dimension so the user sees all
  // options even after picking one.
  const fwDisc = baseFilters(state, { skipDiscipline: true });
  const fwSrc = baseFilters(state, { skipSource: true });
  const fwDec = baseFilters(state);
  const decWhere = fwDec.whereSQL
    ? `${fwDec.whereSQL} AND t.year IS NOT NULL`
    : "WHERE t.year IS NOT NULL";

  const [rowsRaw, countRow, discRows, srcRows, decRows] = await Promise.all([
    w.db.query(rowsSQL, params),
    w.db.query(countSQL, params),
    w.db.query(
      `SELECT t.discipline AS v, COUNT(*) AS n ${FROM} ${fwDisc.whereSQL}
       GROUP BY t.discipline ORDER BY n DESC`,
      fwDisc.params,
    ),
    w.db.query(
      `SELECT t.source_id AS v, t.source_name AS name, COUNT(*) AS n ${FROM} ${fwSrc.whereSQL}
       GROUP BY t.source_id, t.source_name ORDER BY n DESC`,
      fwSrc.params,
    ),
    w.db.query(
      `SELECT (t.year/10*10) AS v, COUNT(*) AS n ${FROM} ${decWhere}
       GROUP BY (t.year/10*10) ORDER BY v`,
      fwDec.params,
    ),
  ]);

  return {
    total: countRow[0].n,
    results: rowsRaw.map(shapeRow),
    facets: {
      discipline: discRows.filter(r => r.v).map(r => ({ value: r.v, label: r.v, n: r.n })),
      source: srcRows.filter(r => r.v).map(r => ({
        value: r.v,
        label: r.name || SOURCE_NAMES.get(r.v) || r.v,
        n: r.n,
      })),
      decade: decRows.filter(r => r.v != null).map(r => ({
        value: `${r.v}s`, label: `${r.v}s`, n: r.n,
      })),
    },
  };
}

// ===== Helpers ============================================================

function pickOrderClause(sort, useFts) {
  if (sort === "year_desc") return "ORDER BY t.year DESC NULLS LAST, t.rowid";
  if (sort === "year_asc")  return "ORDER BY t.year ASC NULLS LAST, t.rowid";
  if (sort === "title_asc") return "ORDER BY t.title COLLATE NOCASE";
  return useFts ? "ORDER BY rank" : "ORDER BY t.rowid";
}

// Build the WHERE+params for a query against the base table only (no FTS
// JOIN). `opts.skipDiscipline` / `opts.skipSource` drop those filters for
// per-facet exclusion semantics.
function baseFilters(state, opts = {}) {
  const w = [];
  const p = [];
  if (!opts.skipDiscipline && state.discipline.size) {
    w.push(`t.discipline IN (${[...state.discipline].map(() => "?").join(",")})`);
    p.push(...state.discipline);
  }
  if (!opts.skipSource && state.source.size) {
    w.push(`t.source_id IN (${[...state.source].map(() => "?").join(",")})`);
    p.push(...state.source);
  }
  if (state.type) { w.push("t.type = ?"); p.push(state.type); }
  if (state.year_min != null) { w.push("t.year >= ?"); p.push(state.year_min); }
  if (state.year_max != null) { w.push("t.year <= ?"); p.push(state.year_max); }
  return { whereSQL: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
}

// Same as baseFilters but with the FTS5 MATCH prepended.
function ftsWhere(fts, state, opts = {}) {
  const base = baseFilters(state, opts);
  const where = ["theses_fts MATCH ?"];
  if (base.whereSQL) where.push(base.whereSQL.replace(/^WHERE /, ""));
  return { whereSQL: "WHERE " + where.join(" AND "), params: [fts, ...base.params] };
}

// JS-side aggregation for the FTS path. metaRows is one row per match
// containing only (discipline, source_id, source_name, year) — the
// dimensions we group on. We re-apply the discipline/source filters here
// (they were skipped in SQL so the meta set covers all options for the
// "switch your pick" UX). The decade facet always treats year IS NULL as
// a non-bucket; the others fall through to "Autre / non classé"-equivalent
// values via the .filter(r => r.v) call in the response shape.
function aggregateFacets(metaRows, state) {
  const wantDisc = state.discipline.size > 0
    ? (d) => state.discipline.has(d) : null;
  const wantSrc = state.source.size > 0
    ? (s) => state.source.has(s) : null;

  const discCounts = new Map();
  const srcCounts = new Map();
  const decCounts = new Map();
  let total = 0;

  for (const r of metaRows) {
    // Total + decade respect ALL filters (incl. discipline/source).
    const matchesDisc = !wantDisc || wantDisc(r.discipline);
    const matchesSrc = !wantSrc || wantSrc(r.source_id);
    const matchesAll = matchesDisc && matchesSrc;

    if (matchesAll) {
      total++;
      if (r.year != null) {
        const dec = Math.floor(r.year / 10) * 10;
        decCounts.set(dec, (decCounts.get(dec) || 0) + 1);
      }
    }
    // Discipline facet skips the discipline filter (so user sees all options).
    if (matchesSrc && r.discipline) {
      discCounts.set(r.discipline, (discCounts.get(r.discipline) || 0) + 1);
    }
    // Source facet skips the source filter.
    if (matchesDisc && r.source_id) {
      const key = r.source_id;
      const entry = srcCounts.get(key) || { n: 0, name: r.source_name };
      entry.n++;
      srcCounts.set(key, entry);
    }
  }

  return {
    total,
    facets: {
      discipline: [...discCounts.entries()]
        .map(([value, n]) => ({ value, label: value, n }))
        .sort((a, b) => b.n - a.n),
      source: [...srcCounts.entries()]
        .map(([value, { n, name }]) => ({
          value,
          label: name || SOURCE_NAMES.get(value) || value,
          n,
        }))
        .sort((a, b) => b.n - a.n),
      decade: [...decCounts.entries()]
        .map(([y, n]) => ({ value: `${y}s`, label: `${y}s`, n }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    },
  };
}

function shapeRow(r) {
  return {
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
  };
}
