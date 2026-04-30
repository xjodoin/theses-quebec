/**
 * Experimental static search backend for the thesis corpus.
 *
 * The index is built by scripts/build_tqsearch.mjs as impact-scored term
 * shards plus lazy-loaded document chunks. This keeps the Pagefind API shape
 * expected by common.js while avoiding full result enumeration for default
 * searches and keeping query-time scoring in simple typed JavaScript loops.
 */

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

let manifest = null;
let codesPromise = null;
let codes = null;

const shardCache = new Map();
const docChunkCache = new Map();
const availableShards = new Set();
const termDecoder = new TextDecoder();

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
  const seen = new Set();
  for (const raw of fold(text).split(/[^a-z0-9]+/u)) {
    if ((raw.length < 2 && !/^\d$/.test(raw)) || STOPWORDS.has(raw)) continue;
    const tok = stem(raw);
    if ((tok.length < 2 && !/^\d$/.test(tok)) || STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function queryTerms(text) {
  const terms = tokenize(text);
  const expanded = [...terms];
  for (const n of [2, 3]) {
    for (let i = 0; i <= terms.length - n; i++) {
      expanded.push(terms.slice(i, i + n).join("_"));
    }
  }
  return expanded;
}

function shardFor(term) {
  return `${term[0] || "_"}${term[1] || "_"}${term[2] || "_"}`;
}

function readVarint(bytes, state) {
  let value = 0;
  let multiplier = 1;
  while (state.pos < bytes.length) {
    const byte = bytes[state.pos++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return value;
    multiplier *= 0x80;
  }
  return value;
}

function parseShard(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x54 || bytes[1] !== 0x51 || bytes[2] !== 0x53 || bytes[3] !== 0x42) {
    throw new Error("Unsupported tqsearch term shard");
  }
  const state = { pos: 4 };
  const termCount = readVarint(bytes, state);
  const terms = new Map();
  for (let i = 0; i < termCount; i++) {
    const len = readVarint(bytes, state);
    const start = state.pos;
    state.pos += len;
    const term = termDecoder.decode(bytes.subarray(start, state.pos));
    terms.set(term, {
      df: readVarint(bytes, state),
      count: readVarint(bytes, state),
      offset: readVarint(bytes, state),
      byteLength: readVarint(bytes, state),
      p: null,
    });
  }
  return { bytes, dataStart: state.pos, terms };
}

function decodePosting(shard, entry) {
  if (entry.p) return { df: entry.df, p: entry.p };
  const p = new Int32Array(entry.count * 2);
  const state = { pos: shard.dataStart + entry.offset };
  for (let i = 0; i < entry.count; i++) {
    p[i * 2] = readVarint(shard.bytes, state);
    p[i * 2 + 1] = readVarint(shard.bytes, state);
  }
  entry.p = p;
  return { df: entry.df, p };
}

async function loadCodes() {
  if (codes) return codes;
  codes = await codesPromise;
  return codes;
}

async function loadShard(shard) {
  if (!availableShards.has(shard)) return {};
  if (!shardCache.has(shard)) {
    shardCache.set(shard, fetch(`./tqsearch/terms/${shard}.bin`).then(r => r.arrayBuffer()).then(parseShard));
  }
  return shardCache.get(shard);
}

async function loadDoc(docIndex) {
  const chunk = Math.floor(docIndex / manifest.doc_chunk_size);
  const local = docIndex - chunk * manifest.doc_chunk_size;
  if (!docChunkCache.has(chunk)) {
    const file = `${String(chunk).padStart(4, "0")}.json`;
    docChunkCache.set(chunk, fetch(`./tqsearch/docs/${file}`).then(r => r.json()));
  }
  const docs = await docChunkCache.get(chunk);
  return docs[local];
}

function selectedCodes(field, selected, valueKey = "value") {
  if (!selected?.size) return null;
  const dict = manifest.dicts[field];
  const values = new Set(selected);
  const out = new Set();
  dict.forEach((item, idx) => {
    if (values.has(item[valueKey])) out.add(idx);
  });
  return out;
}

function makeFilterPredicate({ type, year_min, year_max, discipline, source }, codeData) {
  const sourceCodes = selectedCodes("source", source);
  const disciplineCodes = selectedCodes("discipline", discipline);
  const typeCodes = type ? selectedCodes("type", new Set([type])) : null;
  const lo = year_min ? Number(year_min) : null;
  const hi = year_max ? Number(year_max) : null;

  return (doc) => {
    if (sourceCodes && !sourceCodes.has(codeData.source[doc])) return false;
    if (disciplineCodes && !disciplineCodes.has(codeData.discipline[doc])) return false;
    if (typeCodes && !typeCodes.has(codeData.type[doc])) return false;
    if (lo || hi) {
      const y = codeData.year[doc] || 0;
      if (lo && (!y || y < lo)) return false;
      if (hi && (!y || y > hi)) return false;
    }
    return true;
  };
}

function countFacets(docIds, codeData) {
  const discipline = new Array(manifest.dicts.discipline.length).fill(0);
  const source = new Array(manifest.dicts.source.length).fill(0);
  const decade = new Array(manifest.dicts.decade.length).fill(0);

  for (const doc of docIds) {
    discipline[codeData.discipline[doc]]++;
    source[codeData.source[doc]]++;
    decade[codeData.decade[doc]]++;
  }

  const mapFacet = (field, counts, chronological = false) => {
    const rows = manifest.dicts[field]
      .map((item, idx) => ({ value: item.value, label: item.label, n: counts[idx] || 0 }))
      .filter(item => item.value && item.n > 0);
    if (chronological) return rows.sort((a, b) => a.value.localeCompare(b.value));
    return rows.sort((a, b) => b.n - a.n);
  };

  return {
    discipline: mapFacet("discipline", discipline),
    source: mapFacet("source", source),
    decade: mapFacet("decade", decade, true),
  };
}

async function postingsForTerms(terms) {
  const byShard = new Map();
  for (const term of terms) {
    const shard = shardFor(term);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push(term);
  }

  const out = [];
  await Promise.all([...byShard.entries()].map(async ([shard, shardTerms]) => {
    const data = await loadShard(shard);
    for (const term of shardTerms) {
      const entry = data.terms?.get(term);
      if (entry) out.push({ term, posting: decodePosting(data, entry) });
    }
  }));
  return out;
}

function allDocIds(total) {
  return Array.from({ length: total }, (_, i) => i);
}

export default {
  label: "tqsearch",
  hasSplash: true,

  async init() {
    manifest = await fetch("./tqsearch/manifest.json").then(r => r.json());
    for (const shard of manifest.shards) availableShards.add(shard);
    codesPromise = fetch("./tqsearch/codes.json").then(r => r.json());
    codes = await codesPromise;
    return {
      total: manifest.total,
      sources: manifest.facets.source.map(s => ({ id: s.value, name: s.label, n: s.n })),
      builtAt: manifest.built_at,
    };
  },

  async search({ q, type, year_min, year_max, sort, discipline, source, page, size }) {
    const query = q && q.trim() ? q.trim() : "";
    const start = (page - 1) * size;
    const defaultSearch = !query && !type && !year_min && !year_max
      && !discipline.size && !source.size && (!sort || sort === "relevance");

    if (defaultSearch && start + size <= manifest.initial_results.length) {
      return {
        total: manifest.total,
        results: manifest.initial_results.slice(start, start + size),
        facets: manifest.facets,
      };
    }

    const codeData = await loadCodes();
    const passesFilters = makeFilterPredicate({ type, year_min, year_max, discipline, source }, codeData);
    const baseTerms = tokenize(query);
    const terms = queryTerms(query);
    let scored = [];

    if (!baseTerms.length) {
      scored = allDocIds(manifest.total)
        .filter(passesFilters)
        .map(doc => ({ doc, score: 0 }));
    } else {
      const scores = new Map();
      const hits = new Map();
      const baseTermSet = new Set(baseTerms);
      for (const { term, posting } of await postingsForTerms(terms)) {
        const p = posting.p;
        for (let i = 0; i < p.length; i += 2) {
          const doc = p[i];
          if (!passesFilters(doc)) continue;
          scores.set(doc, (scores.get(doc) || 0) + p[i + 1]);
          if (baseTermSet.has(term)) hits.set(doc, (hits.get(doc) || 0) + 1);
        }
      }
      const minShouldMatch = baseTerms.length <= 4 ? baseTerms.length : baseTerms.length - 1;
      scored = [...scores.entries()]
        .filter(([doc]) => (hits.get(doc) || 0) >= minShouldMatch)
        .map(([doc, score]) => ({ doc, score }));
    }

    if (sort === "year_desc") {
      scored.sort((a, b) => (codeData.year[b.doc] || 0) - (codeData.year[a.doc] || 0) || b.score - a.score);
    } else if (sort === "year_asc") {
      scored.sort((a, b) => (codeData.year[a.doc] || 9999) - (codeData.year[b.doc] || 9999) || b.score - a.score);
    } else {
      scored.sort((a, b) => b.score - a.score || a.doc - b.doc);
    }

    const docIds = scored.map(r => r.doc);
    const visible = scored.slice(start, start + size);
    const results = await Promise.all(visible.map(r => loadDoc(r.doc)));

    return {
      total: scored.length,
      results,
      facets: countFacets(docIds, codeData),
    };
  },
};
