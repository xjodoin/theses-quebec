#!/usr/bin/env node
/**
 * Build a static, impact-scored search index for the theses corpus.
 *
 * This is a prototype alternative to Pagefind for this dataset. The index is
 * designed around the UI's real access pattern: return one page of top results
 * plus facet counts, without requiring a full Pagefind result enumeration.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(ROOT, "data/theses.db");
const OUT = resolve(ROOT, "dist/tqsearch");
const DOCS_OUT = resolve(OUT, "docs");
const TERMS_OUT = resolve(OUT, "terms");

const ABSTRACT_LIMIT = 900;
const DOC_CHUNK_SIZE = 1000;
const INITIAL_RESULT_LIMIT = 50;
const MAX_TERMS_PER_DOC = 140;
const MIN_TOKEN_LENGTH = 2;

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

function addWeighted(text, weight, scores) {
  if (!text) return;
  const counts = new Map();
  for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) || 0) + 1);
  for (const [tok, tf] of counts) {
    scores.set(tok, (scores.get(tok) || 0) + weight * (1 + Math.log(tf)));
  }
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
  return r.abstract.length > ABSTRACT_LIMIT
    ? r.abstract.slice(0, ABSTRACT_LIMIT) + "…"
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

function shardFor(term) {
  if (!term) return "__";
  return `${term[0] || "_"}${term[1] || "_"}`;
}

console.log(`▸ Reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(
  `SELECT
     rowid AS id,
     oai_identifier, title, authors, advisors, abstract, subjects,
     year, type, source_id, source_name, discipline, language, url
   FROM theses
   ORDER BY rowid`,
).all();
db.close();
console.log(`  ${rows.length.toLocaleString()} records loaded`);

const dicts = {
  source: { ids: new Map(), values: [] },
  discipline: { ids: new Map(), values: [] },
  type: { ids: new Map(), values: [] },
  decade: { ids: new Map(), values: [] },
};

const codes = {
  source: new Array(rows.length),
  discipline: new Array(rows.length),
  type: new Array(rows.length),
  decade: new Array(rows.length),
  year: new Array(rows.length),
};

const postingsByTerm = new Map();
const docs = new Array(rows.length);

console.log("▸ Building TQSearch postings");
const t0 = performance.now();
for (let docIndex = 0; docIndex < rows.length; docIndex++) {
  const r = rows[docIndex];
  const abstract = truncatedAbstract(r);
  const scores = new Map();

  addWeighted(r.title, 12, scores);
  addWeighted(r.authors, 10, scores);
  addWeighted(r.advisors, 8, scores);
  addWeighted(r.subjects, 7, scores);
  addWeighted(r.discipline, 5, scores);
  addWeighted(r.source_name, 3, scores);
  addWeighted(abstract, 1, scores);
  addShingles(r.title, 20, scores);
  if (r.year) addWeighted(String(r.year), 4, scores);

  const topTerms = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TERMS_PER_DOC);
  for (const [term, score] of topTerms) {
    if (!postingsByTerm.has(term)) postingsByTerm.set(term, []);
    postingsByTerm.get(term).push([docIndex, score]);
  }

  codes.source[docIndex] = addDict(dicts.source, r.source_id, r.source_name || r.source_id);
  codes.discipline[docIndex] = addDict(dicts.discipline, r.discipline);
  codes.type[docIndex] = addDict(dicts.type, r.type);
  codes.decade[docIndex] = addDict(dicts.decade, decadeOf(r.year));
  codes.year[docIndex] = r.year || 0;
  docs[docIndex] = rowResult(r);

  if ((docIndex + 1) % 25000 === 0) {
    console.log(`  ... processed ${(docIndex + 1).toLocaleString()} / ${rows.length.toLocaleString()}`);
  }
}

const shards = new Map();
let postingCount = 0;
for (const [term, postings] of postingsByTerm) {
  const df = postings.length;
  const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
  const encoded = postings
    .map(([doc, score]) => [doc, Math.max(1, Math.round(score * idf * 100))])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  postingCount += encoded.length;
  const shard = shardFor(term);
  if (!shards.has(shard)) shards.set(shard, {});
  shards.get(shard)[term] = { df, p: encoded.flat() };
}
console.log(`  ${postingsByTerm.size.toLocaleString()} terms, ${postingCount.toLocaleString()} postings in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

console.log("▸ Writing TQSearch docs");
for (let start = 0, chunk = 0; start < docs.length; start += DOC_CHUNK_SIZE, chunk++) {
  writeFileSync(
    resolve(DOCS_OUT, `${String(chunk).padStart(4, "0")}.json`),
    JSON.stringify(docs.slice(start, start + DOC_CHUNK_SIZE)),
  );
}

console.log("▸ Writing TQSearch term shards");
const shardNames = [...shards.keys()].sort();
for (const shard of shardNames) {
  writeFileSync(resolve(TERMS_OUT, `${shard}.json`), JSON.stringify(shards.get(shard)));
}

const sources = facetRows(dicts.source);
const builtAt = new Date().toISOString();
const manifest = {
  version: 1,
  engine: "tqsearch",
  built_at: builtAt,
  total: rows.length,
  doc_chunk_size: DOC_CHUNK_SIZE,
  initial_results: docs.slice(0, INITIAL_RESULT_LIMIT),
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
  shards: shardNames,
  stats: {
    terms: postingsByTerm.size,
    postings: postingCount,
    max_terms_per_doc: MAX_TERMS_PER_DOC,
    abstract_limit: ABSTRACT_LIMIT,
  },
};

writeFileSync(resolve(OUT, "manifest.json"), JSON.stringify(manifest));
writeFileSync(resolve(OUT, "codes.json"), JSON.stringify(codes));

let outSize = "?";
try {
  outSize = execSync(`du -sh "${OUT}" | cut -f1`).toString().trim();
} catch {}
console.log(`✓ Built ${OUT}  (≈ ${outSize})`);
