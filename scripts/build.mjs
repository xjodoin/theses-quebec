#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages, using Pagefind as the search engine.
 *
 *   node scripts/build.mjs
 *
 * Pagefind splits the index into chunks loaded on demand, so the wire size
 * stays small even with ~120 k records. The browser only fetches the chunks
 * relevant to a given query (typically 100–300 KB per session).
 *
 * For each thesis we register:
 *   url       — canonical URL (the source landing page)
 *   content   — title + subjects + (full) abstract — what's searched
 *   language  — `r.language` if known, default 'fr'
 *   meta      — fields displayed in result cards (title, authors, year, …)
 *   filters   — discipline, source_id, type, decade — faceted in the UI
 *   sort      — { year } so we can ORDER BY year client-side
 */

import Database from "better-sqlite3";
import * as pagefind from "pagefind";
import { mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const DIST = resolve(ROOT, "dist");
const PAGEFIND_DIR = resolve(DIST, "pagefind");

// Auto-fetch the DB from the latest GitHub Release if it isn't on disk.
// Lets `npm run build` work right after `git clone` without a separate
// step. CI uses the same path. Skipped in dev when the DB is already there.
if (!existsSync(DB_PATH)) {
  console.log(`▸ ${DB_PATH} missing — fetching latest release`);
  execSync("node scripts/fetch_db.mjs", { stdio: "inherit", cwd: ROOT });
}

mkdirSync(DIST, { recursive: true });
rmSync(PAGEFIND_DIR, { recursive: true, force: true });

// ---------------------------------------------------------------- pipeline --

console.log(`▸ Reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT
       rowid AS id,
       oai_identifier, title, authors, advisors, abstract, subjects,
       year, type, source_id, source_name, discipline,
       discipline_source, authoritative_discipline, language, url
     FROM theses
     ORDER BY rowid`,
  )
  .all();
db.close();
console.log(`  ${rows.length.toLocaleString()} records loaded`);

// Build a stable canonical URL per record. Most have one; fall back to the
// OAI identifier as a virtual urn so Pagefind still has a unique key.
function recordUrl(r) {
  if (r.url) return r.url;
  return `urn:tq:${encodeURIComponent(r.oai_identifier)}`;
}

// Pagefind language hints affect stemming + tokenization. Use the per-record
// value if it looks like fr/en; default to fr (the corpus is mostly French).
function recordLang(r) {
  const lang = (r.language || "").toLowerCase().slice(0, 2);
  if (lang === "fr" || lang === "en") return lang;
  return "fr";
}

const ABSTRACT_LIMIT = 1500;   // longer than v0.4 — Pagefind chunks scale fine
const TYPE_LABEL = { thesis: "Thèse", memoire: "Mémoire" };

console.log("▸ Building Pagefind index");
const t0 = performance.now();
// Force a single index across the whole corpus. Without this, Pagefind
// splits records into per-language sub-indexes (the `language:` hint we
// set on each record) and the JS frontend only loads the page's <html
// lang="fr"> sub-index by default — leaving English-language records
// (≈ 26 k, mostly Anglo institutions) invisible to the empty-query
// default search until the user types something. We accept the loss of
// English stemming (running/ran no longer fold) in exchange for a single
// unified index that returns the full corpus on the splash page.
const { index } = await pagefind.createIndex({ forceLanguage: "fr" });

let added = 0;
let errors = 0;
for (const r of rows) {
  const abstract = r.abstract && r.abstract.length > ABSTRACT_LIMIT
    ? r.abstract.slice(0, ABSTRACT_LIMIT) + "…"
    : (r.abstract || "");

  const decade = r.year ? `${Math.floor(r.year / 10) * 10}s` : null;

  // The `content` is what Pagefind indexes for full-text search. We
  // concatenate title + subjects + abstract; field weighting is handled by
  // Pagefind's heuristics (title-ish HTML hints would help, but with custom
  // records we settle for token frequency and the stemmer). Advisors are
  // included so a name search ("Pâquet") finds theses they directed.
  const content = [
    r.title,
    r.subjects,
    r.advisors,
    abstract,
  ].filter(Boolean).join("\n\n");

  // `meta` and `filters` only accept strings in the Pagefind API. Numbers go
  // to strings; nulls/empties are dropped (Pagefind would reject them).
  const meta = {};
  const filters = {};
  const sort = {};

  if (r.title) meta.title = r.title;
  if (r.authors) meta.authors = r.authors;
  if (r.advisors) meta.advisors = r.advisors;
  if (r.abstract) meta.abstract = abstract;
  if (r.year) {
    meta.year = String(r.year);
    sort.year = String(r.year).padStart(5, "0");  // sort lexicographically
  }
  if (r.source_id) filters.source = [r.source_id];
  if (r.source_name) meta.source_name = r.source_name;
  if (r.type) {
    filters.type = [r.type];
    meta.type = r.type;
    meta.type_label = TYPE_LABEL[r.type] || r.type;
  }
  if (r.discipline) {
    filters.discipline = [r.discipline];
    meta.discipline = r.discipline;
  }
  if (decade) filters.decade = [decade];
  if (r.discipline_source) meta.discipline_source = r.discipline_source;
  if (r.authoritative_discipline) meta.authoritative_discipline = r.authoritative_discipline;
  meta.url = recordUrl(r);

  try {
    await index.addCustomRecord({
      url: recordUrl(r),
      content,
      language: recordLang(r),
      meta,
      filters,
      sort,
    });
    added++;
    if (added % 10000 === 0) {
      console.log(`  ... added ${added.toLocaleString()} / ${rows.length.toLocaleString()}`);
    }
  } catch (err) {
    errors++;
    if (errors <= 3) console.error(`  ! addCustomRecord error: ${err.message}`);
  }
}
console.log(`  added ${added}/${rows.length} records (${errors} errors) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

console.log("▸ Writing index files");
await index.writeFiles({ outputPath: PAGEFIND_DIR });

// ---------------------------------------------------------------- meta + html --

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
  search_engine: "pagefind",
};
writeFileSync(resolve(DIST, "meta.json"), JSON.stringify(meta));

const buildDate = meta.built_at.slice(0, 10);
const html = readFileSync(resolve(ROOT, "web/static.html"), "utf8")
  .replaceAll("__JSONLD_N__", String(rows.length))
  .replaceAll("__JSONLD_S__", String(meta.sources.length))
  .replaceAll("__JSONLD_DATE__", buildDate);
writeFileSync(resolve(DIST, "index.html"), html);

// Copy the shared frontend modules. These live in web/ alongside static.html;
// the FastAPI uvicorn server serves them directly, but the static Pages site
// needs them at the root.
copyFileSync(resolve(ROOT, "web/common.js"), resolve(DIST, "common.js"));
mkdirSync(resolve(DIST, "backends"), { recursive: true });
cpSync(resolve(ROOT, "web/backends"), resolve(DIST, "backends"), { recursive: true });

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

await pagefind.close();

let pagefindSize = "?";
try {
  pagefindSize = execSync(`du -sh "${PAGEFIND_DIR}" | cut -f1`).toString().trim();
} catch {}
console.log(`\n✓ Built ${DIST}/  (pagefind/ ≈ ${pagefindSize})`);
