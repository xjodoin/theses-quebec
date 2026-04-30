#!/usr/bin/env node
/**
 * Build a static, impact-scored search index for the theses corpus.
 *
 * This is a prototype alternative to Pagefind for this dataset. The index is
 * designed around the UI's real access pattern: return one page of top results
 * plus facet counts, without requiring a full Pagefind result enumeration.
 */

import Database from "better-sqlite3";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const OUT = resolve(ROOT, "dist/tqsearch");
const DOCS_OUT = resolve(OUT, "docs");
const TERMS_OUT = resolve(OUT, "terms");
const TERM_PACKS_OUT = resolve(TERMS_OUT, "packs");
const TYPO_OUT = resolve(OUT, "typo");
const TYPO_PACKS_OUT = resolve(TYPO_OUT, "packs");
const WORK_OUT = resolve(OUT, "_build");
const RUNS_OUT = resolve(WORK_OUT, "runs");
const TYPO_RUNS_OUT = resolve(WORK_OUT, "typo-runs");
const args = parseArgs(process.argv.slice(2));

const ABSTRACT_DISPLAY_LIMIT = 900;
const ABSTRACT_INDEX_LIMIT = 1200;
const DOC_CHUNK_SIZE = 100;
const INITIAL_RESULT_LIMIT = 50;
const MAX_TERMS_PER_DOC = 140;
const MAX_EXPANSION_TERMS_PER_DOC = 12;
const SPARSE_EXPANSION_PATH = args.sparseExpansions || process.env.TQSEARCH_SPARSE_EXPANSIONS || "";
const MAX_SPARSE_EXPANSION_TERMS_PER_DOC = Number(args.sparseExpansionLimit || process.env.TQSEARCH_SPARSE_EXPANSION_LIMIT || 48);
const SPARSE_EXPANSION_SCALE = Number(args.sparseExpansionScale || process.env.TQSEARCH_SPARSE_EXPANSION_SCALE || 1);
const SPARSE_EXPANSION_MIN_WEIGHT = Number(args.sparseExpansionMinWeight || process.env.TQSEARCH_SPARSE_EXPANSION_MIN_WEIGHT || 0);
const MAX_PROXIMITY_TOKENS = 96;
const PROXIMITY_WINDOW = 5;
const MIN_TOKEN_LENGTH = 2;
const BM25F_K1 = 1.2;
const TITLE_SHINGLE_WEIGHT = 10;
const TITLE_PROXIMITY_WEIGHT = 3.5;
const POSTING_FLUSH_LINES = 100000;
const TERM_SHARD_FORMAT = "tqsbin-v3";
const TERM_SHARD_COMPRESSION = "gzip";
const TERM_SHARD_MAGIC = [0x54, 0x51, 0x53, 0x42]; // TQSB
const TERM_RANGE_FORMAT = "tqranges-v1";
const TERM_RANGE_MAGIC = [0x54, 0x51, 0x52, 0x47]; // TQRG
const POSTING_BLOCK_SIZE = 128;
const BASE_SHARD_DEPTH = 3;
const MAX_SHARD_DEPTH = 5;
const TARGET_SHARD_POSTINGS = 30000;
const TERM_PACK_TARGET_BYTES = Number(args.termPackBytes || process.env.TQSEARCH_TERM_PACK_BYTES || 4 * 1024 * 1024);
const TYPO_FORMAT = "tqtypo-bin-v2";
const TYPO_COMPRESSION = "gzip";
const TYPO_SHARD_MAGIC = [0x54, 0x51, 0x54, 0x42]; // TQTB
const TYPO_MIN_TERM_LENGTH = 5;
const TYPO_MIN_SURFACE_LENGTH = 4;
const TYPO_MAX_SURFACE_LENGTH = 24;
const TYPO_MAX_TERM_LENGTH = 20;
const TYPO_MIN_DF = 1;
const TYPO_MAX_DF_RATIO = 0.08;
const TYPO_MAX_EDITS = 2;
const TYPO_BASE_SHARD_DEPTH = 2;
const TYPO_MAX_SHARD_DEPTH = Number(args.typoMaxShardDepth || process.env.TQSEARCH_TYPO_MAX_SHARD_DEPTH || 3);
const TYPO_TARGET_SHARD_CANDIDATES = Number(args.typoTargetShardCandidates || process.env.TQSEARCH_TYPO_TARGET_SHARD_CANDIDATES || 12000);
const TYPO_PACK_TARGET_BYTES = Number(args.typoPackBytes || process.env.TQSEARCH_TYPO_PACK_BYTES || 4 * 1024 * 1024);
const TYPO_MAX_CANDIDATES_PER_DELETE = 32;
const TYPO_FLUSH_LINES = 200000;
const TYPO_SURFACE_SEPARATOR = "\u0001";
const CODE_FORMAT = "tqcodes-v1";
const CODE_COMPRESSION = "gzip";
const CODE_MAGIC = [0x54, 0x51, 0x43, 0x42]; // TQCB
const CODE_FIELDS = ["source", "discipline", "type", "decade", "year"];
const BLOCK_FILTER_CONFIG = [
  { name: "source", kind: "facet", codeField: "source" },
  { name: "discipline", kind: "facet", codeField: "discipline" },
  { name: "type", kind: "facet", codeField: "type" },
  { name: "year", kind: "number", codeField: "year" },
];
const textEncoder = new TextEncoder();

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith("--sparse-expansions=")) out.sparseExpansions = arg.slice("--sparse-expansions=".length);
    else if (arg.startsWith("--sparse-expansion-limit=")) out.sparseExpansionLimit = arg.slice("--sparse-expansion-limit=".length);
    else if (arg.startsWith("--sparse-expansion-scale=")) out.sparseExpansionScale = arg.slice("--sparse-expansion-scale=".length);
    else if (arg.startsWith("--sparse-expansion-min-weight=")) out.sparseExpansionMinWeight = arg.slice("--sparse-expansion-min-weight=".length);
    else if (arg.startsWith("--term-pack-bytes=")) out.termPackBytes = arg.slice("--term-pack-bytes=".length);
    else if (arg.startsWith("--typo-max-shard-depth=")) out.typoMaxShardDepth = arg.slice("--typo-max-shard-depth=".length);
    else if (arg.startsWith("--typo-target-shard-candidates=")) out.typoTargetShardCandidates = arg.slice("--typo-target-shard-candidates=".length);
    else if (arg.startsWith("--typo-pack-bytes=")) out.typoPackBytes = arg.slice("--typo-pack-bytes=".length);
  }
  return out;
}

