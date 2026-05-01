#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages.
 *
 * Production builds ship tqsearch only:
 *   node scripts/build.mjs
 *
 * Benchmark builds include Rangefind for standalone-engine comparison:
 *   node scripts/build.mjs --with-rangefind
 *
 * Legacy comparison builds can also include Pagefind:
 *   node scripts/build.mjs --with-pagefind
 *
 * Experimental builds can bake generated sparse expansion into tqsearch:
 *   node scripts/build.mjs --with-sparse-expansion
 */

import Database from "better-sqlite3";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const DIST = resolve(ROOT, "dist");
const PAGEFIND_DIR = resolve(DIST, "pagefind");
const RANGEFIND_DIR = resolve(DIST, "rangefind");
const RANGEFIND_LIB_DIR = resolve(DIST, "rangefind-lib");
const WITH_PAGEFIND = process.argv.includes("--with-pagefind") || process.argv.includes("--pagefind");
const WITH_RANGEFIND = process.argv.includes("--with-rangefind") || process.env.TQSEARCH_WITH_RANGEFIND === "1";
const RANGEFIND_ONLY = process.argv.includes("--rangefind-only");
const RANGEFIND_WITH_TYPO = !process.argv.includes("--no-rangefind-typo") && process.env.TQSEARCH_RANGEFIND_TYPO !== "0";
const WITH_SPARSE_EXPANSION = process.argv.includes("--with-sparse-expansion")
  || process.env.TQSEARCH_WITH_SPARSE_EXPANSION === "1";
const SPARSE_EXPANSION_PATH = resolve(DIST, "_tqsearch_sparse_expansions.jsonl");

const ABSTRACT_LIMIT = 900;
const ABSTRACT_INDEX_LIMIT = 1200;
const INITIAL_RESULT_LIMIT = 50;

if (!existsSync(DB_PATH)) {
  console.log(`▸ ${DB_PATH} missing — fetching latest release`);
  execSync("node scripts/fetch_db.mjs", { stdio: "inherit", cwd: ROOT });
}

if (!RANGEFIND_ONLY) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

function recordUrl(r) {
  if (r.url) return r.url;
  return `urn:tq:${encodeURIComponent(r.oai_identifier)}`;
}

function recordLang(r) {
  const lang = (r.language || "").toLowerCase().slice(0, 2);
  if (lang === "fr" || lang === "en") return lang;
  return "fr";
}

function truncatedAbstract(r) {
  if (!r.abstract) return "";
  return r.abstract.length > ABSTRACT_LIMIT
    ? r.abstract.slice(0, ABSTRACT_LIMIT) + "…"
    : r.abstract;
}

function indexAbstract(r) {
  if (!r.abstract) return "";
  return r.abstract.length > ABSTRACT_INDEX_LIMIT
    ? r.abstract.slice(0, ABSTRACT_INDEX_LIMIT)
    : r.abstract;
}

function loadRows() {
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
  return rows;
}

function countFacet(rows, valueFn, labelFn = value => value) {
  const counts = new Map();
  for (const r of rows) {
    const value = valueFn(r);
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, n]) => ({ value, label: labelFn(value), n }))
    .sort((a, b) => b.n - a.n);
}

function rowResult(r) {
  return {
    id: String(r.id),
    title: r.title,
    authors: r.authors,
    advisors: r.advisors || null,
    abstract: truncatedAbstract(r) || null,
    year: r.year || null,
    type: r.type,
    source_id: r.source_id,
    source_name: r.source_name,
    discipline: r.discipline,
    url: recordUrl(r),
    excerpt: null,
  };
}

