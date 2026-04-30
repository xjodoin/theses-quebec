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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const OUT = resolve(ROOT, "dist/tqsearch");
const DOCS_OUT = resolve(OUT, "docs");
const TERMS_OUT = resolve(OUT, "terms");
const WORK_OUT = resolve(OUT, "_build");
const RUNS_OUT = resolve(WORK_OUT, "runs");

const ABSTRACT_DISPLAY_LIMIT = 900;
const ABSTRACT_INDEX_LIMIT = 1200;
const DOC_CHUNK_SIZE = 100;
const INITIAL_RESULT_LIMIT = 50;
const MAX_TERMS_PER_DOC = 140;
const MIN_TOKEN_LENGTH = 2;
const BM25F_K1 = 1.2;
const TITLE_SHINGLE_WEIGHT = 10;
const POSTING_FLUSH_LINES = 100000;
const TERM_SHARD_FORMAT = "tqsbin-v2";
const TERM_SHARD_COMPRESSION = "gzip";
const TERM_SHARD_MAGIC = [0x54, 0x51, 0x53, 0x42]; // TQSB
const POSTING_BLOCK_SIZE = 128;
const BASE_SHARD_DEPTH = 3;
const MAX_SHARD_DEPTH = 5;
const TARGET_SHARD_POSTINGS = 30000;
const CODE_FORMAT = "tqcodes-v1";
const CODE_COMPRESSION = "gzip";
const CODE_MAGIC = [0x54, 0x51, 0x43, 0x42]; // TQCB
const CODE_FIELDS = ["source", "discipline", "type", "decade", "year"];
const textEncoder = new TextEncoder();

const FIELDS = [
  { name: "title", weight: 4.5, b: 0.2, get: r => r.title },
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

function addShingles(text, weight, scores) {
  const tokens = tokenize(text);
  for (const n of [2, 3]) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const term = tokens.slice(i, i + n).join("_");
      scores.set(term, (scores.get(term) || 0) + weight);
    }
  }
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

function buildPostingRuns(db, total, avgLens) {
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
  let docChunk = [];
  let docChunkIndex = 0;
  let rawPostingCount = 0;

  console.log("▸ Streaming TQSearch documents and posting runs");
  const t0 = performance.now();
  let docIndex = 0;
  for (const r of db.prepare(SELECT_ROWS).iterate()) {
    const weightedTf = new Map();
    for (const field of FIELDS) addBm25fField(field.get(r), field, avgLens, weightedTf);
    const scores = bm25fScores(weightedTf);
    addShingles(r.title, TITLE_SHINGLE_WEIGHT, scores);

    const topTerms = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TERMS_PER_DOC);
    for (const [term, score] of topTerms) {
      bufferPosting(postingBuffer, shardNames, term, docIndex, score);
      rawPostingCount++;
    }

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
  flushPostingBuffer(postingBuffer);
  console.log(`  ${rawPostingCount.toLocaleString()} raw postings written in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

  return { dicts, codes, initialResults, shardNames: [...shardNames].sort() };
}

function pushVarint(out, value) {
  let n = Math.max(0, Math.floor(value));
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function encodePostings(rows, total) {
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
      blocks.push({ offset: bytes.length, maxImpact: impact });
    }
    pushVarint(bytes, doc);
    pushVarint(bytes, impact);
  }
  return { df, count: encoded.length, bytes: Uint8Array.from(bytes), blocks };
}

function buildTermShard(entries, total) {
  const directory = [];
  const postingChunks = [];
  let postingOffset = 0;

  for (const [term, rows] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    const postings = encodePostings(rows, total);
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

async function reduceShard(shard, total) {
  const path = resolve(RUNS_OUT, `${shard}.tsv`);
  const byTerm = new Map();
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [term, docRaw, scoreRaw] = line.split("\t");
    if (!term) continue;
    if (!byTerm.has(term)) byTerm.set(term, []);
    byTerm.get(term).push([Number(docRaw), Number(scoreRaw)]);
  }

  const entries = [...byTerm.entries()];
  const partitions = partitionTermEntries(entries);
  const finalShards = [];
  let postings = 0;
  for (const rows of byTerm.values()) postings += rows.length;
  for (const partition of partitions) {
    const shardBuffer = buildTermShard(partition.entries, total);
    writeFileSync(
      resolve(TERMS_OUT, `${partition.name}.bin.gz`),
      gzipSync(shardBuffer, { level: 6 }),
    );
    finalShards.push(partition.name);
  }
  unlinkSync(path);
  return { terms: byTerm.size, postings, shards: finalShards };
}

async function reducePostingRuns(total, shardNames) {
  console.log("▸ Reducing posting runs into term shards");
  const t0 = performance.now();
  let termCount = 0;
  let postingCount = 0;
  const finalShardNames = new Set();
  for (let i = 0; i < shardNames.length; i++) {
    const stats = await reduceShard(shardNames[i], total);
    termCount += stats.terms;
    postingCount += stats.postings;
    for (const shard of stats.shards) finalShardNames.add(shard);
    if ((i + 1) % 1000 === 0 || i + 1 === shardNames.length) {
      console.log(`  ... reduced ${(i + 1).toLocaleString()} / ${shardNames.length.toLocaleString()} shards`);
    }
  }
  console.log(`  ${termCount.toLocaleString()} terms, ${postingCount.toLocaleString()} postings into ${finalShardNames.size.toLocaleString()} shards in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return { termCount, postingCount, shardNames: [...finalShardNames].sort() };
}

console.log(`▸ Reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
const total = db.prepare("SELECT COUNT(*) AS n FROM theses").get().n;
console.log(`  ${total.toLocaleString()} records available`);

const avgLens = measureAvgLens(db, total);
const { dicts, codes, initialResults, shardNames } = buildPostingRuns(db, total, avgLens);
db.close();
const reduction = await reducePostingRuns(total, shardNames);

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
  shards: reduction.shardNames,
  stats: {
    terms: reduction.termCount,
    postings: reduction.postingCount,
    max_terms_per_doc: MAX_TERMS_PER_DOC,
    abstract_display_limit: ABSTRACT_DISPLAY_LIMIT,
    abstract_index_limit: ABSTRACT_INDEX_LIMIT,
    scoring: "bm25f-impact-v1",
    builder: "file-backed-shard-runs-v1",
    term_shard_format: TERM_SHARD_FORMAT,
    term_shard_compression: TERM_SHARD_COMPRESSION,
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
