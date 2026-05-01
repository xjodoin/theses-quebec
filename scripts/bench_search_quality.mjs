#!/usr/bin/env node
/**
 * Quality benchmark for static search against SQLite FTS5.
 * Lucene remains available as an opt-in reference backend.
 *
 * Requires a built dist/ and a local static server:
 *   PORT=5124 npm run serve
 *   npm run bench:search:quality -- --url=http://localhost:5124/
 */

import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    engines: ["tqsearch", "rangefind"],
    known: 150,
    typos: 120,
    topical: DEFAULT_TOPICAL_QUERIES,
    size: 10,
    variants: true,
    exactCheck: 50,
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--json") args.json = true;
    else if (arg.startsWith("--url=")) args.url = arg.slice("--url=".length);
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else if (arg.startsWith("--engines=")) args.engines = arg.slice("--engines=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--known=")) args.known = Number(arg.slice("--known=".length)) || args.known;
    else if (arg.startsWith("--typos=")) args.typos = Number(arg.slice("--typos=".length)) || args.typos;
    else if (arg.startsWith("--topical=")) args.topical = arg.slice("--topical=".length).split("|").filter(Boolean);
    else if (arg.startsWith("--size=")) args.size = Number(arg.slice("--size=".length)) || args.size;
    else if (arg === "--no-variants") args.variants = false;
    else if (arg.startsWith("--exact-check=")) args.exactCheck = Number(arg.slice("--exact-check=".length)) || 0;
  }
  return args;
}

function expandEngineSpecs(engines, variants) {
  const specs = [];
  for (const engine of engines) {
    if (engine === "tqsearch" && variants) {
      specs.push({ label: "tqsearch-base", backend: "tqsearch", rerank: false });
      specs.push({ label: "tqsearch", backend: "tqsearch", rerank: true });
    } else if (engine === "lucene") {
      specs.push({ label: "lucene", backend: "lucene", external: true });
    } else {
      specs.push({ label: engine, backend: engine, rerank: true });
    }
  }
  return specs;
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

function mutateToken(token, seed) {
  if (token.length < 5) return token;
  const innerStart = token.length > 6 ? 1 : 0;
  const span = Math.max(1, token.length - innerStart - (token.length > 6 ? 1 : 0));
  const pos = innerStart + (seed % span);
  const op = seed % 4;
  if (op === 0) {
    return token.slice(0, pos) + token.slice(pos + 1);
  }
  if (op === 1 && pos < token.length - 1) {
    return token.slice(0, pos) + token[pos + 1] + token[pos] + token.slice(pos + 2);
  }
  if (op === 2) {
    const alphabet = "etaoinshrdlucmpgfbvyq";
    const replacement = alphabet[(alphabet.indexOf(token[pos]) + seed + 7) % alphabet.length] || "e";
    return token.slice(0, pos) + replacement + token.slice(pos + 1);
  }
  return token.slice(0, pos) + token[pos] + token.slice(pos);
}

function makeTypoQuery(q, seed) {
  const parts = String(q || "").split(/\s+/).filter(Boolean);
  const eligible = parts
    .map((token, idx) => ({ token, idx }))
    .filter(item => fold(item.token).length >= 5 && /^[a-z0-9]+$/u.test(fold(item.token)));
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.token.length - a.token.length || a.idx - b.idx);
  const selected = eligible[seed % Math.min(eligible.length, 3)];
  const mutated = mutateToken(fold(selected.token), seed);
  if (!mutated || mutated === fold(selected.token)) return null;
  parts[selected.idx] = mutated;
  return parts.join(" ");
}

