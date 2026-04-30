#!/usr/bin/env node
/**
 * Generate build-time sparse expansion terms for tqsearch.
 *
 * This is intentionally model-output shaped JSONL. The current generator is a
 * local corpus learner: it emits controlled-field phrase impacts plus bounded
 * term-association expansions learned from title/subject/discipline evidence.
 * A future Doc2Query, DeepImpact, or SPLADE job can replace this producer while
 * keeping the same static index input contract.
 */

import Database from "better-sqlite3";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

const DB_PATH = resolve(ROOT, args.db || "data/theses.db");
const OUT_PATH = resolve(ROOT, args.out || "dist/tqsearch-sparse-expansions.jsonl");
const LIMIT = numberArg(args.limit, 24);
const ABSTRACT_INDEX_LIMIT = numberArg(args.abstractChars, 1800);
const ABSTRACT_PHRASE_TOKENS = numberArg(args.abstractPhraseTokens, 96);
const KEY_TERMS_PER_DOC = numberArg(args.keyTerms, 10);
const NEIGHBORS_PER_TERM = numberArg(args.neighbors, 8);
const MIN_DF = numberArg(args.minDf, 4);
const MAX_DF_RATIO = numberArg(args.maxDfRatio, 0.065);
const ASSOCIATION_MIN_DF = numberArg(args.associationMinDf, 8);
const ASSOCIATION_MAX_DF_RATIO = numberArg(args.associationMaxDfRatio, 0.04);
const ASSOCIATION_PRUNE_AT = numberArg(args.associationPruneAt, 128);
const ASSOCIATION_KEEP = numberArg(args.associationKeep, 64);
const MIN_ASSOCIATION_SCORE = numberArg(args.minAssociationScore, 0.015);
const SUBJECT_PHRASE_WEIGHT = numberArg(args.subjectPhraseWeight, 1.15);
const DISCIPLINE_PHRASE_WEIGHT = numberArg(args.disciplinePhraseWeight, 0.9);
const ABSTRACT_PHRASE_WEIGHT = numberArg(args.abstractPhraseWeight, 0.24);
const SUBJECT_TERM_WEIGHT = numberArg(args.subjectTermWeight, 0.32);
const DISCIPLINE_TERM_WEIGHT = numberArg(args.disciplineTermWeight, 0.24);
const ASSOCIATION_WEIGHT = numberArg(args.associationWeight, 1.0);

const SELECT_ROWS = `SELECT
     rowid AS id,
     title, authors, advisors, abstract, subjects,
     year, type, source_id, source_name, discipline, language, url
   FROM theses
   ORDER BY rowid`;

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

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const idx = arg.indexOf("=");
    if (idx < 0 || !arg.startsWith("--")) continue;
    out[arg.slice(2, idx).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = arg.slice(idx + 1);
  }
  return out;
}

function numberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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

function tokenize(text, maxTokens = Infinity) {
  const out = [];
  for (const raw of fold(text).split(/[^a-z0-9]+/u)) {
    if ((raw.length < 2 && !/^\d$/.test(raw)) || STOPWORDS.has(raw)) continue;
    const tok = stem(raw);
    if ((tok.length >= 2 || /^\d$/.test(tok)) && !STOPWORDS.has(tok)) out.push(tok);
    if (out.length >= maxTokens) break;
  }
  return out;
}

function abstractText(r) {
  return r.abstract ? String(r.abstract).slice(0, ABSTRACT_INDEX_LIMIT) : "";
}

function rowDfTerms(r) {
  return new Set([
    ...tokenize(r.title),
    ...tokenize(r.subjects),
    ...tokenize(r.discipline),
    ...tokenize(abstractText(r)),
  ]);
}

