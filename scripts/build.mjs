#!/usr/bin/env node
/**
 * Build the static site for GitHub Pages.
 *
 * Production builds ship tqsearch only:
 *   node scripts/build.mjs
 *
 * Benchmark builds can also include Pagefind for comparison:
 *   node scripts/build.mjs --with-pagefind
 */

import Database from "better-sqlite3";
import {
  copyFileSync,
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
const WITH_PAGEFIND = process.argv.includes("--with-pagefind") || process.argv.includes("--pagefind");

const ABSTRACT_LIMIT = 900;
const INITIAL_RESULT_LIMIT = 50;

if (!existsSync(DB_PATH)) {
  console.log(`▸ ${DB_PATH} missing — fetching latest release`);
  execSync("node scripts/fetch_db.mjs", { stdio: "inherit", cwd: ROOT });
}

rmSync(DIST, { recursive: true, force: true });
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

console.log("▸ Building TQSearch production index");
execSync("node scripts/build_tqsearch.mjs", { stdio: "inherit", cwd: ROOT });

const manifest = JSON.parse(readFileSync(resolve(DIST, "tqsearch/manifest.json"), "utf8"));
writeStaticShell(manifest);

if (WITH_PAGEFIND) {
  await buildPagefind();
} else {
  rmSync(PAGEFIND_DIR, { recursive: true, force: true });
  rmSync(resolve(DIST, "meta.json"), { force: true });
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
console.log(`\n✓ Built ${DIST}/  (tqsearch/ ≈ ${tqsearchSize}${extra})`);