function buildTypoKnownQueries(known, n) {
  const out = [];
  for (let i = 0; i < known.length && out.length < n; i++) {
    const typoQ = makeTypoQuery(known[i].q, i + 17);
    if (typoQ && typoQ !== known[i].q) out.push({ ...known[i], cleanQ: known[i].q, typoQ });
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
  const tqRank = new Map(tqIds.map((id, idx) => [id, idx]));
  const top1Rank = tqIds.indexOf(sqIds[0]) + 1;
  const overlap = sqIds.filter(id => tqSet.has(id)).length;
  let dcg10 = 0;
  let idcg10 = 0;
  const idealDepth = Math.min(10, sqIds.length);
  for (let i = 0; i < idealDepth; i++) {
    const relevance = (idealDepth - i) / idealDepth;
    idcg10 += relevance / Math.log2(i + 2);
    const foundAt = tqRank.get(sqIds[i]);
    if (foundAt != null && foundAt < 10) {
      dcg10 += relevance / Math.log2(foundAt + 2);
    }
  }
  return {
    top1Rank,
    overlap10: overlap / Math.max(1, Math.min(10, sqIds.length)),
    ndcg10: idcg10 ? dcg10 / idcg10 : 0,
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
    ndcg10: rows.reduce((s, r) => s + r.ndcg10, 0) / n,
  };
}

function average(values) {
  const present = values.filter(value => Number.isFinite(value));
  if (!present.length) return 0;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function runtimeMetrics(rows) {
  const n = rows.length || 1;
  return {
    n: rows.length,
    approximateRate: rows.filter(row => row.approximate).length / n,
    avgBlocksDecoded: average(rows.map(row => row.stats?.blocksDecoded)),
    avgPostingsDecoded: average(rows.map(row => row.stats?.postingsDecoded)),
    avgSkippedBlocks: average(rows.map(row => row.stats?.skippedBlocks)),
    avgRerankCandidates: average(rows.map(row => row.stats?.rerankCandidates)),
    avgDependencyHits: average(rows.map(row => row.stats?.dependencyCandidateMatches)),
  };
}

function typoDiagnostics(rows) {
  const n = rows.length || 1;
  return {
    n: rows.length,
    appliedRate: rows.filter(row => row.stats?.typoApplied).length / n,
    attemptedRate: rows.filter(row => row.stats?.typoAttempted).length / n,
    avgCandidateTerms: average(rows.map(row => row.stats?.typoCandidateTerms)),
    avgShardLookups: average(rows.map(row => row.stats?.typoShardLookups)),
  };
}

function resultKeys(results) {
  return results.map(r => r.url || r.title || r.id);
}

function exactAgreement(rows) {
  const n = rows.length || 1;
  return {
    n: rows.length,
    top1Match: rows.filter(row => row.fast[0] && row.fast[0] === row.exact[0]).length / n,
    top10Match: rows.filter(row => JSON.stringify(row.fast) === JSON.stringify(row.exact)).length / n,
    overlap10: rows.reduce((sum, row) => {
      const exact = new Set(row.exact);
      return sum + row.fast.filter(key => exact.has(key)).length / Math.max(1, row.exact.length);
    }, 0) / n,
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

async function makeBrowserSearch(page, spec, size) {
  const backendFile = `./backends/${spec.backend}.js?quality=${Date.now()}`;
  await page.evaluate(async ({ backendFile }) => {
    const backend = (await import(backendFile)).default;
    await backend.init();
    window.__qualityBackend = backend;
  }, { backendFile });

  return (q, options = {}) => page.evaluate(async ({ q, size, rerank, exact }) => {
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
      rerank,
      exact,
    });
    return {
      total: response.total,
      approximate: !!response.approximate,
      stats: response.stats || {},
      results: response.results.map(r => ({ id: String(r.id), title: r.title, url: r.url })),
    };
  }, { q, size, rerank: spec.rerank, exact: !!options.exact });
}

async function makeLuceneSearch(dbPath, size) {
  const pom = resolve(ROOT, "scripts/lucene-bench/pom.xml");
  const proc = spawn("mvn", [
    "-q",
    "-f",
    pom,
    "exec:java",
    `-Dexec.args=${resolve(ROOT, dbPath)} ${size}`,
  ], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = [];
  let stderr = "";
  let ready = false;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });

  proc.stderr.on("data", chunk => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });

  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    if (!ready) {
      if (line.trim() === "READY") {
        ready = true;
        readyResolve();
      }
      return;
    }
    const next = pending.shift();
    if (!next) return;
    try {
      next.resolve(JSON.parse(line));
    } catch (error) {
      next.reject(new Error(`Invalid Lucene response: ${line}\n${error.message}`));
    }
  });

  proc.on("exit", code => {
    const error = code === 0 ? null : new Error(`Lucene bench exited with ${code}\n${stderr}`);
    if (!ready && error) readyReject(error);
    while (pending.length) {
      pending.shift().reject(error || new Error("Lucene bench closed before returning a result"));
    }
  });

  await readyPromise;

  const search = (q) => new Promise((resolveSearch, rejectSearch) => {
    pending.push({
      resolve: response => resolveSearch({
        total: response.total || 0,
        approximate: false,
        stats: { lucene: true },
        results: (response.results || []).map(r => ({ id: String(r.id), title: r.title, url: r.url })),
      }),
      reject: rejectSearch,
    });
    proc.stdin.write(`${Buffer.from(q, "utf8").toString("base64")}\n`);
  });

  return {
    search,
    close() {
      proc.stdin.end();
      proc.kill();
    },
  };
}