function writeStaticShell(manifest) {
  const buildDate = manifest.built_at.slice(0, 10);
  const sourceCount = manifest.facets.source.length;
  const html = readFileSync(resolve(ROOT, "web/static.html"), "utf8")
    .replaceAll("__JSONLD_N__", String(manifest.total))
    .replaceAll("__JSONLD_S__", String(sourceCount))
    .replaceAll("__JSONLD_DATE__", buildDate);
  writeFileSync(resolve(DIST, "index.html"), html);

  copyFileSync(resolve(ROOT, "web/common.js"), resolve(DIST, "common.js"));
  mkdirSync(resolve(DIST, "backends"), { recursive: true });
  copyFileSync(resolve(ROOT, "web/backends/tqsearch.js"), resolve(DIST, "backends/tqsearch.js"));
  if (WITH_PAGEFIND) {
    copyFileSync(resolve(ROOT, "web/backends/pagefind.js"), resolve(DIST, "backends/pagefind.js"));
  }
  if (WITH_RANGEFIND) {
    copyFileSync(resolve(ROOT, "web/backends/rangefind.js"), resolve(DIST, "backends/rangefind.js"));
  }

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

  writeFileSync(
    resolve(DIST, "meta.json"),
    JSON.stringify({
      built_at: manifest.built_at,
      total: manifest.total,
      sources: manifest.facets.source.map(s => ({ id: s.value, name: s.label, n: s.n })),
      facets: manifest.facets,
      search_engine: "tqsearch",
    }),
  );
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

async function buildPagefind() {
  const pagefind = await import("pagefind");
  mkdirSync(PAGEFIND_DIR, { recursive: true });
  rmSync(PAGEFIND_DIR, { recursive: true, force: true });

  const rows = loadRows();
  console.log("▸ Building Pagefind comparison index");
  const t0 = performance.now();
  const { index } = await pagefind.createIndex({ forceLanguage: "fr" });

  let added = 0;
  let errors = 0;
  for (const r of rows) {
    const abstract = truncatedAbstract(r);
    const decade = r.year ? `${Math.floor(r.year / 10) * 10}s` : null;
    const hasAbstract = !!abstract;
    const content = hasAbstract ? abstract : (r.oai_identifier || recordUrl(r));

    const meta = {};
    const filters = {};
    const sort = {};

    if (r.title) meta.title = r.title;
    if (r.authors) meta.authors = r.authors;
    if (r.advisors) meta.advisors = r.advisors;
    if (r.subjects) meta.subjects = r.subjects;
    if (hasAbstract) meta.has_abstract = "1";
    if (r.year) {
      meta.year = String(r.year);
      sort.year = String(r.year).padStart(5, "0");
    }
    if (r.source_id) filters.source = [r.source_id];
    if (r.type) filters.type = [r.type];
    if (r.discipline) filters.discipline = [r.discipline];
    if (decade) filters.decade = [decade];

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

  console.log("▸ Writing Pagefind index files");
  await index.writeFiles({ outputPath: PAGEFIND_DIR });

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
    initial_results: rows.slice(0, INITIAL_RESULT_LIMIT).map(rowResult),
    facets: {
      discipline: countFacet(rows, r => r.discipline),
      source: countFacet(rows, r => r.source_id, id => sourcesById.get(id)?.name || id),
      decade: countFacet(rows, r => r.year ? `${Math.floor(r.year / 10) * 10}s` : null)
        .sort((a, b) => a.value.localeCompare(b.value)),
    },
    search_engine: "pagefind",
  };
  writeFileSync(resolve(DIST, "meta.json"), JSON.stringify(meta));
  await pagefind.close();
}

async function buildRangefind() {
  console.log("▸ Building Rangefind comparison index");
  const { build } = await import("rangefind/builder");
  const rows = loadRows();
  const inputPath = resolve(DIST, "_rangefind_docs.jsonl");
  const configPath = resolve(DIST, "_rangefind.config.json");
  const line = (r) => JSON.stringify({
    ...rowResult(r),
    subjects: r.subjects || "",
    source_name: r.source_name || r.source_id || "",
    decade: r.year ? `${Math.floor(r.year / 10) * 10}s` : "",
    abstract_index: indexAbstract(r) || "",
  });
  writeFileSync(inputPath, rows.map(line).join("\n"));
  writeFileSync(configPath, JSON.stringify({
    input: "_rangefind_docs.jsonl",
    output: "rangefind",
    idPath: "id",
    urlPath: "url",
    docChunkSize: 100,
    maxTermsPerDoc: 140,
    maxExpansionTermsPerDoc: 12,
    fields: [
      { name: "title", path: "title", weight: 4.5, b: 0.35, phrase: true, phraseWeight: 10, proximity: true, proximityWeight: 3.5, proximityWindow: 5, maxProximityTokens: 96 },
      { name: "authors", path: "authors", weight: 3.0, b: 0.0 },
      { name: "advisors", path: "advisors", weight: 2.4, b: 0.0 },
      { name: "subjects", path: "subjects", weight: 2.2, b: 0.35 },
      { name: "discipline", path: "discipline", weight: 1.8, b: 0.0 },
      { name: "abstract", path: "abstract_index", weight: 1.0, b: 0.75, typo: false },
      { name: "source", path: "source_name", weight: 0.4, b: 0.0 },
      { name: "year", path: "year", weight: 1.2, b: 0.0 }
    ],
    facets: [
      { name: "source_id", path: "source_id", labelPath: "source_name" },
      { name: "discipline", path: "discipline" },
      { name: "type", path: "type" },
      { name: "decade", path: "decade" }
    ],
    numbers: [{ name: "year", path: "year" }],
    typo: { enabled: RANGEFIND_WITH_TYPO },
    display: ["id", "url", "title", "authors", "advisors", "abstract", "year", "type", "source_id", "source_name", "discipline"]
  }));
  await build({ configPath });
  rmSync(inputPath, { force: true });
  rmSync(configPath, { force: true });
  rmSync(RANGEFIND_LIB_DIR, { recursive: true, force: true });
  cpSync(resolve(ROOT, "node_modules/rangefind/src"), RANGEFIND_LIB_DIR, { recursive: true });
}

let tqsearchArgs = "";
if (WITH_SPARSE_EXPANSION) {
  console.log("▸ Generating TQSearch sparse expansion terms");
  execSync(`node scripts/generate_tqsearch_sparse_expansions.mjs --out=${shellQuote(SPARSE_EXPANSION_PATH)}`, {
    stdio: "inherit",
    cwd: ROOT,
  });
  tqsearchArgs = ` --sparse-expansions=${shellQuote(SPARSE_EXPANSION_PATH)}`;
}

if (!RANGEFIND_ONLY) {
  console.log("▸ Building TQSearch production index");
  execSync(`node scripts/build_tqsearch.mjs${tqsearchArgs}`, { stdio: "inherit", cwd: ROOT });
  rmSync(SPARSE_EXPANSION_PATH, { force: true });
}

const manifest = JSON.parse(readFileSync(resolve(DIST, "tqsearch/manifest.json"), "utf8"));
writeStaticShell(manifest);

if (WITH_PAGEFIND) {
  await buildPagefind();
} else {
  rmSync(PAGEFIND_DIR, { recursive: true, force: true });
}

if (WITH_RANGEFIND) {
  await buildRangefind();
} else {
  rmSync(RANGEFIND_DIR, { recursive: true, force: true });
  rmSync(RANGEFIND_LIB_DIR, { recursive: true, force: true });
}

let tqsearchSize = "?";
let pagefindSize = null;
try {
  tqsearchSize = execSync(`du -sh "${resolve(DIST, "tqsearch")}" | cut -f1`).toString().trim();
  if (WITH_PAGEFIND) {
    pagefindSize = execSync(`du -sh "${PAGEFIND_DIR}" | cut -f1`).toString().trim();
  }
} catch {}

const extra = WITH_PAGEFIND ? `, pagefind/ ≈ ${pagefindSize}` : "";
let rangefindSize = null;
try {
  if (WITH_RANGEFIND) rangefindSize = execSync(`du -sh "${RANGEFIND_DIR}" | cut -f1`).toString().trim();
} catch {}
const rangefindExtra = WITH_RANGEFIND ? `, rangefind/ ≈ ${rangefindSize}` : "";
console.log(`\n✓ Built ${DIST}/  (tqsearch/ ≈ ${tqsearchSize}${extra}${rangefindExtra})`);
