#!/usr/bin/env node
/**
 * Browser benchmark for static search backends.
 *
 * Requires a local static server, for example:
 *   PORT=5124 npm run serve
 *   npm run bench:search:performance -- --url=http://localhost:5124/
 */

import { chromium } from "playwright-core";

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
    engines: ["tqsearch", "pagefind"],
    queries: DEFAULT_QUERIES,
    runs: 3,
    size: 10,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
    else if (arg.startsWith("--engines=")) args.engines = arg.slice("--engines=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--queries=")) args.queries = arg.slice("--queries=".length).split("|");
    else if (arg.startsWith("--runs=")) args.runs = Number(arg.slice("--runs=".length)) || args.runs;
    else if (arg.startsWith("--size=")) args.size = Number(arg.slice("--size=".length)) || args.size;
  }
  return args;
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

async function runBackend(page, engine, queries, runs, size) {
  const backendFile = `./backends/${engine}.js?perf=${Date.now()}`;
  const initMs = await page.evaluate(async ({ backendFile }) => {
    const backend = (await import(backendFile)).default;
    const t0 = performance.now();
    await backend.init();
    window.__benchBackend = backend;
    return performance.now() - t0;
  }, { backendFile });

  const rows = [];
  for (const q of queries) {
    const times = [];
    let total = 0;
    let firstTitle = "";
    for (let i = 0; i < runs; i++) {
      const result = await page.evaluate(async ({ q, size }) => {
        performance.clearResourceTimings();
        const t0 = performance.now();
        const response = await window.__benchBackend.search({
          q,
          type: "",
          year_min: null,
          year_max: null,
          sort: "relevance",
          discipline: new Set(),
          source: new Set(),
          page: 1,
          size,
        });
        const resources = performance.getEntriesByType("resource")
          .filter(e => e.name.includes("/pagefind/") || e.name.includes("/tqsearch/"));
        return {
          ms: performance.now() - t0,
          total: response.total,
          firstTitle: response.results[0]?.title || "",
          requests: resources.length,
          transfer: resources.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0),
        };
      }, { q, size });
      times.push(result.ms);
      total = result.total;
      firstTitle = result.firstTitle;
    }
    rows.push({
      engine,
      q,
      initMs,
      total,
      firstMs: times[0],
      medianMs: quantile(times, 0.5),
      p95Ms: quantile(times, 0.95),
      runs: times,
      firstTitle,
    });
  }
  return rows;
}

function printTable(rows) {
  console.log("| Engine | Query | Total | First ms | Median ms | P95 ms |");
  console.log("|---|---|---:|---:|---:|---:|");
  for (const r of rows) {
    console.log(`| ${r.engine} | ${r.q || "(empty)"} | ${r.total.toLocaleString("fr-CA")} | ${r.firstMs.toFixed(0)} | ${r.medianMs.toFixed(0)} | ${r.p95Ms.toFixed(0)} |`);
  }
}

const args = parseArgs(process.argv.slice(2));
const browser = await launchBrowser();
try {
  const allRows = [];
  for (const engine of args.engines) {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    allRows.push(...await runBackend(page, engine, args.queries, args.runs, args.size));
    await page.close();
  }
  if (args.json) console.log(JSON.stringify(allRows, null, 2));
  else printTable(allRows);
} finally {
  await browser.close();
}