function printSummary(report) {
  console.log("Known-item retrieval");
  console.log("| Engine | n | Hit@1 | Hit@3 | Hit@10 | MRR@10 |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const [engine, m] of Object.entries(report.knownItem.metrics)) {
    console.log(`| ${engine} | ${m.n} | ${(m.hit1 * 100).toFixed(1)}% | ${(m.hit3 * 100).toFixed(1)}% | ${(m.hit10 * 100).toFixed(1)}% | ${m.mrr10.toFixed(3)} |`);
  }
  console.log("\nAgreement with SQLite top 10");
  console.log("| Set | n | SQLite top1@1 | SQLite top1@3 | SQLite top1@10 | Overlap@10 | NDCG@10 |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const [name, m] of Object.entries(report.agreement)) {
    console.log(`| ${name} | ${m.n} | ${(m.sqliteTop1At1 * 100).toFixed(1)}% | ${(m.sqliteTop1At3 * 100).toFixed(1)}% | ${(m.sqliteTop1At10 * 100).toFixed(1)}% | ${(m.overlap10 * 100).toFixed(1)}% | ${(m.ndcg10 * 100).toFixed(1)}% |`);
  }
  console.log("\nTypo recovery");
  console.log("| Engine | n | Target Hit@1 | Target Hit@3 | Target Hit@10 | MRR@10 | Clean top1@10 | Clean NDCG@10 | Applied | Candidates | Shards |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [engine, m] of Object.entries(report.typoRecovery.metrics)) {
    const clean = report.typoRecovery.cleanAgreement[engine] || {};
    const diag = report.typoRecovery.diagnostics[engine] || {};
    console.log(`| ${engine} | ${m.n} | ${(m.hit1 * 100).toFixed(1)}% | ${(m.hit3 * 100).toFixed(1)}% | ${(m.hit10 * 100).toFixed(1)}% | ${m.mrr10.toFixed(3)} | ${((clean.sqliteTop1At10 || 0) * 100).toFixed(1)}% | ${((clean.ndcg10 || 0) * 100).toFixed(1)}% | ${((diag.appliedRate || 0) * 100).toFixed(1)}% | ${(diag.avgCandidateTerms || 0).toFixed(1)} | ${(diag.avgShardLookups || 0).toFixed(1)} |`);
  }
  console.log("\nFast vs exact agreement");
  console.log("| Engine | n | Top1 match | Top10 exact match | Overlap@10 |");
  console.log("|---|---:|---:|---:|---:|");
  for (const [engine, m] of Object.entries(report.fastExactAgreement)) {
    console.log(`| ${engine} | ${m.n} | ${(m.top1Match * 100).toFixed(1)}% | ${(m.top10Match * 100).toFixed(1)}% | ${(m.overlap10 * 100).toFixed(1)}% |`);
  }
  console.log("\nRuntime diagnostics");
  console.log("| Engine | n | Approx | Avg blocks | Avg postings | Avg skipped | Avg rerank | Avg dep hits |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [engine, m] of Object.entries(report.runtime)) {
    console.log(`| ${engine} | ${m.n} | ${(m.approximateRate * 100).toFixed(1)}% | ${m.avgBlocksDecoded.toFixed(1)} | ${m.avgPostingsDecoded.toFixed(0)} | ${m.avgSkippedBlocks.toFixed(1)} | ${m.avgRerankCandidates.toFixed(1)} | ${m.avgDependencyHits.toFixed(1)} |`);
  }
}

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.db, { readonly: true });
const sqliteSearch = makeSqliteSearch(db, args.size);
const known = buildKnownItemQueries(db, args.known).filter(q => sqliteSearch(q.q).length);
const typoKnown = buildTypoKnownQueries(known, args.typos);
const specs = expandEngineSpecs(args.engines, args.variants);

