#!/usr/bin/env node
/**
 * Build a Rangefind static search index for the Quebec theses corpus.
 *
 * Reads data/theses.db, writes a range-addressed static index to
 * dist/rangefind/ plus the browser runtime bundle. Query it with the
 * Rangefind runtime over HTTP range requests — no server, no database.
 *
 *   node scripts/build_rangefind.mjs               # full build from scratch
 *   node scripts/build_rangefind.mjs --update      # incremental delta build
 *   node scripts/build_rangefind.mjs --slim        # drop deploy-only segments
 *   node scripts/build_rangefind.mjs --limit=20000 # quick smoke build
 *
 * Incremental (`--update`) adds only theses whose `harvested_at` is newer
 * than the last build as a new Rangefind generation, leaving every unchanged
 * pack byte (and its CDN cache entry) intact. It falls back to a full rebuild
 * when there is no base index or after MAX_GENERATIONS deltas (the engine has
 * no compaction command yet, and a full rebuild also reconciles deletions).
 *
 * Tuned for the corpus's real UI: one page of top results, facet counts for
 * the discipline/source/type/decade sidebar, and title/author autocomplete.
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { build } from "rangefind/builder";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = process.env.RANGEFIND_DB ? resolve(process.env.RANGEFIND_DB) : resolve(ROOT, "data/theses.db");
const DIST = resolve(ROOT, "dist");
const OUT_DIR = resolve(DIST, "rangefind");
const JSONL_PATH = resolve(ROOT, "dist/_theses.rangefind.jsonl");
const CONFIG_PATH = resolve(ROOT, "dist/_theses.rangefind.config.json");
const STATE_PATH = resolve(OUT_DIR, "build-state.json");
const RUNTIME_SRC = resolve(ROOT, "node_modules/rangefind/dist/runtime.browser.js");

const ABSTRACT_INDEX_CHARS = 1600; // how much abstract the indexer considers
const ABSTRACT_DISPLAY_CHARS = 900; // how much is returned with results
// Rebuild fully once a generational index reaches this many generations, so
// query fan-out stays bounded and deletions/drift are reconciled.
const MAX_GENERATIONS = Number(process.env.RANGEFIND_MAX_GENERATIONS) || 6;

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));
const LIMIT = Number(args.get("limit")) || 0;
// --slim drops the segment source packs (the default search + facet + suggest
// path never fetches them; they only back `exact:true` / count fanout).
const SLIM = Boolean(args.get("slim"));
const UPDATE = Boolean(args.get("update"));

// `subjects` is a "; "-delimited keyword list; `authors`/`advisors` are
// occasionally multi-valued the same way. Split so each value is indexed and
// autocompleted independently, and drop the literal "None" some rows carry.
function splitList(value) {
  if (!value) return [];
  const cleaned = String(value).trim();
  if (!cleaned || cleaned === "None") return [];
  return cleaned.split(/\s*;\s*/u).map(v => v.trim()).filter(Boolean);
}