const FIELDS = [
  { name: "title", weight: 4.5, b: 0.55, get: r => r.title },
  { name: "authors", weight: 3.0, b: 0.0, get: r => r.authors },
  { name: "advisors", weight: 2.4, b: 0.0, get: r => r.advisors },
  { name: "subjects", weight: 2.2, b: 0.35, get: r => r.subjects },
  { name: "discipline", weight: 1.8, b: 0.0, get: r => r.discipline },
  { name: "abstract", weight: 1.0, b: 0.75, get: r => indexAbstract(r) },
  { name: "source", weight: 0.4, b: 0.0, get: r => r.source_name },
  { name: "year", weight: 1.2, b: 0.0, get: r => (r.year ? String(r.year) : "") },
];

const STOPWORDS = new Set([
  "a", "au", "aux", "avec", "ce", "ces", "dans", "de", "des", "du", "elle", "en",
  "et", "eux", "il", "ils", "je", "la", "le", "les", "leur", "leurs", "lui", "ma",
  "mais", "me", "mes", "moi", "mon", "ne", "nos", "notre", "nous", "ou", "par",
  "pas", "pour", "qu", "que", "qui", "sa", "se", "ses", "son", "sur", "ta", "te",
  "tes", "toi", "ton", "tu", "un", "une", "vos", "votre", "vous", "the", "and",
  "for", "with", "from", "that", "this", "these", "those", "into", "onto", "over",
  "under", "between", "within", "without", "about", "after", "before", "than", "then",
  "are", "was", "were", "been", "being", "have", "has", "had", "not", "all", "any",
  "can", "could", "should", "would",
]);

if (!existsSync(DB_PATH)) {
  console.log(`▸ ${DB_PATH} missing — fetching latest release`);
  execSync("node scripts/fetch_db.mjs", { stdio: "inherit", cwd: ROOT });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(DOCS_OUT, { recursive: true });
mkdirSync(TERMS_OUT, { recursive: true });
mkdirSync(RUNS_OUT, { recursive: true });
mkdirSync(TYPO_RUNS_OUT, { recursive: true });

function fold(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .toLowerCase();
}

function stem(token) {
  if (token.length < 5 || /^\d+$/.test(token)) return token;
  return token
    .replace(/(ements|ement|ations|ation|iques|ique|ances|ance|ities|ity|ments|ment)$/u, "")
    .replace(/(issements|issement)$/u, "iss")
    .replace(/(euses|euse|eurs|eur|ives|ive|ifs|if)$/u, "")
    .replace(/(ies|ied|ing|ers|er|ed|es|s)$/u, "");
}

function tokenize(text) {
  const out = [];
  for (const raw of fold(text).split(/[^a-z0-9]+/u)) {
    if ((raw.length < MIN_TOKEN_LENGTH && !/^\d$/.test(raw)) || STOPWORDS.has(raw)) continue;
    const tok = stem(raw);
    if ((tok.length >= MIN_TOKEN_LENGTH || /^\d$/.test(tok)) && !STOPWORDS.has(tok)) out.push(tok);
  }
  return out;
}

function surfaceStemPairs(text) {
  const pairs = new Map();
  for (const raw of fold(text).split(/[^a-z0-9]+/u)) {
    if ((raw.length < MIN_TOKEN_LENGTH && !/^\d$/.test(raw)) || STOPWORDS.has(raw)) continue;
    const tok = stem(raw);
    if ((tok.length >= MIN_TOKEN_LENGTH || /^\d$/.test(tok)) && !STOPWORDS.has(tok)) {
      pairs.set(raw, tok);
    }
  }
  return pairs;
}

function termCounts(text) {
  const counts = new Map();
  for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) || 0) + 1);
  return counts;
}

function addBm25fField(text, field, avgLens, weightedTf) {
  if (!text) return;
  const counts = termCounts(text);
  if (!counts.size) return;
  const len = [...counts.values()].reduce((sum, tf) => sum + tf, 0);
  const avgLen = avgLens[field.name] || 1;
  const norm = (1 - field.b) + field.b * (len / avgLen);
  const scale = field.weight / Math.max(norm, 0.01);
  for (const [tok, tf] of counts) {
    weightedTf.set(tok, (weightedTf.get(tok) || 0) + tf * scale);
  }
}

function bm25fScores(weightedTf) {
  const scores = new Map();
  for (const [tok, tf] of weightedTf) {
    scores.set(tok, ((BM25F_K1 + 1) * tf) / (BM25F_K1 + tf));
  }
  return scores;
}

function addWeightedTerm(scores, term, weight) {
  if (!term || weight <= 0) return;
  scores.set(term, (scores.get(term) || 0) + weight);
}

function addShingles(text, weight, scores, maxTokens = Infinity, prefix = "") {
  const tokens = tokenize(text).slice(0, maxTokens);
  for (const n of [2, 3]) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const term = `${prefix}${tokens.slice(i, i + n).join("_")}`;
      addWeightedTerm(scores, term, weight);
    }
  }
}

function proximityTerm(left, right) {
  if (!left || !right || left === right) return "";
  const [a, b] = left < right ? [left, right] : [right, left];
  return `n_${a}_${b}`;
}

function addProximityPairs(text, weight, scores, maxTokens = MAX_PROXIMITY_TOKENS) {
  const tokens = tokenize(text).slice(0, maxTokens);
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const end = Math.min(tokens.length, i + PROXIMITY_WINDOW + 1);
    for (let j = i + 1; j < end; j++) {
      const term = proximityTerm(tokens[i], tokens[j]);
      if (!term || seen.has(term)) continue;
      seen.add(term);
      addWeightedTerm(scores, term, weight / Math.max(1, j - i));
    }
  }
}

function addExpansionSignals(r, scores) {
  addProximityPairs(r.title, TITLE_PROXIMITY_WEIGHT, scores, MAX_PROXIMITY_TOKENS);
}

