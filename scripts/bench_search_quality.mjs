#!/usr/bin/env node
/**
 * Quality benchmark for static search against SQLite FTS5.
 *
 * Requires a built dist/ and a local static server:
 *   PORT=5124 npm run serve
 *   npm run bench:search:quality -- --url=http://localhost:5124/
 */

import Database from "better-sqlite3";
import { chromium } from "playwright-core";

const DEFAULT_TOPICAL_QUERIES = [
  "sante",
  "education",
  "montreal",
  "intelligence artificielle",
  "paquet",
  "diabete type 1",
  "sante publique",
  "education montreal",
  "changements climatiques",
  "apprentissage automatique",
  "machine learning",
  "cancer",
  "autisme",
  "architecture",
  "musique",
  "droit",
  "femmes",
  "migration",
  "environnement",
  "quebec",
  "universite",
  "energie",
  "robotique",
  "neuroscience",
  "covid",
  "travail social",
  "economie",
  "litterature",
  "Claude McKay Langston Hughes",
  "David Hume",
  "Balaenoptera physalus",
  "Irene Senecal",
  "Tremblay",
  "hydroclimatiques",
  "obesite ecole",
  "soins infirmiers",
  "securite informatique",
];

const STOPWORDS = new Set(`
  a au aux avec ce ces dans de des du elle en et eux il ils je la le les leur leurs lui ma mais me mes moi mon ne nos notre nous ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous
  the and for with from that this these those into onto over under between within without about after before than then are was were been being have has had not all any can could should would
  study analysis analyse approach nouvelle new using use based effect effects case concept concepts development
`.split(/\s+/).filter(Boolean));

function parseArgs(argv) {
  const args = {
    url: "http://localhost:5000/",
    db: "data/theses.db",
    engines: ["tqsearch", "pagefind"],
    known: 150,
    topical: DEFAULT_TOPICAL_QUERIES,
    size: 10,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else if (arg.startsWith("--engines=")) args.engines = arg.slice("--engines=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--known=")) args.known = Number(arg.slice("--known=".length)) || args.known;
    else if (arg.startsWith("--topical=")) args.topical = arg.slice("--topical=".length).split("|").filter(Boolean);
    else if (arg.startsWith("--size=")) args.size = Number(arg.slice("--size=".length)) || args.size;
  }
  return args;
}

async function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless: true });

  for (const channel of [process.env.PLAYWRIGHT_CHROME_CHANNEL, "chrome", "msedge"].filter(Boolean)) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {}
  }
  throw new Error(
    "No Chrome-compatible browser found. Install Chrome, set PLAYWRIGHT_CHROME_CHANNEL, or set PLAYWRIGHT_EXECUTABLE_PATH.",
  );
}

function fold(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .toLowerCase();
}