function measureDf(db, total) {
  console.log("▸ Measuring sparse-expansion document frequencies");
  const df = new Map();
  let seen = 0;
  for (const r of db.prepare(SELECT_ROWS).iterate()) {
    for (const term of rowDfTerms(r)) df.set(term, (df.get(term) || 0) + 1);
    seen++;
    if (seen % 50000 === 0) {
      console.log(`  ... measured ${seen.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }
  return df;
}

function idf(term, df, total) {
  return Math.log(1 + (total + 0.5) / ((df.get(term) || 0) + 0.5));
}

function usefulTerm(term, df, total, { association = false } = {}) {
  if (!term || /^\d+$/.test(term)) return false;
  const count = df.get(term) || 0;
  const min = association ? ASSOCIATION_MIN_DF : MIN_DF;
  const maxRatio = association ? ASSOCIATION_MAX_DF_RATIO : MAX_DF_RATIO;
  return count >= min && count <= total * maxRatio;
}

function addWeighted(map, term, weight, reason = "") {
  if (!term || weight <= 0) return;
  const prev = map.get(term);
  if (!prev || weight > prev.weight) map.set(term, { term, weight, reason });
}

function addFieldTerms(scores, text, fieldWeight, df, total, maxTokens = Infinity) {
  const counts = new Map();
  for (const term of tokenize(text, maxTokens)) {
    if (!usefulTerm(term, df, total)) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  for (const [term, tf] of counts) {
    const score = fieldWeight * (1 + Math.log(tf)) * idf(term, df, total);
    scores.set(term, (scores.get(term) || 0) + score);
  }
}

function docKeyTerms(r, df, total, limit = KEY_TERMS_PER_DOC) {
  const scores = new Map();
  addFieldTerms(scores, r.title, 4.0, df, total);
  addFieldTerms(scores, r.subjects, 3.0, df, total);
  addFieldTerms(scores, r.discipline, 2.0, df, total);
  addFieldTerms(scores, abstractText(r), 0.8, df, total, 180);
  return [...scores.entries()]
    .filter(([term]) => usefulTerm(term, df, total, { association: true }))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function pruneNeighbors(neighbors, keep = ASSOCIATION_KEEP) {
  if (neighbors.size <= keep) return;
  const top = [...neighbors.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, keep);
  neighbors.clear();
  for (const [term, score] of top) neighbors.set(term, score);
}

function addAssociation(assoc, left, right, weight) {
  if (!left || !right || left === right || weight <= 0) return;
  let neighbors = assoc.get(left);
  if (!neighbors) {
    neighbors = new Map();
    assoc.set(left, neighbors);
  }
  neighbors.set(right, (neighbors.get(right) || 0) + weight);
  if (neighbors.size > ASSOCIATION_PRUNE_AT) pruneNeighbors(neighbors);
}

function buildAssociations(db, df, total) {
  if (ASSOCIATION_WEIGHT <= 0) {
    console.log("▸ Skipping sparse term associations");
    return new Map();
  }

  console.log("▸ Learning sparse term associations");
  const assoc = new Map();
  let seen = 0;
  for (const r of db.prepare(SELECT_ROWS).iterate()) {
    const keys = docKeyTerms(r, df, total, KEY_TERMS_PER_DOC);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const weight = Math.sqrt(keys[i][1] * keys[j][1]);
        addAssociation(assoc, keys[i][0], keys[j][0], weight);
        addAssociation(assoc, keys[j][0], keys[i][0], weight);
      }
    }
    seen++;
    if (seen % 50000 === 0) {
      console.log(`  ... learned from ${seen.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  const normalized = new Map();
  for (const [term, neighbors] of assoc) {
    const termDf = df.get(term) || 1;
    const top = [...neighbors.entries()]
      .map(([neighbor, score]) => {
        const neighborDf = df.get(neighbor) || 1;
        return [neighbor, score / Math.sqrt(termDf * neighborDf)];
      })
      .filter(([, score]) => score >= MIN_ASSOCIATION_SCORE)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, NEIGHBORS_PER_TERM);
    if (top.length) normalized.set(term, top);
  }
  console.log(`  ${normalized.size.toLocaleString()} terms have learned neighbors`);
  return normalized;
}

function phraseTerm(tokens, start, n) {
  return tokens.slice(start, start + n).join("_");
}

function addPhrases(candidates, text, fieldWeight, reason, df, total, maxTokens) {
  const tokens = tokenize(text, maxTokens).filter(term => usefulTerm(term, df, total));
  const seen = new Set();
  for (const n of [2, 3]) {
    for (let i = 0; i <= tokens.length - n; i++) {
      const phrase = phraseTerm(tokens, i, n);
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      const avgIdf = tokens.slice(i, i + n).reduce((sum, term) => sum + idf(term, df, total), 0) / n;
      const specificity = n === 3 ? 1.12 : 1.0;
      addWeighted(candidates, phrase, fieldWeight * avgIdf * specificity, reason);
    }
  }
}

function addControlledUnigrams(candidates, text, fieldWeight, reason, df, total) {
  const seen = new Set();
  for (const term of tokenize(text, 60)) {
    if (seen.has(term) || !usefulTerm(term, df, total)) continue;
    seen.add(term);
    addWeighted(candidates, term, fieldWeight * idf(term, df, total), reason);
  }
}

function addAssociationTerms(candidates, r, associations, df, total) {
  if (ASSOCIATION_WEIGHT <= 0) return;
  const docTerms = rowDfTerms(r);
  const keys = docKeyTerms(r, df, total, 6);
  for (const [anchor, anchorScore] of keys) {
    const neighbors = associations.get(anchor);
    if (!neighbors) continue;
    for (const [neighbor, assocScore] of neighbors) {
      if (docTerms.has(neighbor)) continue;
      const weight = ASSOCIATION_WEIGHT * Math.min(1.6, Math.max(0.18, assocScore * Math.sqrt(anchorScore)));
      addWeighted(candidates, neighbor, weight, "association");
    }
  }
}

function expansionTermsForRow(r, associations, df, total) {
  const candidates = new Map();
  if (SUBJECT_PHRASE_WEIGHT > 0) addPhrases(candidates, r.subjects, SUBJECT_PHRASE_WEIGHT, "subject_phrase", df, total, 48);
  if (DISCIPLINE_PHRASE_WEIGHT > 0) addPhrases(candidates, r.discipline, DISCIPLINE_PHRASE_WEIGHT, "discipline_phrase", df, total, 12);
  if (ABSTRACT_PHRASE_WEIGHT > 0) addPhrases(candidates, abstractText(r), ABSTRACT_PHRASE_WEIGHT, "abstract_phrase", df, total, ABSTRACT_PHRASE_TOKENS);
  if (SUBJECT_TERM_WEIGHT > 0) addControlledUnigrams(candidates, r.subjects, SUBJECT_TERM_WEIGHT, "subject_term", df, total);
  if (DISCIPLINE_TERM_WEIGHT > 0) addControlledUnigrams(candidates, r.discipline, DISCIPLINE_TERM_WEIGHT, "discipline_term", df, total);
  addAssociationTerms(candidates, r, associations, df, total);

  return [...candidates.values()]
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, LIMIT)
    .map(item => ({
      term: item.term,
      weight: Number(item.weight.toFixed(4)),
      source: item.reason,
    }));
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await once(stream, "drain");
}

async function emitExpansions(db, associations, df, total) {
  console.log(`▸ Writing sparse expansions to ${OUT_PATH}`);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const stream = createWriteStream(OUT_PATH, { encoding: "utf8" });
  let doc = 0;
  let records = 0;
  let terms = 0;
  const sourceCounts = new Map();

  for (const r of db.prepare(SELECT_ROWS).iterate()) {
    const expansion = expansionTermsForRow(r, associations, df, total);
    if (expansion.length) {
      for (const item of expansion) sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
      await writeLine(stream, `${JSON.stringify({ doc, terms: expansion })}\n`);
      records++;
      terms += expansion.length;
    }
    doc++;
    if (doc % 50000 === 0) {
      console.log(`  ... emitted ${doc.toLocaleString()} / ${total.toLocaleString()}`);
    }
  }

  stream.end();
  await once(stream, "finish");
  console.log(`  ${terms.toLocaleString()} terms across ${records.toLocaleString()} records`);
  for (const [source, n] of [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${source}: ${n.toLocaleString()}`);
  }
}

if (!existsSync(DB_PATH)) {
  throw new Error(`Database not found: ${DB_PATH}`);
}

console.log(`▸ Reading ${DB_PATH}`);
const db = new Database(DB_PATH, { readonly: true });
try {
  const total = db.prepare("SELECT COUNT(*) AS n FROM theses").get().n;
  console.log(`  ${total.toLocaleString()} records available`);
  const df = measureDf(db, total);
  const associations = buildAssociations(db, df, total);
  await emitExpansions(db, associations, df, total);
} finally {
  db.close();
}