const needsBrowser = specs.some(spec => !spec.external);
const needsLucene = specs.some(spec => spec.backend === "lucene");
const browser = needsBrowser ? await launchBrowser() : null;
const lucene = needsLucene ? await makeLuceneSearch(args.db, args.size) : null;
try {
  const report = {
    knownItem: { metrics: { sqlite: null }, missesWhereSqliteFound: {} },
    agreement: {},
    typoRecovery: { metrics: {}, cleanAgreement: {}, diagnostics: {}, examples: {} },
    fastExactAgreement: {},
    runtime: {},
    topicalExamples: {},
  };

  const sqliteKnownRanks = known.map(target => rankIn(sqliteSearch(target.q), target));
  report.knownItem.metrics.sqlite = metrics(sqliteKnownRanks);
  report.typoRecovery.metrics.sqlite = metrics(typoKnown.map(target => rankIn(sqliteSearch(target.typoQ), target)));
  report.typoRecovery.cleanAgreement.sqlite = agreementMetrics(
    typoKnown.map(target => agreement(sqliteSearch(target.typoQ), sqliteSearch(target.cleanQ))),
  );
  report.typoRecovery.diagnostics.sqlite = typoDiagnostics([]);

  for (const spec of specs) {
    let page = null;
    let search;
    if (spec.backend === "lucene") {
      search = lucene.search;
    } else {
      page = await browser.newPage();
      await page.goto(args.url, { waitUntil: "domcontentloaded" });
      search = await makeBrowserSearch(page, spec, args.size);
    }

    const ranks = [];
    const knownAgreement = [];
    const misses = [];
    const runtimeRows = [];
    for (const target of known) {
      const engineResponse = await search(target.q);
      runtimeRows.push(engineResponse);
      const engineResults = engineResponse.results;
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
    report.knownItem.metrics[spec.label] = metrics(ranks);
    report.agreement[`${spec.label}: known-item`] = agreementMetrics(knownAgreement);
    report.knownItem.missesWhereSqliteFound[spec.label] = misses.slice(0, 10);

    const topicalAgreement = [];
    const examples = [];
    for (const q of args.topical) {
      const engineResponse = await search(q);
      runtimeRows.push(engineResponse);
      const engineResults = engineResponse.results;
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
    report.agreement[`${spec.label}: topical`] = agreementMetrics(topicalAgreement);
    report.topicalExamples[spec.label] = examples;

    const typoRanks = [];
    const typoCleanAgreement = [];
    const typoRows = [];
    const typoExamples = [];
    for (const target of typoKnown) {
      const typoResponse = await search(target.typoQ);
      const cleanResponse = await search(target.cleanQ);
      runtimeRows.push(typoResponse);
      typoRows.push(typoResponse);
      const rank = rankIn(typoResponse.results, target);
      typoRanks.push(rank);
      const a = agreement(typoResponse.results, cleanResponse.results);
      typoCleanAgreement.push(a);
      if (typoExamples.length < 10 && (!rank || a.top1Rank !== 1)) {
        typoExamples.push({
          cleanQ: target.cleanQ,
          typoQ: target.typoQ,
          title: target.title,
          rank: rank || null,
          cleanTop1InTypoRank: a.top1Rank || null,
          typoTop1: typoResponse.results[0]?.title || null,
          cleanTop1: cleanResponse.results[0]?.title || null,
          corrections: typoResponse.stats?.typoCorrections || null,
        });
      }
    }
    report.typoRecovery.metrics[spec.label] = metrics(typoRanks);
    report.typoRecovery.cleanAgreement[spec.label] = agreementMetrics(typoCleanAgreement);
    report.typoRecovery.diagnostics[spec.label] = typoDiagnostics(typoRows);
    report.typoRecovery.examples[spec.label] = typoExamples;
    report.runtime[spec.label] = runtimeMetrics(runtimeRows);

    if (spec.backend === "tqsearch") {
      const exactRows = [];
      const exactQueries = [
        ...known.slice(0, Math.max(0, args.exactCheck - args.topical.length)).map(item => item.q),
        ...args.topical,
      ].slice(0, args.exactCheck);
      for (const q of exactQueries) {
        const fast = await search(q);
        const exact = await search(q, { exact: true });
        exactRows.push({ q, fast: resultKeys(fast.results), exact: resultKeys(exact.results) });
      }
      report.fastExactAgreement[spec.label] = exactAgreement(exactRows);
    }
    if (page) await page.close();
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
} finally {
  if (lucene) lucene.close();
  if (browser) await browser.close();
  db.close();
}