function humanTokens(text) {
  const out = [];
  for (const raw of fold(text).split(/[^a-z0-9]+/u)) {
    if ((raw.length < 4 && !/^\d$/.test(raw)) || STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function ftsQuery(q) {
  return humanTokens(q)
    .filter(t => t.length >= 2 || /^\d$/.test(t))
    .map(t => `"${t}"*`)
    .join(" ");
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffle(values, seed = 12345) {
  const rand = seededRandom(seed);
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function rankIn(results, target) {
  const idx = results.findIndex(r =>
    (target.url && r.url === target.url)
    || r.title === target.title
    || String(r.id) === String(target.id));
  return idx < 0 ? 0 : idx + 1;
}

function metrics(ranks) {
  const n = ranks.length || 1;
  return {
    n: ranks.length,
    hit1: ranks.filter(r => r === 1).length / n,
    hit3: ranks.filter(r => r > 0 && r <= 3).length / n,
    hit10: ranks.filter(r => r > 0 && r <= 10).length / n,
    mrr10: ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / n,
  };
}

function agreement(tq, sq) {
  const tqIds = tq.map(r => r.url || r.title || r.id);
  const sqIds = sq.map(r => r.url || r.title || r.id);
  const tqSet = new Set(tqIds);
  const top1Rank = tqIds.indexOf(sqIds[0]) + 1;
  const overlap = sqIds.filter(id => tqSet.has(id)).length;
  return {
    top1Rank,
    overlap10: overlap / Math.max(1, Math.min(10, sqIds.length)),
  };
}

function agreementMetrics(rows) {
  const n = rows.length || 1;
  return {
    n: rows.length,
    sqliteTop1At1: rows.filter(r => r.top1Rank === 1).length / n,
    sqliteTop1At3: rows.filter(r => r.top1Rank > 0 && r.top1Rank <= 3).length / n,
    sqliteTop1At10: rows.filter(r => r.top1Rank > 0 && r.top1Rank <= 10).length / n,
    sqliteTop1Mrr10: rows.reduce((s, r) => s + (r.top1Rank ? 1 / r.top1Rank : 0), 0) / n,
    overlap10: rows.reduce((s, r) => s + r.overlap10, 0) / n,
  };
}

function buildKnownItemQueries(db, n) {
  const rows = db.prepare(
    "SELECT rowid AS id, title, url FROM theses WHERE title IS NOT NULL AND length(title) > 25 ORDER BY rowid",
  ).all();
  const df = new Map();
  for (const r of rows) {
    for (const t of new Set(humanTokens(r.title))) df.set(t, (df.get(t) || 0) + 1);
  }
  const queryFor = (r) => {
    const terms = [...new Set(humanTokens(r.title))]
      .filter(t => !/^\d+$/.test(t) && (df.get(t) || 0) <= 700)
      .sort((a, b) => (df.get(a) || 999999) - (df.get(b) || 999999));
    return terms.slice(0, Math.min(3, Math.max(2, terms.length))).join(" ");
  };

  const sample = [];
  for (const r of shuffle(rows)) {
    const q = queryFor(r);
    if (q.split(/\s+/).length >= 2) sample.push({ ...r, q });
    if (sample.length >= n) break;
  }
  return sample;
}

function makeSqliteSearch(db, size) {
  const stmt = db.prepare(
    `SELECT t.rowid AS id, t.title, t.url, bm25(theses_fts) AS rank
     FROM theses_fts JOIN theses t ON t.rowid = theses_fts.rowid
     WHERE theses_fts MATCH ?
     ORDER BY rank ASC, t.year DESC
     LIMIT ?`,
  );
  return (q) => {
    const fts = ftsQuery(q);
    if (!fts) return [];
    try {
      return stmt.all(fts, size).map(r => ({ id: String(r.id), title: r.title, url: r.url }));
    } catch {
      return [];
    }
  };
}

async function makeBrowserSearch(page, engine, size) {
  const backendFile = `./backends/${engine}.js?quality=${Date.now()}`;
  await page.evaluate(async ({ backendFile }) => {
    const backend = (await import(backendFile)).default;
    await backend.init();
    window.__qualityBackend = backend;
  }, { backendFile });

  return (q) => page.evaluate(async ({ q, size }) => {
    const response = await window.__qualityBackend.search({
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
    return response.results.map(r => ({ id: String(r.id), title: r.title, url: r.url }));
  }, { q, size });
}

function printSummary(report) {
  console.log("Known-item retrieval");
  console.log("| Engine | n | Hit@1 | Hit@3 | Hit@10 | MRR@10 |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [engine, m] of Object.entries(report.knownItem.metrics)) {
    console.log(`| ${engine} | ${m.n} | ${(m.hit1 * 100).toFixed(1)}% | ${(m.hit3 * 100).toFixed(1)}% | ${(m.hit10 * 100).toFixed(1)}% | ${m.mrr10.toFixed(3)} |`);
  }
  console.log("\nAgreement with SQLite top 10");
  console.log("| Set | n | SQLite top1@1 | SQLite top1@3 | SQLite top1@10 | Overlap@10 |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [name, m] of Object.entries(report.agreement)) {
    console.log(`| ${name} | ${m.n} | ${(m.sqliteTop1At1 * 100).toFixed(1)}% | ${(m.sqliteTop1At3 * 100).toFixed(1)}% | ${(m.sqliteTop1At10 * 100).toFixed(1)}% | ${(m.overlap10 * 100).toFixed(1)}% |`);
  }
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.db, { readonly: true });
const sqliteSearch = makeSqliteSearch(db, args.size);
const known = buildKnownItemQueries(db, args.known).filter(q => sqliteSearch(q.q).length);

const browser = await launchBrowser();
try {
  const report = {
    knownItem: { metrics: { sqlite: null }, missesWhereSqliteFound: {} },
    agreement: {},
    topicalExamples: {},
  };

  const sqliteKnownRanks = known.map(target => rankIn(sqliteSearch(target.q), target));
  report.knownItem.metrics.sqlite = metrics(sqliteKnownRanks);

  for (const engine of args.engines) {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: "domcontentloaded" });
    const search = await makeBrowserSearch(page, engine, args.size);

    const ranks = [];
    const knownAgreement = [];
    const misses = [];
    for (const target of known) {
      const engineResults = await search(target.q);
      const sqliteResults = sqliteSearch(target.q);
      const rank = rankIn(engineResults, target);
      const sqliteRank = rankIn(sqliteResults, target);
      ranks.push(rank);
      knownAgreement.push(agreement(engineResults, sqliteResults));
      if (rank === 0 && sqliteRank) {
        misses.push({
          q: target.q,
          title: target.title,
          sqliteRank,
          engineTop: engineResults[0]?.title || null,
        });
      }
    }
    report.knownItem.metrics[engine] = metrics(ranks);
    report.agreement[`${engine}: known-item`] = agreementMetrics(knownAgreement);
    report.knownItem.missesWhereSqliteFound[engine] = misses.slice(0, 10);

    const topicalAgreement = [];
    const examples = [];
    for (const q of args.topical) {
      const engineResults = await search(q);
      const sqliteResults = sqliteSearch(q);
      const a = agreement(engineResults, sqliteResults);
      topicalAgreement.push(a);
      examples.push({
        q,
        sqliteTop1InEngineRank: a.top1Rank || null,
        overlap10: Number(a.overlap10.toFixed(2)),
        engineTop1: engineResults[0]?.title || null,
        sqliteTop1: sqliteResults[0]?.title || null,
      });
    }
    report.agreement[`${engine}: topical`] = agreementMetrics(topicalAgreement);
    report.topicalExamples[engine] = examples;
    await page.close();
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
} finally {
  await browser.close();
  db.close();
}
