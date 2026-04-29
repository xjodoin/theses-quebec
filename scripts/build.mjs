#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages, served via sql.js-httpvfs.
 *
 *   node scripts/build.mjs
 *
 * The browser runs SQLite (via sql.js-httpvfs) directly against `data/theses.db`
 * using HTTP Range requests, so this build step is mostly bookkeeping:
 *
 *   1. Ensure the FTS5 mirror (`theses_fts`) exists on the DB. The release
 *      tarball ships slimmed (FTS dropped to save ~34%) so we rebuild it here.
 *   2. Copy the DB to dist/db/theses.db.
 *   3. Copy sql.js-httpvfs runtime files to dist/sqlite-httpvfs/.
 *   4. Generate dist/index.html from the static template + meta.json.
 *   5. Copy the shared frontend modules (common.js, backends/).
 *
 * We dropped Pagefind because its writeFiles step writes 187k+ small fragment
 * files into one directory, which the GitHub-hosted runners' shared-disk I/O
 * stalls on (writeFiles takes ~22 min there, ~3 min locally on NVMe). With
 * sql.js-httpvfs the heavy lifting moves to the browser and the deploy is
 * just two big files (DB + WASM) — back under 1 min build time.
 */

import Database from "better-sqlite3";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const DIST = resolve(ROOT, "dist");
const DB_DIR = resolve(DIST, "db");
const HTTPVFS_DIR = resolve(DIST, "sqlite-httpvfs");
const HTTPVFS_SRC = resolve(ROOT, "node_modules/sql.js-httpvfs/dist");

if (!existsSync(DB_PATH)) {
  console.log(`▸ ${DB_PATH} missing — fetching latest release`);
  execSync("node scripts/fetch_db.mjs", { stdio: "inherit", cwd: ROOT });
}

mkdirSync(DIST, { recursive: true });
mkdirSync(DB_DIR, { recursive: true });
mkdirSync(HTTPVFS_DIR, { recursive: true });

// ---------------------------------------------------------------- FTS5 rebuild --

// The FTS5 schema must match harvester/db.py exactly. Out-of-sync schemas
// would silently produce wrong search results, so when changing one, change
// both. The rebuild is idempotent: skipped if the table already exists with
// content.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS theses_fts USING fts5(
    title, authors, advisors, abstract, subjects,
    content='theses', content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS theses_ai AFTER INSERT ON theses BEGIN
    INSERT INTO theses_fts(rowid, title, authors, advisors, abstract, subjects)
    VALUES (new.rowid, new.title, new.authors, new.advisors, new.abstract, new.subjects);
END;
CREATE TRIGGER IF NOT EXISTS theses_ad AFTER DELETE ON theses BEGIN
    INSERT INTO theses_fts(theses_fts, rowid, title, authors, advisors, abstract, subjects)
    VALUES('delete', old.rowid, old.title, old.authors, old.advisors, old.abstract, old.subjects);
END;
CREATE TRIGGER IF NOT EXISTS theses_au AFTER UPDATE ON theses BEGIN
    INSERT INTO theses_fts(theses_fts, rowid, title, authors, advisors, abstract, subjects)
    VALUES('delete', old.rowid, old.title, old.authors, old.advisors, old.abstract, old.subjects);
    INSERT INTO theses_fts(rowid, title, authors, advisors, abstract, subjects)
    VALUES (new.rowid, new.title, new.authors, new.advisors, new.abstract, new.subjects);
