#!/usr/bin/env node
/**
 * Browser benchmark for static search backends.
 *
 * Requires a local static server, for example:
 *   PORT=5124 npm run serve
 *   npm run bench:search:performance -- --url=http://localhost:5124/
 */

import { chromium } from "playwright-core";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_QUERIES = [
  "",
  "sante",
  "education",
  "montreal",
  "intelligence artificielle",
  "paquet",
  "diabete type 1",
  "sante publique",
];

function parseArgs(argv) {
  const args = {
    url: "http://localhost:5000/",
    engines: ["tqsearch", "rangefind"],
    queries: DEFAULT_QUERIES,
    runs: 3,
    size: 10,
    filters: {
      type: "",
      year_min: null,
      year_max: null,
      discipline: [],
      source: [],
    },
    rerank: true,
    variants: false,
    exactRefine: true,
    dist: "dist",
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
    else if (arg.startsWith("--engines=")) args.engines = arg.slice("--engines=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--queries=")) args.queries = arg.slice("--queries=".length).split("|");
    else if (arg.startsWith("--runs=")) args.runs = Number(arg.slice("--runs=".length)) || args.runs;
    else if (arg.startsWith("--size=")) args.size = Number(arg.slice("--size=".length)) || args.size;
    else if (arg.startsWith("--type=")) args.filters.type = arg.slice("--type=".length);
    else if (arg.startsWith("--year-min=")) args.filters.year_min = Number(arg.slice("--year-min=".length)) || null;
    else if (arg.startsWith("--year-max=")) args.filters.year_max = Number(arg.slice("--year-max=".length)) || null;
    else if (arg.startsWith("--discipline=")) args.filters.discipline = arg.slice("--discipline=".length).split("|").filter(Boolean);
    else if (arg.startsWith("--source=")) args.filters.source = arg.slice("--source=".length).split("|").filter(Boolean);
    else if (arg === "--no-rerank") args.rerank = false;
    else if (arg === "--variants") args.variants = true;
    else if (arg === "--no-exact-refine") args.exactRefine = false;
    else if (arg.startsWith("--dist=")) args.dist = arg.slice("--dist=".length);
  }
  return args;
}

function expandEngineSpecs(engines, { variants, rerank }) {
  const specs = [];
  for (const engine of engines) {
    if (engine === "tqsearch" && variants) {
      specs.push({ label: "tqsearch-base", backend: "tqsearch", rerank: false });
      specs.push({ label: "tqsearch", backend: "tqsearch", rerank: true });
    } else {
      specs.push({ label: engine, backend: engine, rerank });
    }
  }
  return specs;
}

async function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless: true });

  const channels = [
    process.env.PLAYWRIGHT_CHROME_CHANNEL,
    "chrome",
    "msedge",
  ].filter(Boolean);
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  throw new Error(
    "No Chrome-compatible browser found. Install Chrome, set PLAYWRIGHT_CHROME_CHANNEL, or set PLAYWRIGHT_EXECUTABLE_PATH.",
  );
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[idx];
}

function kb(bytes) {
  return bytes / 1024;
}

function mb(bytes) {
  return bytes / (1024 * 1024);
}

