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
    filters: {
      type: "",
      year_min: null,
      year_max: null,
      discipline: [],
      source: [],
    },
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

function kb(bytes) {
  return bytes / 1024;
}

function isSearchAsset(url) {
  return url.includes("/backends/") || url.includes("/pagefind/") || url.includes("/tqsearch/");
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

async function runBackend(page, engine, queries, runs, size, filters) {
  const meter = createNetworkMeter(page);
  const backendFile = `./backends/${engine}.js?perf=${Date.now()}`;
  const init = await meter.measure(() => page.evaluate(async ({ backendFile }) => {
    const backend = (await import(backendFile)).default;
    const t0 = performance.now();
    await backend.init();
    window.__benchBackend = backend;
    return performance.now() - t0;
  }, { backendFile }));

  const rows = [];
  try {
    for (const q of queries) {
      const times = [];
      const requests = [];
      const transfers = [];
      let total = 0;
      let approximate = false;
      let firstTitle = "";
      for (let i = 0; i < runs; i++) {
        const measured = await meter.measure(() => page.evaluate(async ({ q, size, filters }) => {
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
          });
          return {
            ms: performance.now() - t0,
            total: response.total,
            approximate: !!response.approximate,
            firstTitle: response.results[0]?.title || "",
          };
        }, { q, size, filters }));
        const result = measured.value;
        times.push(result.ms);
        requests.push(measured.requests);
        transfers.push(measured.transfer);
        total = result.total;
        approximate = result.approximate;
        firstTitle = result.firstTitle;
      }
      rows.push({
        engine,
        q,
        initMs: init.value,
        initRequests: init.requests,
        initTransfer: init.transfer,
        total,
        approximate,
        firstMs: times[0],
        firstRequests: requests[0],
        firstTransfer: transfers[0],
        medianMs: quantile(times, 0.5),
        p95Ms: quantile(times, 0.95),
        runs: times,
        requests,
        transfers,
        firstTitle,
      });
    }
  } finally {
    meter.dispose();
  }
  return rows;
}

function printTable(rows) {
  console.log("| Engine | Query | Total | Init req | Init KB | First req | First KB | First ms | Median ms | P95 ms |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const total = `${r.total.toLocaleString("fr-CA")}${r.approximate ? "+" : ""}`;
    console.log(`| ${r.engine} | ${r.q || "(empty)"} | ${total} | ${r.initRequests} | ${kb(r.initTransfer).toFixed(1)} | ${r.firstRequests} | ${kb(r.firstTransfer).toFixed(1)} | ${r.firstMs.toFixed(0)} | ${r.medianMs.toFixed(0)} | ${r.p95Ms.toFixed(0)} |`);
  }
}

const args = parseArgs(process.argv.slice(2));
const browser = await launchBrowser();
try {
  const allRows = [];
  for (const engine of args.engines) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    allRows.push(...await runBackend(page, engine, args.queries, args.runs, args.size, args.filters));
    await context.close();
  }
  if (args.json) console.log(JSON.stringify(allRows, null, 2));
  else printTable(allRows);
} finally {
  await browser.close();
}
