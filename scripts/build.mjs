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
  if (!ftsExists || ftsRows === 0) {
    console.log("  rebuilding FTS5 mirror (slim DB)");
    const t0 = performance.now();
    db.exec(FTS_SCHEMA);
    db.exec(
      "INSERT INTO theses_fts(rowid, title, authors, advisors, abstract, subjects) " +
      "SELECT rowid, title, authors, advisors, abstract, subjects FROM theses"
    );
    db.exec("VACUUM");
    console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  const total = db.prepare("SELECT COUNT(*) AS n FROM theses").get().n;
  console.log(`  ${total.toLocaleString()} records`);

  const sources = db.prepare(
    "SELECT source_id AS id, source_name AS name, COUNT(*) AS n " +
    "FROM theses GROUP BY source_id, source_name ORDER BY n DESC"
  ).all();

  db.close();

  // ---------------------------------------------------------------- meta + assets --
  const meta = {
    built_at: new Date().toISOString(),
    total,
    sources,
    search_engine: "sqlite-httpvfs",
  };
  writeFileSync(resolve(DIST, "meta.json"), JSON.stringify(meta));

  console.log(`▸ Copying DB to ${DB_DIR}/theses.db`);
  copyFileSync(DB_PATH, resolve(DB_DIR, "theses.db"));
  const dbSize = (statSync(resolve(DB_DIR, "theses.db")).size / 1024 / 1024).toFixed(1);
  console.log(`  ${dbSize} MB`);

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