function topEntries(scores, limit) {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function selectDocTerms(baseScores, expansionScores) {
  const selected = new Map(topEntries(baseScores, MAX_TERMS_PER_DOC));
  for (const [term, score] of topEntries(expansionScores, MAX_EXPANSION_TERMS_PER_DOC)) {
    selected.set(term, Math.max(selected.get(term) || 0, score));
  }
  return [...selected.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function normalizeSparseExpansionTerm(rawTerm) {
  const tokens = tokenize(String(rawTerm || "").replace(/_/g, " "));
  if (!tokens.length) return "";
  return tokens.slice(0, 3).join("_");
}

function sparseTermWeight(item) {
  if (typeof item === "string") return 1;
  if (!item || typeof item !== "object") return 0;
  const value = item.weight ?? item.score ?? item.impact ?? item.value ?? 1;
  const weight = Number(value);
  return Number.isFinite(weight) ? weight : 0;
}

function sparseTermText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.term ?? item.token ?? item.text ?? item.query ?? "";
}

function sparseTermEntries(record) {
  const raw = record.terms ?? record.expansions ?? record.sparse_terms ?? record.tokens ?? [];
  if (Array.isArray(raw)) {
    return raw.map(item => [sparseTermText(item), sparseTermWeight(item)]);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([term, weight]) => [term, Number(weight)]);
  }
  return [];
}

function sparseDocIndex(record, lookup, total) {
  for (const key of ["doc", "docIndex", "doc_index", "index"]) {
    const value = Number(record[key]);
    if (Number.isInteger(value) && value >= 0 && value < total) return value;
  }
  for (const key of ["id", "rowid", "doc_id", "oai_identifier", "url"]) {
    const value = record[key];
    if (value == null) continue;
    const found = lookup.get(String(value));
    if (found != null) return found;
  }
  return null;
}

function sparseExpansionDisabledStats() {
  return {
    enabled: false,
    records: 0,
    indexed_records: 0,
    terms_read: 0,
    terms_indexed: 0,
    missing_docs: 0,
    malformed_lines: 0,
  };
}

async function applySparseExpansionFile(config, postingBuffer, shardNames, docLookup, total) {
  if (!config.path) return sparseExpansionDisabledStats();
  if (!existsSync(config.path)) throw new Error(`Sparse expansion file not found: ${config.path}`);

  console.log(`▸ Applying sparse expansion terms from ${config.path}`);
  const stats = {
    enabled: true,
    file: basename(config.path),
    max_terms_per_doc: config.maxTermsPerDoc,
    scale: config.scale,
    min_weight: config.minWeight,
    records: 0,
    indexed_records: 0,
    terms_read: 0,
    terms_indexed: 0,
    missing_docs: 0,
    malformed_lines: 0,
  };
  const rl = createInterface({ input: createReadStream(config.path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      stats.malformed_lines++;
      continue;
    }
    stats.records++;
    const docIndex = sparseDocIndex(record, docLookup, total);
    if (docIndex == null) {
      stats.missing_docs++;
      continue;
    }

    const terms = new Map();
    for (const [rawTerm, rawWeight] of sparseTermEntries(record)) {
      stats.terms_read++;
      const weight = Number(rawWeight);
      if (!Number.isFinite(weight) || weight <= config.minWeight) continue;
      const term = normalizeSparseExpansionTerm(rawTerm);
      if (!term) continue;
      terms.set(term, Math.max(terms.get(term) || 0, weight * config.scale));
    }

    let indexed = 0;
    for (const [term, score] of topEntries(terms, config.maxTermsPerDoc)) {
      bufferPosting(postingBuffer, shardNames, term, docIndex, score);
      indexed++;
    }
    if (indexed) {
      stats.indexed_records++;
      stats.terms_indexed += indexed;
    }
  }
  console.log(`  ${stats.terms_indexed.toLocaleString()} expansion terms indexed from ${stats.indexed_records.toLocaleString()} records`);
  return stats;
}

function recordUrl(r) {
  if (r.url) return r.url;
  return `urn:tq:${encodeURIComponent(r.oai_identifier)}`;
}

function truncatedAbstract(r) {
  if (!r.abstract) return "";
  return r.abstract.length > ABSTRACT_DISPLAY_LIMIT
    ? r.abstract.slice(0, ABSTRACT_DISPLAY_LIMIT) + "…"
    : r.abstract;
}

function indexAbstract(r) {
  if (!r.abstract) return "";
  return r.abstract.length > ABSTRACT_INDEX_LIMIT
    ? r.abstract.slice(0, ABSTRACT_INDEX_LIMIT)
    : r.abstract;
}

function decadeOf(year) {
  return year ? `${Math.floor(year / 10) * 10}s` : null;
}

function asKey(value) {
  return value || "";
}

function addDict(dict, value, label = value) {
  const key = asKey(value);
  if (!dict.ids.has(key)) {
    dict.ids.set(key, dict.values.length);
    dict.values.push({ value: key, label: label || key, n: 0 });
  }
  const idx = dict.ids.get(key);
  dict.values[idx].n++;
  return idx;
}

function facetRows(dict, chronological = false) {
  const rows = dict.values
    .filter(v => v.value)
    .map(v => ({ value: v.value, label: v.label, n: v.n }));
  if (chronological) return rows.sort((a, b) => a.value.localeCompare(b.value));
  return rows.sort((a, b) => b.n - a.n);
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

function shardKey(term, depth = BASE_SHARD_DEPTH) {
  return String(term || "").slice(0, depth).padEnd(depth, "_");
}

function shardFor(term) {
  return shardKey(term, BASE_SHARD_DEPTH);
}

const SELECT_ROWS = `SELECT
     rowid AS id,
     oai_identifier, title, authors, advisors, abstract, subjects,
     year, type, source_id, source_name, discipline, language, url
   FROM theses
   ORDER BY rowid`;

function measureAvgLens(db, total) {
  console.log("▸ Measuring BM25F field lengths");
  const fieldTotals = Object.fromEntries(FIELDS.map(f => [f.name, 0]));
  let seen = 0;
  for (const r of db.prepare(SELECT_ROWS).iterate()) {
    for (const field of FIELDS) fieldTotals[field.name] += tokenize(field.get(r)).length;
    seen++;
    if (seen % 50000 === 0) {
      console.log(`  ... measured ${seen.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }
  return Object.fromEntries(FIELDS.map(field => [
    field.name,
    Math.max(1, fieldTotals[field.name] / Math.max(1, total)),
  ]));
}

function writeDocChunk(chunk, chunkIndex) {
  if (!chunk.length) return;
  writeFileSync(
    resolve(DOCS_OUT, `${String(chunkIndex).padStart(4, "0")}.json`),
    JSON.stringify(chunk),
  );
}

function flushPostingBuffer(buffer) {
  for (const [shard, lines] of buffer.byShard) {
    if (!lines.length) continue;
    appendFileSync(resolve(RUNS_OUT, `${shard}.tsv`), lines.join(""));
  }
  buffer.byShard.clear();
  buffer.lines = 0;
}

function bufferPosting(buffer, shardNames, term, docIndex, score) {
  const shard = shardFor(term);
  if (!buffer.byShard.has(shard)) buffer.byShard.set(shard, []);
  buffer.byShard.get(shard).push(`${term}\t${docIndex}\t${Math.max(1, Math.round(score * 1000))}\n`);
  shardNames.add(shard);
  buffer.lines++;
  if (buffer.lines >= POSTING_FLUSH_LINES) flushPostingBuffer(buffer);
}

async function buildPostingRuns(db, total, avgLens) {
  const dicts = {
    source: { ids: new Map(), values: [] },
    discipline: { ids: new Map(), values: [] },
    type: { ids: new Map(), values: [] },
    decade: { ids: new Map(), values: [] },
  };
  const codes = {
    source: new Array(total),
    discipline: new Array(total),
    type: new Array(total),
    decade: new Array(total),
    year: new Array(total),
  };
  const initialResults = [];
  const shardNames = new Set();
  const postingBuffer = { byShard: new Map(), lines: 0 };
  const surfaceTypoBuffer = { byShard: new Map(), lines: 0, terms: 0, deletePairs: 0, shards: new Set() };
  const docLookup = new Map();
  const sparseExpansionConfig = {
    path: SPARSE_EXPANSION_PATH ? resolve(ROOT, SPARSE_EXPANSION_PATH) : "",
    maxTermsPerDoc: Math.max(0, MAX_SPARSE_EXPANSION_TERMS_PER_DOC),
    scale: Number.isFinite(SPARSE_EXPANSION_SCALE) ? SPARSE_EXPANSION_SCALE : 1,
    minWeight: Number.isFinite(SPARSE_EXPANSION_MIN_WEIGHT) ? SPARSE_EXPANSION_MIN_WEIGHT : 0,
  };
  let docChunk = [];
  let docChunkIndex = 0;
  let rawPostingCount = 0;

  console.log("▸ Streaming TQSearch documents and posting runs");
  const t0 = performance.now();
  let docIndex = 0;
  for (const r of db.prepare(SELECT_ROWS).iterate()) {
    if (sparseExpansionConfig.path) {
      docLookup.set(String(docIndex), docIndex);
      docLookup.set(String(r.id), docIndex);
      if (r.oai_identifier) docLookup.set(String(r.oai_identifier), docIndex);
      if (r.url) docLookup.set(String(r.url), docIndex);
    }

    const weightedTf = new Map();
    for (const field of FIELDS) addBm25fField(field.get(r), field, avgLens, weightedTf);
    const scores = bm25fScores(weightedTf);
    addShingles(r.title, TITLE_SHINGLE_WEIGHT, scores);
    const expansionScores = new Map();
    addExpansionSignals(r, expansionScores);

    const topTerms = selectDocTerms(scores, expansionScores);
    for (const [term, score] of topTerms) {
      bufferPosting(postingBuffer, shardNames, term, docIndex, score);
      rawPostingCount++;
    }
    addSurfaceTypoTerms(surfaceTypoBuffer, r);

    codes.source[docIndex] = addDict(dicts.source, r.source_id, r.source_name || r.source_id);
    codes.discipline[docIndex] = addDict(dicts.discipline, r.discipline);
    codes.type[docIndex] = addDict(dicts.type, r.type);
    codes.decade[docIndex] = addDict(dicts.decade, decadeOf(r.year));
    codes.year[docIndex] = r.year || 0;

    const result = rowResult(r);
    if (initialResults.length < INITIAL_RESULT_LIMIT) initialResults.push(result);
    docChunk.push(result);
    if (docChunk.length >= DOC_CHUNK_SIZE) {
      writeDocChunk(docChunk, docChunkIndex++);
      docChunk = [];
    }

    docIndex++;
    if (docIndex % 25000 === 0) {
      console.log(`  ... streamed ${docIndex.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  writeDocChunk(docChunk, docChunkIndex);
  const sparseExpansion = await applySparseExpansionFile(
    sparseExpansionConfig,
    postingBuffer,
    shardNames,
    docLookup,
    total,
  );
  rawPostingCount += sparseExpansion.terms_indexed || 0;
  flushPostingBuffer(postingBuffer);
  flushTypoBuffer(surfaceTypoBuffer);
  console.log(`  ${rawPostingCount.toLocaleString()} raw postings written in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  return {
    dicts,
    codes,
    initialResults,
    shardNames: [...shardNames].sort(),
    sparseExpansion,
    surfaceTypo: {
      terms: surfaceTypoBuffer.terms,
      deletePairs: surfaceTypoBuffer.deletePairs,
      shards: [...surfaceTypoBuffer.shards].sort(),
    },
  };
}

function pushVarint(out, value) {
  let n = Math.max(0, Math.floor(value));
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function hasBit(words, value) {
  const word = Math.floor(value / 32);
  const bit = value % 32;
  return Math.floor((words[word] || 0) / (2 ** bit)) % 2 === 1;
}

function addBit(words, value) {
  if (value < 0) return;
  const word = Math.floor(value / 32);
  const bit = value % 32;
  if (!hasBit(words, value)) words[word] += 2 ** bit;
}

function emptyBlockFilters(blockFilters) {
  return blockFilters.map(filter => {
    if (filter.kind === "facet") return { words: new Array(filter.words).fill(0) };
    return { min: 0, max: 0 };
  });
}

function updateBlockFilters(summary, blockFilters, codes, doc) {
  for (let i = 0; i < blockFilters.length; i++) {
    const filter = blockFilters[i];
    const value = codes[filter.code_field || filter.codeField][doc] || 0;
    if (filter.kind === "facet") {
      addBit(summary[i].words, value);
    } else if (value) {
      summary[i].min = summary[i].min ? Math.min(summary[i].min, value) : value;
      summary[i].max = Math.max(summary[i].max, value);
    }
  }
}

function buildBlockFilterDefs(dicts) {
  return BLOCK_FILTER_CONFIG.map(filter => {
    if (filter.kind === "facet") {
      const cardinality = dicts[filter.codeField]?.values?.length || 0;
      return {
        name: filter.name,
        kind: filter.kind,
        code_field: filter.codeField,
        cardinality,
        words: Math.max(1, Math.ceil(cardinality / 32)),
      };
    }
    return {
      name: filter.name,
      kind: filter.kind,
      code_field: filter.codeField,
    };
  });
}

function encodePostings(rows, total, codes, blockFilters) {
  const df = rows.length;
  const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
  const encoded = rows
    .map(([doc, score]) => [doc, Math.max(1, Math.round(score * idf / 10))])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const bytes = [];
  const blocks = [];
  for (let i = 0; i < encoded.length; i++) {
    const [doc, impact] = encoded[i];
    if (i % POSTING_BLOCK_SIZE === 0) {
      blocks.push({ offset: bytes.length, maxImpact: impact, filters: emptyBlockFilters(blockFilters) });
    }
    updateBlockFilters(blocks[blocks.length - 1].filters, blockFilters, codes, doc);
    pushVarint(bytes, doc);
    pushVarint(bytes, impact);
  }
  return { df, count: encoded.length, bytes: Uint8Array.from(bytes), blocks };
}

function buildTermShard(entries, total, codes, blockFilters) {
  const directory = [];
  const postingChunks = [];
  let postingOffset = 0;

  for (const [term, rows] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    const postings = encodePostings(rows, total, codes, blockFilters);
    const termBytes = textEncoder.encode(term);
    directory.push({
      termBytes,
      df: postings.df,
      count: postings.count,
      offset: postingOffset,
      byteLength: postings.bytes.length,
      blocks: postings.blocks,
    });
    postingChunks.push(postings.bytes);
    postingOffset += postings.bytes.length;
  }

  const header = [...TERM_SHARD_MAGIC];
  pushVarint(header, directory.length);
  for (const entry of directory) {
    pushVarint(header, entry.termBytes.length);
    for (const b of entry.termBytes) header.push(b);
    pushVarint(header, entry.df);
    pushVarint(header, entry.count);
    pushVarint(header, entry.offset);
    pushVarint(header, entry.byteLength);
    pushVarint(header, POSTING_BLOCK_SIZE);
    pushVarint(header, entry.blocks.length);
    for (const block of entry.blocks) {
      pushVarint(header, block.offset);
      pushVarint(header, block.maxImpact);
      for (let i = 0; i < blockFilters.length; i++) {
        const filter = blockFilters[i];
        const summary = block.filters[i];
        if (filter.kind === "facet") {
          for (const word of summary.words) pushVarint(header, word);
        } else {
          pushVarint(header, summary.min);
          pushVarint(header, summary.max);
        }
      }
    }
  }

  return Buffer.concat([
    Buffer.from(Uint8Array.from(header)),
    ...postingChunks.map(chunk => Buffer.from(chunk)),
  ]);
}

function entryPostingCount(entries) {
  return entries.reduce((sum, [, rows]) => sum + rows.length, 0);
}

function partitionTermEntries(entries, depth = BASE_SHARD_DEPTH) {
  if (!entries.length) return [];
  if (entryPostingCount(entries) <= TARGET_SHARD_POSTINGS || depth >= MAX_SHARD_DEPTH) {
    return [{ name: shardKey(entries[0][0], depth), entries }];
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = shardKey(entry[0], depth + 1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, group]) => partitionTermEntries(group, depth + 1));
}

function typoShardKey(deleteKey, depth = TYPO_BASE_SHARD_DEPTH) {
  return String(deleteKey || "").slice(0, depth).padEnd(depth, "_");
}

function typoMaxEditsFor(term) {
  if (term.length >= 8) return TYPO_MAX_EDITS;
  return 1;
}

function isTypoIndexTerm(term, df, total) {
  if (term.length < TYPO_MIN_TERM_LENGTH || term.length > TYPO_MAX_TERM_LENGTH) return false;
  if (df < TYPO_MIN_DF || df > Math.max(TYPO_MIN_DF, Math.floor(total * TYPO_MAX_DF_RATIO))) return false;
  if (term.includes("_") || term.startsWith("n_")) return false;
  if (!/^[a-z][a-z0-9]*$/u.test(term)) return false;
  if (/^\d+$/u.test(term)) return false;
  return true;
}

function isTypoSurfaceTerm(surface, candidate) {
  if (surface.length < TYPO_MIN_SURFACE_LENGTH || surface.length > TYPO_MAX_SURFACE_LENGTH) return false;
  if (candidate.length < MIN_TOKEN_LENGTH || candidate.length > TYPO_MAX_TERM_LENGTH) return false;
  if (candidate.includes("_") || candidate.startsWith("n_")) return false;
  if (!/^[a-z][a-z0-9]*$/u.test(surface)) return false;
  if (!/^[a-z][a-z0-9]*$/u.test(candidate)) return false;
  if (/^\d+$/u.test(surface) || /^\d+$/u.test(candidate)) return false;
  return true;
}

function typoDeleteKeys(term, maxEdits = typoMaxEditsFor(term)) {
  const keys = new Set([term]);
  let frontier = new Set([term]);
  for (let edits = 1; edits <= maxEdits; edits++) {
    const next = new Set();
    for (const value of frontier) {
      if (value.length <= 1) continue;
      for (let i = 0; i < value.length; i++) {
        const key = value.slice(0, i) + value.slice(i + 1);
        if (key.length < TYPO_MIN_TERM_LENGTH - TYPO_MAX_EDITS) continue;
        keys.add(key);
        next.add(key);
      }
    }
    frontier = next;
  }
  return keys;
}

function flushTypoBuffer(buffer) {
  for (const [shard, lines] of buffer.byShard) {
    if (!lines.length) continue;
    appendFileSync(resolve(TYPO_RUNS_OUT, `${shard}.tsv`), lines.join(""));
  }
  buffer.byShard.clear();
  buffer.lines = 0;
}

function bufferTypoCandidate(buffer, deleteKey, term, df) {
  const shard = typoShardKey(deleteKey);
  if (!buffer.byShard.has(shard)) buffer.byShard.set(shard, []);
  buffer.byShard.get(shard).push(`${deleteKey}\t${term}\t${df}\n`);
  buffer.shards.add(shard);
  buffer.lines++;
  buffer.deletePairs++;
  if (buffer.lines >= TYPO_FLUSH_LINES) flushTypoBuffer(buffer);
}

function bufferTypoTerm(buffer, term, df) {
  buffer.terms++;
  for (const deleteKey of typoDeleteKeys(term)) {
    bufferTypoCandidate(buffer, deleteKey, term, df);
  }
}

function bufferTypoSurfaceTerm(buffer, surface, candidate) {
  if (!isTypoSurfaceTerm(surface, candidate)) return;
  buffer.terms++;
  const surfaceCandidate = `${surface}${TYPO_SURFACE_SEPARATOR}${candidate}`;
  for (const deleteKey of typoDeleteKeys(surface, typoMaxEditsFor(surface))) {
    bufferTypoCandidate(buffer, deleteKey, surfaceCandidate, 1);
  }
}

function parseTypoCandidateText(raw) {
  const text = String(raw || "");
  const idx = text.indexOf(TYPO_SURFACE_SEPARATOR);
  if (idx < 0) return { surface: text, term: text };
  return {
    surface: text.slice(0, idx),
    term: text.slice(idx + TYPO_SURFACE_SEPARATOR.length),
  };
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let i = 0;
  while (i < max && left[i] === right[i]) i++;
  return i;
}

function pushUtf8(out, value) {
  const bytes = textEncoder.encode(value);
  pushVarint(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

function buildTypoShard(byDelete) {
  const pairStats = new Map();
  const selectedByDelete = [];
  const deleteEntries = [...byDelete.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [deleteKey, candidates] of deleteEntries) {
    const byPair = new Map();
    for (const [raw, df] of candidates) {
      const candidate = parseTypoCandidateText(raw);
      if (!candidate.surface || !candidate.term) continue;
      const pairKey = `${candidate.surface}${TYPO_SURFACE_SEPARATOR}${candidate.term}`;
      const existing = byPair.get(pairKey);
      if (!existing || df > existing.df) byPair.set(pairKey, { ...candidate, pairKey, df });
    }
    const selected = [...byPair.values()]
      .sort((a, b) =>
        b.df - a.df
        || a.surface.length - b.surface.length
        || a.term.length - b.term.length
        || a.surface.localeCompare(b.surface)
        || a.term.localeCompare(b.term))
      .slice(0, TYPO_MAX_CANDIDATES_PER_DELETE);
    if (!selected.length) continue;
    selectedByDelete.push({ deleteKey, selected });
    for (const candidate of selected) {
      const stat = pairStats.get(candidate.pairKey) || {
        surface: candidate.surface,
        term: candidate.term,
        df: 0,
        uses: 0,
      };
      stat.df = Math.max(stat.df, candidate.df);
      stat.uses++;
      pairStats.set(candidate.pairKey, stat);
    }
  }

  const pairs = [...pairStats.entries()]
    .sort((a, b) =>
      b[1].uses - a[1].uses
      || b[1].df - a[1].df
      || a[1].surface.localeCompare(b[1].surface)
      || a[1].term.localeCompare(b[1].term));
  const pairIds = new Map(pairs.map(([pairKey], id) => [pairKey, id]));
  const directory = [];
  const candidateBytes = [];
  let previousKey = "";
  let emittedCandidates = 0;

  for (const { deleteKey, selected } of selectedByDelete) {
    const offset = candidateBytes.length;
    for (const candidate of selected) {
      pushVarint(candidateBytes, pairIds.get(candidate.pairKey));
    }
    const prefix = commonPrefixLength(previousKey, deleteKey);
    directory.push({
      prefix,
      suffix: deleteKey.slice(prefix),
      offset,
      count: selected.length,
    });
    previousKey = deleteKey;
    emittedCandidates += selected.length;
  }

  const header = [...TYPO_SHARD_MAGIC];
  pushVarint(header, pairs.length);
  for (const [, pair] of pairs) {
    pushUtf8(header, pair.surface);
    pushUtf8(header, pair.term);
    pushVarint(header, pair.df);
  }
  pushVarint(header, directory.length);
  for (const entry of directory) {
    pushVarint(header, entry.prefix);
    pushUtf8(header, entry.suffix);
    pushVarint(header, entry.offset);
    pushVarint(header, entry.count);
  }

  return {
    buffer: Buffer.concat([
      Buffer.from(Uint8Array.from(header)),
      Buffer.from(Uint8Array.from(candidateBytes)),
    ]),
    stats: {
      deleteKeys: directory.length,
      emittedCandidates,
      pairVocab: pairs.length,
      candidateBytes: candidateBytes.length,
    },
  };
}

function typoEntryCandidateCount(entries) {
  return entries.reduce((sum, [, candidates]) =>
    sum + Math.min(TYPO_MAX_CANDIDATES_PER_DELETE, candidates.size), 0);
}

function partitionTypoEntries(entries, depth = TYPO_BASE_SHARD_DEPTH) {
  if (!entries.length) return [];
  if (typoEntryCandidateCount(entries) <= TYPO_TARGET_SHARD_CANDIDATES || depth >= TYPO_MAX_SHARD_DEPTH) {
    return [{ name: typoShardKey(entries[0][0], depth), entries }];
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = typoShardKey(entry[0], depth + 1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, group]) => partitionTypoEntries(group, depth + 1));
}

function addSurfaceTypoTerms(buffer, row) {
  const pairs = new Map();
  for (const field of FIELDS) {
    if (field.name === "abstract") continue;
    for (const [surface, candidate] of surfaceStemPairs(field.get(row))) {
      pairs.set(`${surface}\t${candidate}`, [surface, candidate]);
    }
  }
  for (const [surface, candidate] of pairs.values()) {
    bufferTypoSurfaceTerm(buffer, surface, candidate);
  }
}

function createPackWriter(outDir, targetBytes) {
  mkdirSync(outDir, { recursive: true });
  return {
    index: -1,
    file: "",
    path: "",
    offset: 0,
    bytes: 0,
    entries: {},
    packs: [],
    outDir,
    targetBytes,
  };
}

function openPack(writer) {
  writer.index++;
  writer.file = `${String(writer.index).padStart(4, "0")}.bin`;
  writer.path = resolve(writer.outDir, writer.file);
  writer.offset = 0;
  writer.packs.push({ file: writer.file, bytes: 0, shards: 0 });
  writeFileSync(writer.path, "");
}

function writePackedShard(writer, shard, compressed) {
  if (!writer.file || (writer.offset > 0 && writer.offset + compressed.length > writer.targetBytes)) {
    openPack(writer);
  }
  const offset = writer.offset;
  appendFileSync(writer.path, compressed);
  writer.entries[shard] = {
    pack: writer.file,
    offset,
    length: compressed.length,
  };
  writer.offset += compressed.length;
  writer.bytes += compressed.length;
  const pack = writer.packs[writer.packs.length - 1];
  pack.bytes += compressed.length;
  pack.shards++;
}

function createTermPackWriter() {
  return createPackWriter(TERM_PACKS_OUT, TERM_PACK_TARGET_BYTES);
}

function writeTermPackedShard(writer, shard, compressed) {
  writePackedShard(writer, shard, compressed);
}

function createTypoPackWriter() {
  return createPackWriter(TYPO_PACKS_OUT, TYPO_PACK_TARGET_BYTES);
}

function writeTypoPackedShard(writer, shard, compressed) {
  writePackedShard(writer, shard, compressed);
}

async function reduceTypoShard(shard, packWriter) {
  const path = resolve(TYPO_RUNS_OUT, `${shard}.tsv`);
  const byDelete = new Map();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [deleteKey, term, dfRaw] = line.split("\t");
    if (!deleteKey || !term) continue;
    if (!byDelete.has(deleteKey)) byDelete.set(deleteKey, new Map());
    const candidates = byDelete.get(deleteKey);
    candidates.set(term, (candidates.get(term) || 0) + (Number(dfRaw) || 0));
  }

  const partitions = partitionTypoEntries([...byDelete.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  const finalShards = [];
  let emittedCandidates = 0;
  let pairVocab = 0;
  let candidateBytes = 0;
  for (const partition of partitions) {
    const encoded = buildTypoShard(new Map(partition.entries));
    if (!encoded.stats.deleteKeys) continue;
    writeTypoPackedShard(packWriter, partition.name, gzipSync(encoded.buffer, { level: 9 }));
    finalShards.push(partition.name);
    emittedCandidates += encoded.stats.emittedCandidates;
    pairVocab += encoded.stats.pairVocab;
    candidateBytes += encoded.stats.candidateBytes;
  }
  unlinkSync(path);
  return {
    deleteKeys: byDelete.size,
    emittedCandidates,
    pairVocab,
    candidateBytes,
    shards: finalShards,
  };
}

async function reduceTypoRuns(buffer) {
  flushTypoBuffer(buffer);
  const packWriter = createTypoPackWriter();
  console.log("▸ Reducing typo-tolerance delete shards");
  const t0 = performance.now();
  let deleteKeys = 0;
  let emittedCandidates = 0;
  let pairVocab = 0;
  let candidateBytes = 0;
  const baseShards = [...buffer.shards].sort();
  const finalShardNames = new Set();
  for (let i = 0; i < baseShards.length; i++) {
    const stats = await reduceTypoShard(baseShards[i], packWriter);
    deleteKeys += stats.deleteKeys;
    emittedCandidates += stats.emittedCandidates;
    pairVocab += stats.pairVocab;
    candidateBytes += stats.candidateBytes;
    for (const shard of stats.shards) finalShardNames.add(shard);
    if ((i + 1) % 100 === 0 || i + 1 === baseShards.length) {
      console.log(`  ... reduced ${(i + 1).toLocaleString()} / ${baseShards.length.toLocaleString()} typo base shards`);
    }
  }
  const shards = [...finalShardNames].sort();
  const packIndexes = new Map(packWriter.packs.map((pack, index) => [pack.file, index]));
  const shardRanges = shards.map((shard) => {
    const entry = packWriter.entries[shard];
    return [packIndexes.get(entry.pack), entry.offset, entry.length];
  });

  const manifest = {
    version: 1,
    format: TYPO_FORMAT,
    compression: TYPO_COMPRESSION,
    min_term_length: TYPO_MIN_TERM_LENGTH,
    min_surface_length: TYPO_MIN_SURFACE_LENGTH,
    max_surface_length: TYPO_MAX_SURFACE_LENGTH,
    max_term_length: TYPO_MAX_TERM_LENGTH,
    min_df: TYPO_MIN_DF,
    max_df_ratio: TYPO_MAX_DF_RATIO,
    max_edits: TYPO_MAX_EDITS,
    base_shard_depth: TYPO_BASE_SHARD_DEPTH,
    max_shard_depth: TYPO_MAX_SHARD_DEPTH,
    target_shard_candidates: TYPO_TARGET_SHARD_CANDIDATES,
    max_candidates_per_delete: TYPO_MAX_CANDIDATES_PER_DELETE,
    storage: "range-pack-v1",
    pack_target_bytes: TYPO_PACK_TARGET_BYTES,
    shards,
    packs: packWriter.packs,
    shard_ranges: shardRanges,
    stats: {
      terms: buffer.terms,
      delete_pairs: buffer.deletePairs,
      delete_keys: deleteKeys,
      emitted_candidates: emittedCandidates,
      pair_vocab_entries: pairVocab,
      candidate_bytes: candidateBytes,
      pack_files: packWriter.packs.length,
      pack_bytes: packWriter.bytes,
      build_seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
    },
  };
  writeFileSync(resolve(TYPO_OUT, "manifest.json"), JSON.stringify(manifest));
  console.log(`  ${buffer.terms.toLocaleString()} typo terms, ${deleteKeys.toLocaleString()} delete keys into ${shards.length.toLocaleString()} shards / ${packWriter.packs.length.toLocaleString()} packs in ${manifest.stats.build_seconds.toFixed(1)}s`);
  return manifest;
}

function fixedWidth(values) {
  let max = 0;
  for (const value of values) {
    if (value > max) max = value;
  }
  if (max <= 0xff) return 1;
  if (max <= 0xffff) return 2;
  return 4;
}

function writeFixedInt(buffer, offset, width, value) {
  if (width === 1) {
    buffer[offset] = value;
  } else if (width === 2) {
    buffer.writeUInt16LE(value, offset);
  } else {
    buffer.writeUInt32LE(value, offset);
  }
}

function buildCodesFile(codes, total) {
  const header = [...CODE_MAGIC];
  const chunks = [];
  pushVarint(header, total);
  pushVarint(header, CODE_FIELDS.length);

  for (const field of CODE_FIELDS) {
    const values = codes[field];
    const width = fixedWidth(values);
    const nameBytes = textEncoder.encode(field);
    pushVarint(header, nameBytes.length);
    for (const b of nameBytes) header.push(b);
    header.push(width);

    const chunk = Buffer.alloc(total * width);
    for (let i = 0; i < total; i++) {
      writeFixedInt(chunk, i * width, width, values[i] || 0);
    }
    chunks.push(chunk);
  }

  return Buffer.concat([
    Buffer.from(Uint8Array.from(header)),
    ...chunks,
  ]);
}

function buildTermRangeFile(ranges) {
  const out = [...TERM_RANGE_MAGIC];
  pushVarint(out, ranges.length);
  for (const [packIndex, offset, length] of ranges) {
    pushVarint(out, packIndex);
    pushVarint(out, offset);
    pushVarint(out, length);
  }
  return Buffer.from(Uint8Array.from(out));
}

async function reduceShard(shard, total, codes, blockFilters, packWriter) {
  const path = resolve(RUNS_OUT, `${shard}.tsv`);
  const byTerm = new Map();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [term, docRaw, scoreRaw] = line.split("\t");
    if (!term) continue;
    if (!byTerm.has(term)) byTerm.set(term, new Map());
    const rows = byTerm.get(term);
    const doc = Number(docRaw);
    rows.set(doc, (rows.get(doc) || 0) + Number(scoreRaw));
  }

  const entries = [...byTerm.entries()].map(([term, rows]) => [term, [...rows.entries()]]);
  const typoTerms = [...byTerm.entries()]
    .filter(([term, rows]) => isTypoIndexTerm(term, rows.size, total))
    .map(([term, rows]) => [term, rows.size]);
  const partitions = partitionTermEntries(entries);
  const finalShards = [];
  let postings = 0;
  for (const rows of byTerm.values()) postings += rows.size;
  for (const partition of partitions) {
    const shardBuffer = buildTermShard(partition.entries, total, codes, blockFilters);
    writeTermPackedShard(packWriter, partition.name, gzipSync(shardBuffer, { level: 6 }));
    finalShards.push(partition.name);
  }
  unlinkSync(path);
  return { terms: byTerm.size, postings, shards: finalShards, typoTerms };
}

async function reducePostingRuns(total, shardNames, codes, blockFilters, surfaceTypo) {
  console.log("▸ Reducing posting runs into term shards");
  const t0 = performance.now();
  const termPackWriter = createTermPackWriter();
  let termCount = 0;
  let postingCount = 0;
  const finalShardNames = new Set();
  const typoBuffer = {
    byShard: new Map(),
    lines: 0,
    terms: surfaceTypo?.terms || 0,
    deletePairs: surfaceTypo?.deletePairs || 0,
    shards: new Set(surfaceTypo?.shards || []),
  };
  for (let i = 0; i < shardNames.length; i++) {
    const stats = await reduceShard(shardNames[i], total, codes, blockFilters, termPackWriter);
    termCount += stats.terms;
    postingCount += stats.postings;
    for (const shard of stats.shards) finalShardNames.add(shard);
    for (const [term, df] of stats.typoTerms) bufferTypoTerm(typoBuffer, term, df);
    if ((i + 1) % 1000 === 0 || i + 1 === shardNames.length) {
      console.log(`  ... reduced ${(i + 1).toLocaleString()} / ${shardNames.length.toLocaleString()} shards`);
    }
  }
  const finalShards = [...finalShardNames].sort();
  const termPackIndexes = new Map(termPackWriter.packs.map((pack, index) => [pack.file, index]));
  const termShardRanges = finalShards.map((shard) => {
    const entry = termPackWriter.entries[shard];
    return [termPackIndexes.get(entry.pack), entry.offset, entry.length];
  });
  writeFileSync(resolve(TERMS_OUT, "ranges.bin.gz"), gzipSync(buildTermRangeFile(termShardRanges), { level: 9 }));
  console.log(`  ${termCount.toLocaleString()} terms, ${postingCount.toLocaleString()} postings into ${finalShardNames.size.toLocaleString()} shards / ${termPackWriter.packs.length.toLocaleString()} packs in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const typo = await reduceTypoRuns(typoBuffer);
  return {
    termCount,
    postingCount,
    shardNames: finalShards,
    termPacks: termPackWriter.packs,
    termPackStats: {
      pack_files: termPackWriter.packs.length,
      pack_bytes: termPackWriter.bytes,
      pack_target_bytes: TERM_PACK_TARGET_BYTES,
    },
    typo,
  };
}

console.log(`▸ Reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
const total = db.prepare("SELECT COUNT(*) AS n FROM theses").get().n;
console.log(`  ${total.toLocaleString()} records available`);

const avgLens = measureAvgLens(db, total);
const { dicts, codes, initialResults, shardNames, sparseExpansion, surfaceTypo } = await buildPostingRuns(db, total, avgLens);
db.close();
const blockFilters = buildBlockFilterDefs(dicts);
const reduction = await reducePostingRuns(total, shardNames, codes, blockFilters, surfaceTypo);

const sources = facetRows(dicts.source);
const builtAt = new Date().toISOString();
const manifest = {
  version: 1,
  engine: "tqsearch",
  built_at: builtAt,
  total,
  doc_chunk_size: DOC_CHUNK_SIZE,
  initial_results: initialResults,
  facets: {
    discipline: facetRows(dicts.discipline),
    source: sources,
    decade: facetRows(dicts.decade, true),
  },
  dicts: {
    source: dicts.source.values,
    discipline: dicts.discipline.values,
    type: dicts.type.values,
    decade: dicts.decade.values,
  },
  block_filters: blockFilters,
  shards: reduction.shardNames,
  term_storage: "range-pack-v1",
  stats: {
    terms: reduction.termCount,
    postings: reduction.postingCount,
    max_terms_per_doc: MAX_TERMS_PER_DOC,
    max_expansion_terms_per_doc: MAX_EXPANSION_TERMS_PER_DOC,
    sparse_expansion: sparseExpansion,
    typo: {
      enabled: true,
      format: TYPO_FORMAT,
      compression: TYPO_COMPRESSION,
      storage: "range-pack-v1",
      min_term_length: TYPO_MIN_TERM_LENGTH,
      min_surface_length: TYPO_MIN_SURFACE_LENGTH,
      max_surface_length: TYPO_MAX_SURFACE_LENGTH,
      max_term_length: TYPO_MAX_TERM_LENGTH,
      max_edits: TYPO_MAX_EDITS,
      base_shard_depth: TYPO_BASE_SHARD_DEPTH,
      max_shard_depth: TYPO_MAX_SHARD_DEPTH,
      target_shard_candidates: TYPO_TARGET_SHARD_CANDIDATES,
      pack_target_bytes: TYPO_PACK_TARGET_BYTES,
      stats: reduction.typo.stats,
    },
    fields: FIELDS.map(({ name, weight, b }) => ({ name, weight, b })),
    proximity_window: PROXIMITY_WINDOW,
    max_proximity_tokens: MAX_PROXIMITY_TOKENS,
    abstract_display_limit: ABSTRACT_DISPLAY_LIMIT,
    abstract_index_limit: ABSTRACT_INDEX_LIMIT,
    scoring: "bm25f-title-norm-phrase-proximity-v2",
    builder: "file-backed-shard-runs-v1",
    term_shard_format: TERM_SHARD_FORMAT,
    term_shard_compression: TERM_SHARD_COMPRESSION,
    term_storage: "range-pack-v1",
    term_range_format: TERM_RANGE_FORMAT,
    term_pack_target_bytes: TERM_PACK_TARGET_BYTES,
    term_pack_files: reduction.termPackStats.pack_files,
    term_pack_bytes: reduction.termPackStats.pack_bytes,
    posting_block_size: POSTING_BLOCK_SIZE,
    term_base_shard_depth: BASE_SHARD_DEPTH,
    term_max_shard_depth: MAX_SHARD_DEPTH,
    term_target_shard_postings: TARGET_SHARD_POSTINGS,
    code_format: CODE_FORMAT,
    code_compression: CODE_COMPRESSION,
  },
};

writeFileSync(resolve(OUT, "manifest.json"), JSON.stringify(manifest));
writeFileSync(resolve(OUT, "codes.bin.gz"), gzipSync(buildCodesFile(codes, total), { level: 9 }));
rmSync(WORK_OUT, { recursive: true, force: true });

let outSize = "?";
try {
  outSize = execSync(`du -sh "${OUT}" | cut -f1`).toString().trim();
} catch {}
console.log(`✓ Built ${OUT}  (≈ ${outSize})`);
