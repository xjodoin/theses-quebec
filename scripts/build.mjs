#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages.
 *
 *   node scripts/build.mjs
 *
 * Reads data/theses.db (SQLite), builds a MiniSearch index in memory with the
 * same diacritic-stripping tokenizer as the FTS5 index, serializes it to
 * dist/search.json, and copies the static frontend to dist/index.html.
 *
 * Output is small enough that GitHub Pages' on-the-fly gzip compression brings
 * the wire transfer under 1 MB for ~5 000 records. The browser loads the
 * pre-built index in a single fetch and runs all searches locally — sub-10ms.
 */

import Database from "better-sqlite3";
import MiniSearch from "minisearch";
import { mkdirSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const DIST = resolve(ROOT, "dist");

mkdirSync(DIST, { recursive: true });

// ----------------------------------------------------------- shared options --
// IMPORTANT: web/static.html re-creates a MiniSearch instance with these EXACT
// options when calling MiniSearch.loadJSON(). Drift here = broken search at
// runtime. Keep this block in sync with web/static.html.

const STORE_FIELDS = [
  "title", "authors", "abstract", "year", "type",
  "source_id", "source_name", "discipline", "url",
];

/** lowercase + strip diacritics + word-split (mirrors FTS5 unicode61 remove_diacritics). */
function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[\s\W]+/u)
    .filter((t) => t.length >= 2);
}

const MINISEARCH_OPTIONS = {
  fields: ["title", "authors", "abstract", "subjects"],
  storeFields: STORE_FIELDS,
  tokenize,
  processTerm: (term) => term, // tokenize already lowercased + stripped
};

// ----------------------------------------------------------- pipeline --

console.log(`▸ Reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT
       rowid AS id,
       title, authors, abstract, subjects,
       year, type, source_id, source_name, discipline, url
     FROM theses
     ORDER BY rowid`,
  )
  .all();
db.close();
console.log(`  ${rows.length.toLocaleString()} records loaded`);

// Trim long abstracts: 1000 chars is plenty for both the on-card preview and
// keyword-bearing context in the index. Past that, every record adds bytes
// without improving recall.
let trimmed = 0;
for (const r of rows) {
  if (r.abstract && r.abstract.length > 1000) {
    r.abstract = r.abstract.slice(0, 1000) + "…";
    trimmed++;
  }
  // Drop empty/null fields to shrink the JSON. The frontend handles missing keys.
  for (const k of Object.keys(r)) {
    if (r[k] === null || r[k] === "") delete r[k];
  }
}
if (trimmed) console.log(`  trimmed ${trimmed} long abstracts to 1000 chars`);

console.log("▸ Building MiniSearch index");
const t0 = performance.now();
const index = new MiniSearch(MINISEARCH_OPTIONS);
index.addAll(rows);
console.log(`  indexed ${rows.length} docs in ${(performance.now() - t0).toFixed(0)}ms`);

const json = JSON.stringify(index);
const searchPath = resolve(DIST, "search.json");
writeFileSync(searchPath, json);
const gz = gzipSync(json, { level: 9 });

const fmt = (b) => `${(b / 1024).toFixed(1)} KB`;
console.log(`  search.json:    ${fmt(json.length)}  →  ${fmt(gz.length)} gzipped`);

// Lightweight metadata for the UI (build timestamp + source list).
const sourcesById = new Map();
for (const r of rows) {
  if (!r.source_id) continue;
  if (!sourcesById.has(r.source_id)) {
    sourcesById.set(r.source_id, { id: r.source_id, name: r.source_name || r.source_id, n: 0 });
  }
  sourcesById.get(r.source_id).n++;
}
const meta = {
  built_at: new Date().toISOString(),
  total: rows.length,
  sources: [...sourcesById.values()].sort((a, b) => b.n - a.n),
};
writeFileSync(resolve(DIST, "meta.json"), JSON.stringify(meta));
console.log(`  meta.json:      ${fmt(JSON.stringify(meta).length)}`);

// Copy the static frontend.
copyFileSync(resolve(ROOT, "web/static.html"), resolve(DIST, "index.html"));

// 404 page — sends visitors back to the search index.
writeFileSync(
  resolve(DIST, "404.html"),
  `<!doctype html><meta charset="utf-8"><title>Not found</title>
<meta http-equiv="refresh" content="0; url=/">
<p>Page introuvable. <a href="/">Retour à la recherche</a>.</p>`,
);

// CNAME / .nojekyll housekeeping (Pages-specific).
writeFileSync(resolve(DIST, ".nojekyll"), "");

const totalSize = statSync(searchPath).size + JSON.stringify(meta).length;
console.log(`\n✓ Built ${DIST}/  (~${fmt(gz.length)} on the wire)`);