END;
`;

console.log(`▸ Reading ${DB_PATH}`);
{
  const db = new Database(DB_PATH);
  // External-content FTS5 is the established pattern in harvester/db.py; the
  // shadow `theses_fts_idx` is the trustworthy "is this populated" signal.
  // (FTS5's COUNT(*) proxies to the base table even when the index is empty.)
  const ftsExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='theses_fts_idx'"
  ).get();
  let ftsRows = 0;
  if (ftsExists) {
    ftsRows = db.prepare("SELECT COUNT(*) AS n FROM theses_fts_idx").get().n;
  }
  let needsVacuum = false;
  if (!ftsExists || ftsRows === 0) {
    console.log("  rebuilding FTS5 mirror (slim DB)");
    const t0 = performance.now();
    db.exec(FTS_SCHEMA);
    db.exec(
      "INSERT INTO theses_fts(rowid, title, authors, advisors, abstract, subjects) " +
      "SELECT rowid, title, authors, advisors, abstract, subjects FROM theses"
    );
    needsVacuum = true;
    console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Backfill secondary indexes that may be missing on older DB snapshots
  // (idx_theses_title_nocase was added after some releases shipped).
  // CREATE INDEX IF NOT EXISTS is a no-op when the index already exists.
  // Without idx_theses_title_nocase, ORDER BY title COLLATE NOCASE is a
  // full-table scan — over HTTP Range that's the entire 622 MB DB pulled
  // before the first row renders.
  console.log("  ensuring sort indexes");
  const idxT0 = performance.now();
  const beforePages = db.prepare("PRAGMA page_count").get().page_count;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_theses_year ON theses(year);
    CREATE INDEX IF NOT EXISTS idx_theses_discipline ON theses(discipline);
    CREATE INDEX IF NOT EXISTS idx_theses_source ON theses(source_id);
    CREATE INDEX IF NOT EXISTS idx_theses_type ON theses(type);
    CREATE INDEX IF NOT EXISTS idx_theses_title_nocase ON theses(title COLLATE NOCASE);
  `);
  console.log(`  done in ${((performance.now() - idxT0) / 1000).toFixed(1)}s`);

  // theses_facets: a denormalized projection of just the facet/filter
  // columns, keyed by rowid (same rowid as theses + theses_fts). For
  // FTS+GROUP BY queries the planner does N random rowid lookups; in
  // theses (rows ~4 KB each, one row per 4 KB page) every lookup hits a
  // unique page = N HTTP Range fetches. theses_facets rows are ~50 bytes
  // = ~80 rows per page, so 800 random rowids land on ~190 unique 32 KB
  // chunks instead of 800. The whole table is ~10-15 MB; the win compounds
  // as the result set grows (75%+ savings on 1.5k-match queries).
  //
  // Every facet/filter column lives here so the FTS path can compute
  // count + 3 facets + filter checks without ever touching theses.
  console.log("  building theses_facets (denormalized facet columns)");
  const facT0 = performance.now();
  db.exec(`
    DROP TABLE IF EXISTS theses_facets;
    CREATE TABLE theses_facets (
      rowid INTEGER PRIMARY KEY,
      discipline TEXT,
      source_id TEXT,
      source_name TEXT,
      year INTEGER,
      type TEXT
    );
    INSERT INTO theses_facets (rowid, discipline, source_id, source_name, year, type)
      SELECT rowid, discipline, source_id, source_name, year, type FROM theses;
    CREATE INDEX IF NOT EXISTS idx_theses_facets_discipline ON theses_facets(discipline);
    CREATE INDEX IF NOT EXISTS idx_theses_facets_source ON theses_facets(source_id);
    CREATE INDEX IF NOT EXISTS idx_theses_facets_year ON theses_facets(year);
    CREATE INDEX IF NOT EXISTS idx_theses_facets_type ON theses_facets(type);
  `);
  needsVacuum = true;
  const afterPages = db.prepare("PRAGMA page_count").get().page_count;
  const facetMb = ((afterPages - beforePages) * 4096 / 1024 / 1024).toFixed(1);
  console.log(`  done in ${((performance.now() - facT0) / 1000).toFixed(1)}s (${facetMb} MB added)`);

  if (needsVacuum) {
    console.log("  VACUUM");
    const vT0 = performance.now();
    db.exec("VACUUM");
    console.log(`  done in ${((performance.now() - vT0) / 1000).toFixed(1)}s`);
  }
  const total = db.prepare("SELECT COUNT(*) AS n FROM theses").get().n;
  console.log(`  ${total.toLocaleString()} records`);

  const sources = db.prepare(
    "SELECT source_id AS id, source_name AS name, COUNT(*) AS n " +
    "FROM theses GROUP BY source_id, source_name ORDER BY n DESC"
  ).all();

  // ---------------------------------------------------------------- empty-state cache --
  // Pre-compute the result of the bootstrap "empty default" search so the
  // first paint doesn't have to fire any SQL over HTTP Range. Without this,
  // the cold-cache landing pulls 5–15 MB just to show 20 rows + facets
  // (10–30 s on first visit). With this, meta.json carries the answer; SQL
  // only fires when the user actually types or filters. Cost is ~30 KB of
  // JSON gzipped to ~10 KB — invisible compared to the DB itself.
  console.log("▸ Pre-computing empty-default state (initial render)");
  const initialResults = db.prepare(
    `SELECT t.oai_identifier AS id, t.title, t.authors, t.advisors,
            t.abstract, t.year, t.type, t.source_id, t.source_name,
            t.discipline, t.url
       FROM theses t ORDER BY t.rowid LIMIT 20`
  ).all().map(r => ({ ...r, excerpt: null }));

  const initialFacets = {
    discipline: db.prepare(
      `SELECT t.discipline AS value, t.discipline AS label, COUNT(*) AS n
         FROM theses t WHERE t.discipline IS NOT NULL
         GROUP BY t.discipline ORDER BY n DESC`
    ).all(),
    source: db.prepare(
      `SELECT t.source_id AS value, t.source_name AS label, COUNT(*) AS n
         FROM theses t
         GROUP BY t.source_id, t.source_name ORDER BY n DESC`
    ).all(),
    // The decade query returns 1980, 1990, etc.; the frontend expects the
    // "1980s" label form (matching the value used in URL state), so format
    // it once here.
    decade: db.prepare(
      `SELECT (t.year/10*10) AS y, COUNT(*) AS n
         FROM theses t WHERE t.year IS NOT NULL
         GROUP BY (t.year/10*10) ORDER BY y`
    ).all().map(r => ({ value: `${r.y}s`, label: `${r.y}s`, n: r.n })),
  };

  db.close();

  // ---------------------------------------------------------------- meta + assets --
  // db_bytes is set after the copy below — declare meta first, fill in last.
  const meta = {
    built_at: new Date().toISOString(),
    total,
    sources,
    search_engine: "sqlite-httpvfs",
    db_bytes: 0,  // overwritten below
    initial: {
      total,
      results: initialResults,
      facets: initialFacets,
    },
  };

  // We deploy the DB as a single chunk file (`theses.db.000`) and serve
  // it via sql.js-httpvfs in **chunked** mode. The "full" mode triggers an
  // initial length-probe GET that GitHub Pages auto-gzips (see issue:
  // when Accept-Encoding includes gzip on a non-Range GET, Pages serves the
  // whole compressed file and the worker's range/length detection fails
  // with "Length of the file not known"). Chunked mode pulls the total
  // size from config (`databaseLengthBytes`) so the probe is skipped, and
  // every actual data read is a Range fetch — which Pages does honour
  // correctly (no gzip applied to Range responses).
  const chunkPath = resolve(DB_DIR, "theses.db.000");
  console.log(`▸ Copying DB to ${chunkPath}`);
  copyFileSync(DB_PATH, chunkPath);
  const dbBytes = statSync(chunkPath).size;
  const dbSize = (dbBytes / 1024 / 1024).toFixed(1);
  console.log(`  ${dbSize} MB`);
  meta.db_bytes = dbBytes;
  writeFileSync(resolve(DIST, "meta.json"), JSON.stringify(meta));

  console.log(`▸ Copying sql.js-httpvfs runtime`);
  for (const f of ["index.js", "sqlite.worker.js", "sql-wasm.wasm"]) {
    copyFileSync(resolve(HTTPVFS_SRC, f), resolve(HTTPVFS_DIR, f));
  }

  // ---------------------------------------------------------------- HTML + frontend --
  const buildDate = meta.built_at.slice(0, 10);
  const html = readFileSync(resolve(ROOT, "web/static.html"), "utf8")
    .replaceAll("__JSONLD_N__", String(total))
    .replaceAll("__JSONLD_S__", String(sources.length))
    .replaceAll("__JSONLD_DATE__", buildDate);
  writeFileSync(resolve(DIST, "index.html"), html);

  // The shared frontend modules. The FastAPI uvicorn server serves these from
  // web/ directly, but the static Pages site needs them at the root.
  copyFileSync(resolve(ROOT, "web/common.js"), resolve(DIST, "common.js"));
  mkdirSync(resolve(DIST, "backends"), { recursive: true });
  cpSync(resolve(ROOT, "web/backends"), resolve(DIST, "backends"), { recursive: true });

  // Drop the old Pagefind output if it's still hanging around from a prior
  // build — keeps `dist/` clean and prevents stale pagefind/ chunks from
  // getting deployed.
  rmSync(resolve(DIST, "pagefind"), { recursive: true, force: true });

  writeFileSync(
    resolve(DIST, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://xjodoin.github.io/theses-quebec/</loc>
    <lastmod>${buildDate}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
  );
  writeFileSync(
    resolve(DIST, "robots.txt"),
    `User-agent: *
Allow: /

Sitemap: https://xjodoin.github.io/theses-quebec/sitemap.xml
`,
  );
  writeFileSync(
    resolve(DIST, "404.html"),
    `<!doctype html><meta charset="utf-8"><title>Not found</title>
<meta http-equiv="refresh" content="0; url=/">
<p>Page introuvable. <a href="/">Retour à la recherche</a>.</p>`,
  );
  writeFileSync(resolve(DIST, ".nojekyll"), "");

  console.log(`\n✓ Built ${DIST}/  (db ≈ ${dbSize} MB)`);
}