function dirStats(path) {
  if (!existsSync(path)) return null;
  const s = statSync(path);
  if (s.isFile()) return { bytes: s.size, files: 1 };
  if (!s.isDirectory()) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = dirStats(resolve(path, entry.name));
    if (!child) continue;
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

function isSearchAsset(url) {
  return url.includes("/backends/") || url.includes("/pagefind/") || url.includes("/tqsearch/") || url.includes("/rangefind/");
}

function createNetworkMeter(page) {
  let active = null;
  const onResponse = (response) => {
    if (!active || !isSearchAsset(response.url())) return;
    active.requests++;
    const headers = response.headers();
    const len = Number(headers["content-length"] || 0);
    if (Number.isFinite(len) && len > 0) active.transfer += len;
  };
  page.context().on("response", onResponse);
  return {
    async measure(fn) {
      active = { requests: 0, transfer: 0 };
      const value = await fn();
      await page.waitForTimeout(50);
      const stats = active;
      active = null;
      return { value, ...stats };
    },
    dispose() {
      page.context().off("response", onResponse);
    },
  };
}

async function loadIndexStats(page, backend, distRoot) {
  const localDir = resolve(distRoot, backend);
  const local = dirStats(localDir) || { bytes: 0, files: 0 };
  if (backend === "rangefind") {
    const termLocal = dirStats(resolve(localDir, "terms")) || { bytes: 0, files: 0 };
    const typoLocal = dirStats(resolve(localDir, "typo")) || { bytes: 0, files: 0 };
    const manifestStats = await page.evaluate(async () => {
      const manifest = await fetch("./rangefind/manifest.json").then(r => r.json());
      return {
        terms: manifest.stats?.terms || 0,
        postings: manifest.stats?.postings || 0,
        shards: manifest.directory?.entries || manifest.stats?.term_shards || 0,
        scoring: manifest.stats?.scoring || "rangefind-bm25f",
        termStorage: manifest.stats?.term_storage || "",
        termPackFiles: manifest.stats?.term_pack_files || 0,
        termDirectoryFiles: manifest.directory ? (manifest.directory.page_files || 0) + 1 : 0,
        termDirectoryBytes: manifest.directory?.total_bytes || 0,
        typo: manifest.typo || null,
        typoDirectoryFiles: manifest.typo?.directory ? (manifest.typo.directory.page_files || 0) + 1 : 0,
        typoDirectoryBytes: manifest.typo?.directory?.total_bytes || 0,
      };
    });
    return {
      ...local,
      ...manifestStats,
      termBytes: termLocal.bytes,
      termFiles: termLocal.files,
      typoBytes: typoLocal.bytes,
      typoFiles: typoLocal.files,
    };
  }
  if (backend !== "tqsearch") return { ...local };
  const termLocal = dirStats(resolve(localDir, "terms")) || { bytes: 0, files: 0 };
  const typoLocal = dirStats(resolve(localDir, "typo")) || { bytes: 0, files: 0 };
  const manifestStats = await page.evaluate(async () => {
    const manifest = await fetch("./tqsearch/manifest.json").then(r => r.json());
    return {
      terms: manifest.stats?.terms || 0,
      postings: manifest.stats?.postings || 0,
      shards: manifest.shards?.length || 0,
      scoring: manifest.stats?.scoring || "",
      sparseExpansion: manifest.stats?.sparse_expansion || null,
      typo: manifest.stats?.typo || null,
      termStorage: manifest.stats?.term_storage || "",
      termPackFiles: manifest.stats?.term_pack_files || 0,
      maxExpansionTermsPerDoc: manifest.stats?.max_expansion_terms_per_doc || 0,
      rerankCandidates: 30,
    };
  });
  return {
    ...local,
    ...manifestStats,
    termBytes: termLocal.bytes,
    termFiles: termLocal.files,
    typoBytes: typoLocal.bytes,
    typoFiles: typoLocal.files,
  };
}

async function runBackend(page, spec, queries, runs, size, filters, options) {
  const meter = createNetworkMeter(page);
  const backendFile = `./backends/${spec.backend}.js?perf=${Date.now()}`;
  const init = await meter.measure(() => page.evaluate(async ({ backendFile }) => {
    const backend = (await import(backendFile)).default;
    const t0 = performance.now();
    await backend.init();
    window.__benchBackend = backend;
    return performance.now() - t0;
  }, { backendFile }));
  const indexStats = await loadIndexStats(page, spec.backend, options.dist);

  const rows = [];
  try {
    for (const q of queries) {
      const times = [];
      const requests = [];
      const transfers = [];
      let total = 0;
      let approximate = false;
      let firstTitle = "";
      let firstStats = {};
      let firstKeys = [];
      let firstApproximate = false;
      let refine = null;
      for (let i = 0; i < runs; i++) {
        const measured = await meter.measure(() => page.evaluate(async ({ q, size, filters, rerank }) => {
          const t0 = performance.now();
          const response = await window.__benchBackend.search({
            q,
            type: filters.type,
            year_min: filters.year_min,
            year_max: filters.year_max,
            sort: "relevance",
            discipline: new Set(filters.discipline),
            source: new Set(filters.source),
            page: 1,
            size,
            rerank,
          });
          return {
            ms: performance.now() - t0,
            total: response.total,
            approximate: !!response.approximate,
            firstTitle: response.results[0]?.title || "",
            stats: response.stats || {},
            keys: response.results.map(r => r.url || r.title || r.id),
          };
        }, { q, size, filters, rerank: spec.rerank }));
        const result = measured.value;
        times.push(result.ms);
        requests.push(measured.requests);
        transfers.push(measured.transfer);
        total = result.total;
        approximate = result.approximate;
        firstTitle = result.firstTitle;
        if (i === 0) {
          firstStats = result.stats;
          firstKeys = result.keys;
          firstApproximate = result.approximate;
        }
      }

      if (options.exactRefine && firstApproximate) {
        const measured = await meter.measure(() => page.evaluate(async ({ q, size, filters, rerank }) => {
          const t0 = performance.now();
          const response = await window.__benchBackend.search({
            q,
            type: filters.type,
            year_min: filters.year_min,
            year_max: filters.year_max,
            sort: "relevance",
            discipline: new Set(filters.discipline),
            source: new Set(filters.source),
            page: 1,
            size,
            exact: true,
            rerank,
          });
          return {
            ms: performance.now() - t0,
            total: response.total,
            approximate: !!response.approximate,
            stats: response.stats || {},
            keys: response.results.map(r => r.url || r.title || r.id),
          };
        }, { q, size, filters, rerank: spec.rerank }));
        const exact = measured.value;
        const exactSet = new Set(exact.keys);
        refine = {
          ms: exact.ms,
          requests: measured.requests,
          transfer: measured.transfer,
          total: exact.total,
          approximate: exact.approximate,
          stats: exact.stats,
          top1Match: !!firstKeys[0] && firstKeys[0] === exact.keys[0],
          top10Match: JSON.stringify(firstKeys) === JSON.stringify(exact.keys),
          overlap10: firstKeys.filter(key => exactSet.has(key)).length / Math.max(1, exact.keys.length),
        };
      }
      rows.push({
        engine: spec.label,
        backend: spec.backend,
        rerank: spec.rerank,
        q,
        initMs: init.value,
        initRequests: init.requests,
        initTransfer: init.transfer,
        total,
        approximate,
        firstMs: times[0],
        firstRequests: requests[0],
        firstTransfer: transfers[0],
        firstTotalTransfer: transfers[0] + (refine?.transfer || 0),
        medianMs: quantile(times, 0.5),
        p95Ms: quantile(times, 0.95),
        runs: times,
        requests,
        transfers,
        firstTitle,
        firstStats,
        refine,
        indexStats,
      });
    }
  } finally {
    meter.dispose();
  }
  return rows;
}

function sparseLabel(stats) {
  const sparse = stats?.sparseExpansion;
  if (!sparse) return "-";
  if (!sparse.enabled) return "off";
  return `${Number(sparse.terms_indexed || 0).toLocaleString("fr-CA")} terms`;
}

function printIndexSummary(rows) {
  const byEngine = new Map();
  for (const row of rows) {
    if (!byEngine.has(row.engine)) byEngine.set(row.engine, row.indexStats || {});
  }
  console.log("Index / build artifact");
  console.log("| Engine | Files | Size MB | Terms | Postings | Shards | Term MB | Term files | Term packs | Term dir KB | Typo MB | Typo files | Typo packs | Typo dir KB | Typo keys | Scoring | Sparse |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const [engine, stats] of byEngine) {
    const terms = stats.terms ? Number(stats.terms).toLocaleString("fr-CA") : "-";
    const postings = stats.postings ? Number(stats.postings).toLocaleString("fr-CA") : "-";
    const shards = stats.shards ? Number(stats.shards).toLocaleString("fr-CA") : "-";
    const termMb = stats.termBytes ? mb(stats.termBytes).toFixed(1) : "-";
    const termFiles = stats.termFiles ? Number(stats.termFiles).toLocaleString("fr-CA") : "-";
    const termPacks = stats.termPackFiles ? Number(stats.termPackFiles).toLocaleString("fr-CA") : "-";
    const termDirectoryKb = stats.termDirectoryBytes ? kb(stats.termDirectoryBytes).toFixed(1) : "-";
    const typoMb = stats.typoBytes ? mb(stats.typoBytes).toFixed(1) : "-";
    const typoFiles = stats.typoFiles ? Number(stats.typoFiles).toLocaleString("fr-CA") : "-";
    const typoPacks = (stats.typo?.stats?.pack_files || stats.typo?.packs)
      ? Number(stats.typo.stats?.pack_files || stats.typo.packs).toLocaleString("fr-CA")
      : "-";
    const typoDirectoryKb = stats.typoDirectoryBytes ? kb(stats.typoDirectoryBytes).toFixed(1) : "-";
    const typoKeys = stats.typo?.stats?.delete_keys
      ? Number(stats.typo.stats.delete_keys).toLocaleString("fr-CA")
      : "-";
    console.log(`| ${engine} | ${stats.files || 0} | ${mb(stats.bytes || 0).toFixed(1)} | ${terms} | ${postings} | ${shards} | ${termMb} | ${termFiles} | ${termPacks} | ${termDirectoryKb} | ${typoMb} | ${typoFiles} | ${typoPacks} | ${typoDirectoryKb} | ${typoKeys} | ${stats.scoring || "-"} | ${sparseLabel(stats)} |`);
  }
  console.log("");
}

function printTable(rows) {
  printIndexSummary(rows);
  console.log("Query path");
  console.log("| Engine | Query | Total | Init req | Init KB | Fast req | Fast KB | Fast ms | Refine req | Refine KB | Refine ms | First KB | Median ms | P95 ms | Blocks | Postings | Skip | Rerank | Dep hits | Exact@10 |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const total = `${r.total.toLocaleString("fr-CA")}${r.approximate ? "+" : ""}`;
    const stats = r.firstStats || {};
    const value = key => stats[key] == null ? "-" : Number(stats[key]).toLocaleString("fr-CA");
    const refineReq = r.refine ? r.refine.requests : 0;
    const refineKb = r.refine ? kb(r.refine.transfer).toFixed(1) : "0.0";
    const refineMs = r.refine ? r.refine.ms.toFixed(0) : "0";
    const exact = r.refine ? `${(r.refine.overlap10 * 100).toFixed(0)}%` : "-";
    console.log(`| ${r.engine} | ${r.q || "(empty)"} | ${total} | ${r.initRequests} | ${kb(r.initTransfer).toFixed(1)} | ${r.firstRequests} | ${kb(r.firstTransfer).toFixed(1)} | ${r.firstMs.toFixed(0)} | ${refineReq} | ${refineKb} | ${refineMs} | ${kb(r.firstTotalTransfer).toFixed(1)} | ${r.medianMs.toFixed(0)} | ${r.p95Ms.toFixed(0)} | ${value("blocksDecoded")} | ${value("postingsDecoded")} | ${value("skippedBlocks")} | ${value("rerankCandidates")} | ${value("dependencyCandidateMatches")} | ${exact} |`);
  }
}

const args = parseArgs(process.argv.slice(2));
const browser = await launchBrowser();
try {
  const allRows = [];
  for (const spec of expandEngineSpecs(args.engines, args)) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    allRows.push(...await runBackend(page, spec, args.queries, args.runs, args.size, args.filters, args));
    await context.close();
  }
  if (args.json) console.log(JSON.stringify(allRows, null, 2));
  else printTable(allRows);
} finally {
  await browser.close();
}