function truncate(text, max) {
  if (!text) return "";
  const s = String(text);
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function toDoc(row) {
  const authors = splitList(row.authors);
  const advisors = splitList(row.advisors);
  const subjects = splitList(row.subjects);
  const abstract = row.abstract ? String(row.abstract) : "";
  return {
    id: String(row.id),
    url: row.url || "",
    title: row.title || "",
    authors,                                   // indexed + autocomplete
    authors_display: authors.join("; "),       // returned with results
    advisors,
    advisors_display: advisors.join("; "),
    subjects,                                  // high-weight keyword text
    discipline: row.discipline || "",
    abstract_index: truncate(abstract, ABSTRACT_INDEX_CHARS),
    abstract: truncate(abstract, ABSTRACT_DISPLAY_CHARS),
    year: Number.isFinite(row.year) ? row.year : null,
    decade: row.year ? `${Math.floor(row.year / 10) * 10}s` : "",
    type: row.type || "",
    language: row.language || "",
    source_id: row.source_id || "",
    source_name: row.source_name || row.source_id || ""
  };
}

// Writes the rows matching `where` to the JSONL input and returns
// { count, marker } where marker is the newest harvested_at written.
function writeJsonl({ where = "", params = [] } = {}) {
  console.log(`▸ Reading ${DB_PATH}`);
  const db = new Database(DB_PATH, { readonly: true });
  const whereClause = where ? `WHERE ${where}` : "";
  const limitClause = LIMIT ? `LIMIT ${LIMIT}` : "";
  const rows = db.prepare(`
    SELECT rowid AS id, title, authors, advisors, abstract, subjects,
           year, type, source_id, source_name, discipline, language, url,
           harvested_at
    FROM theses ${whereClause} ORDER BY rowid ${limitClause}
  `).all(...params);
  db.close();
  mkdirSync(dirname(JSONL_PATH), { recursive: true });
  writeFileSync(JSONL_PATH, rows.map(row => JSON.stringify(toDoc(row))).join("\n"));
  let marker = "";
  for (const row of rows) if (row.harvested_at && row.harvested_at > marker) marker = row.harvested_at;
  console.log(`  ${rows.length.toLocaleString()} theses → ${JSONL_PATH}`);
  return { count: rows.length, marker };
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function makeConfig() {
  const workers = Math.max(1, Math.min(10, availableParallelism() - 2));
  return {
    // Config must be identical between the full base and every delta so
    // scores stay comparable across generations.
    input: "_theses.rangefind.jsonl",
    output: "rangefind",
    idPath: "id",
    urlPath: "url",

    // Academic abstracts are dense; index more terms per doc than the default
    // 12 for better recall, and cap the abstract text the indexer scans.
    targetPostingsPerDoc: 48,
    bodyIndexChars: ABSTRACT_INDEX_CHARS,
    alwaysIndexFields: ["title", "subjects", "discipline"],
    typoMode: "main-index",

    scanWorkers: workers,
    builderWorkerCount: workers,
    partitionReducerWorkers: workers,

    fields: [
      { name: "title", path: "title", weight: 5.0, b: 0.35, phrase: true, phraseWeight: 10, proximity: true, proximityWeight: 3.5, proximityWindow: 5 },
      { name: "authors", path: "authors", weight: 3.0, b: 0.0 },
      { name: "advisors", path: "advisors", weight: 2.2, b: 0.0 },
      { name: "subjects", path: "subjects", weight: 2.2, b: 0.4 },
      { name: "discipline", path: "discipline", weight: 1.6, b: 0.0 },
      { name: "abstract", path: "abstract_index", weight: 1.0, b: 0.75 },
      { name: "source", path: "source_name", weight: 0.4, b: 0.0 }
    ],

    facets: [
      { name: "discipline", path: "discipline" },
      { name: "source_id", path: "source_id", labelPath: "source_name" },
      { name: "type", path: "type" },
      { name: "decade", path: "decade" },
      { name: "language", path: "language" }
    ],

    numbers: [
      { name: "year", path: "year", type: "int", sortable: true }
    ],

    // Autocomplete: titles, author names, and discipline labels. Popularity
    // ranks them (most theses share a value); token prefixes make mid-label
    // matches work ("mécanique" → "Génie mécanique").
    suggest: [
      { path: "title" },
      { path: "authors" },
      { path: "discipline" }
    ],

    // Exact title/discipline rescue layered over BM25.
    authority: [
      { name: "title", path: "title" },
      { name: "discipline", path: "discipline" }
    ],

    display: [
      "id", "url", "title",
      { name: "authors", path: "authors_display" },
      { name: "advisors", path: "advisors_display" },
      "abstract", "year", "type", "source_id", "source_name", "discipline"
    ]
  };
}

// Removes the segment source directory and strips its manifest reference.
// The runtime reads `manifest.segments?.manifest` optionally, so dropping the
// key leaves the default lanes (skipped search, facets, sort, suggest,
// authority) fully working while shedding the largest deploy-only-if-needed
// directory. Only `exact:true` searches and count fanout rely on segments.
function slimIndex() {
  rmSync(resolve(OUT_DIR, "segments"), { recursive: true, force: true });
  for (const name of ["manifest.min.json", "manifest.json", "manifest.full.json"]) {
    const path = resolve(OUT_DIR, name);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (manifest.segments) {
      manifest.segments = { ...manifest.segments, published: false, manifest: null };
    }
    if (manifest.features) manifest.features.segmentManifest = false;
    const indent = name === "manifest.min.json" ? undefined : 2;
    writeFileSync(path, JSON.stringify(manifest, null, indent));
  }
  console.log("  --slim: dropped segments/ (default search path unaffected)");
}

async function fullBuild(reason) {
  const started = performance.now();
  if (reason) console.log(`▸ Full build (${reason})`);
  rmSync(OUT_DIR, { recursive: true, force: true });
  const { count, marker } = writeJsonl();
  writeFileSync(CONFIG_PATH, JSON.stringify(makeConfig(), null, 2));

  console.log("▸ Building Rangefind index");
  await build({ configPath: CONFIG_PATH });

  finishArtifacts();
  if (SLIM) slimIndex();
  writeState({ marker, generations: 1, total: count, builtAt: new Date().toISOString() });

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\n✓ Full build ${OUT_DIR}/ — ${count.toLocaleString()} theses in ${seconds}s`);
}

async function incrementalBuild() {
  const state = readState();
  if (!state || !existsSync(resolve(OUT_DIR, "manifest.json"))) {
    return fullBuild("no base index to update");
  }
  if ((state.generations || 1) >= MAX_GENERATIONS) {
    return fullBuild(`generation cap reached (${state.generations} ≥ ${MAX_GENERATIONS})`);
  }

  const started = performance.now();
  console.log(`▸ Incremental update since harvested_at > ${state.marker || "(none)"}`);
  const { count, marker } = writeJsonl({ where: "harvested_at > ?", params: [state.marker || ""] });
  if (count === 0) {
    rmSync(JSONL_PATH, { force: true });
    console.log("✓ No theses changed since the last build — index unchanged.");
    return;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(makeConfig(), null, 2));

  console.log("▸ Adding delta generation");
  await build({ configPath: CONFIG_PATH, update: true });

  finishArtifacts();
  const root = JSON.parse(readFileSync(resolve(OUT_DIR, "manifest.min.json"), "utf8"));
  writeState({
    marker: marker > (state.marker || "") ? marker : state.marker,
    generations: root.generations?.length || (state.generations || 1) + 1,
    total: root.total,
    builtAt: new Date().toISOString()
  });

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\n✓ Delta added — ${count.toLocaleString()} changed theses, ${root.total.toLocaleString()} alive, ${root.generations?.length} generations, in ${seconds}s`);
}

// Copy the runtime bundle, drop build scratch, remove temp inputs. (Slim is
// applied only on full builds; a delta's own segments are negligible.)
function finishArtifacts() {
  copyFileSync(RUNTIME_SRC, resolve(OUT_DIR, "runtime.browser.js"));
  rmSync(JSONL_PATH, { force: true });
  rmSync(CONFIG_PATH, { force: true });
  rmSync(resolve(OUT_DIR, "_build"), { recursive: true, force: true });
}

// Assembles the deployable site around the index: the search shell, shared
// UI, backend adapter, sitemap, and robots. Reads totals from the DB so it
// works identically for full and generational (incremental) builds.
function writeSite() {
  const db = new Database(DB_PATH, { readonly: true });
  const total = db.prepare("SELECT COUNT(*) AS n FROM theses").get().n;
  const sourceCount = db.prepare("SELECT COUNT(DISTINCT source_id) AS n FROM theses").get().n;
  db.close();
  const buildDate = new Date().toISOString().slice(0, 10);

  const html = readFileSync(resolve(ROOT, "web/static.html"), "utf8")
    .replaceAll("__JSONLD_N__", String(total))
    .replaceAll("__JSONLD_S__", String(sourceCount))
    .replaceAll("__JSONLD_DATE__", buildDate);
  writeFileSync(resolve(DIST, "index.html"), html);

  copyFileSync(resolve(ROOT, "web/common.js"), resolve(DIST, "common.js"));
  mkdirSync(resolve(DIST, "backends"), { recursive: true });
  copyFileSync(resolve(ROOT, "web/backends/rangefind.js"), resolve(DIST, "backends/rangefind.js"));

  writeFileSync(resolve(DIST, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://xjodoin.github.io/theses-quebec/</loc><lastmod>${buildDate}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`);
  writeFileSync(resolve(DIST, "robots.txt"),
    "User-agent: *\nAllow: /\nSitemap: https://xjodoin.github.io/theses-quebec/sitemap.xml\n");

  // The UI polls meta.json to show a "new index available" banner; it only
  // needs the current index's built_at (which changes on every build/update).
  const manifest = JSON.parse(readFileSync(resolve(OUT_DIR, "manifest.min.json"), "utf8"));
  writeFileSync(resolve(DIST, "meta.json"), JSON.stringify({
    built_at: manifest.built_at || new Date().toISOString(),
    total,
    sources: sourceCount
  }));
  console.log(`▸ Site shell written (${total.toLocaleString()} theses, ${sourceCount} sources)`);
}

// data/theses.db is distributed via GitHub Releases (gitignored), so fetch it
// on demand — same as the previous build did. Skipped when RANGEFIND_DB
// points at an explicit database (tests).
function ensureDatabase() {
  if (existsSync(DB_PATH)) return;
  if (process.env.RANGEFIND_DB) throw new Error(`RANGEFIND_DB not found: ${DB_PATH}`);
  console.log("▸ Database missing — fetching latest release");
  execSync("node scripts/fetch_db.mjs", { cwd: ROOT, stdio: "inherit" });
}

async function main() {
  ensureDatabase();
  if (UPDATE) await incrementalBuild();
  else await fullBuild();
  writeSite();
  console.log("  Serve dist/ over a host with HTTP range support (npm run serve).");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
