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
let typoManifest = null;
let typoManifestPromise = null;
let termRangesPromise = null;
let availableTypoShards = new Set();
let termShardRanges = new Map();
let typoShardRanges = new Map();

const FAST_TOPK_MAX_TERMS = 30;
const FAST_TOPK_MAX_RESULTS = 50;
const FAST_TOPK_CHECK_BLOCKS = 4;
const RERANK_CANDIDATES = 30;
const DEPENDENCY_SCORE_SCALE = 0.12;
const TERM_RANGE_MERGE_GAP_BYTES = 8 * 1024;
const TERM_RANGE_MAGIC = [0x54, 0x51, 0x52, 0x47]; // TQRG
const TYPO_FALLBACK_MIN_TOTAL = 1;
const TYPO_MAX_QUERY_TERMS = 8;
const TYPO_MAX_TOKEN_CANDIDATES = 64;
const TYPO_MIN_ACCEPT_SCORE = 0.5;
const TYPO_PRESENT_DF_PROTECT = 50;
const TYPO_SURFACE_SEPARATOR = "\u0001";
const TYPO_SHARD_MAGIC = [0x54, 0x51, 0x54, 0x42]; // TQTB
const TYPO_RANGE_MERGE_GAP_BYTES = 8 * 1024;

const shardCache = new Map();
const docChunkCache = new Map();
const typoShardCache = new Map();
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

function analyzeQuery(text) {
  const out = [];
  const seen = new Set();
  for (const raw of fold(text).split(/[^a-z0-9]+/u)) {
    if ((raw.length < 2 && !/^\d$/.test(raw)) || STOPWORDS.has(raw)) continue;
    const term = stem(raw);
    if ((term.length < 2 && !/^\d$/.test(term)) || STOPWORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push({ raw, term });
  }
  return out;
}

function proximityTerm(left, right) {
  if (!left || !right || left === right) return "";
  const [a, b] = left < right ? [left, right] : [right, left];
  return `n_${a}_${b}`;
}

function queryTerms(text) {
  return expandedTermsFromBaseTerms(tokenize(text));
}

function expandedTermsFromBaseTerms(terms) {
  const expanded = [...terms];
  for (const n of [2, 3]) {
    for (let i = 0; i <= terms.length - n; i++) {
      const phrase = terms.slice(i, i + n).join("_");
      expanded.push(phrase);
    }
  }
  return [...new Set(expanded)];
}

function dependencyTerms(terms) {
  if (terms.length < 3) return [];
  const window = manifest?.stats?.proximity_window || 5;
  const out = new Map();
  for (let i = 0; i < terms.length; i++) {
    const end = Math.min(terms.length, i + window + 1);
    for (let j = i + 1; j < end; j++) {
      const term = proximityTerm(terms[i], terms[j]);
      if (!term) continue;
      out.set(term, (out.get(term) || 0) + DEPENDENCY_SCORE_SCALE / Math.max(1, j - i));
    }
  }
  return [...out.entries()].map(([term, weight]) => ({ term, weight }));
}

function typoMaxEditsFor(term) {
  const max = typoManifest?.max_edits || 2;
  return term.length >= 8 ? max : Math.min(1, max);
}

function typoDeleteKeys(term, maxEdits = typoMaxEditsFor(term)) {
  const minLength = (typoManifest?.min_term_length || 5) - (typoManifest?.max_edits || 2);
  const keys = new Set([term]);
  let frontier = new Set([term]);
  for (let edits = 1; edits <= maxEdits; edits++) {
    const next = new Set();
    for (const value of frontier) {
      if (value.length <= 1) continue;
      for (let i = 0; i < value.length; i++) {
        const key = value.slice(0, i) + value.slice(i + 1);
        if (key.length < minLength) continue;
        keys.add(key);
        next.add(key);
      }
    }
    frontier = next;
  }
  return keys;
}

function shardKey(term, depth) {
  return String(term || "").slice(0, depth).padEnd(depth, "_");
}

function shardFor(term) {
  const maxDepth = manifest?.stats?.term_max_shard_depth || 5;
  const baseDepth = manifest?.stats?.term_base_shard_depth || 3;
  for (let depth = maxDepth; depth >= baseDepth; depth--) {
    const key = shardKey(term, depth);
    if (availableShards.has(key)) return key;
  }
  return shardKey(term, baseDepth);
}

function typoShardKey(deleteKey, depth = typoManifest?.base_shard_depth || 2) {
  return String(deleteKey || "").slice(0, depth).padEnd(depth, "_");
}

function typoShardFor(deleteKey) {
  const maxDepth = typoManifest?.max_shard_depth || typoManifest?.base_shard_depth || 2;
  const baseDepth = typoManifest?.base_shard_depth || typoManifest?.shard_depth || 2;
  for (let depth = maxDepth; depth >= baseDepth; depth--) {
    const key = typoShardKey(deleteKey, depth);
    if (availableTypoShards.has(key)) return key;
  }
  return typoShardKey(deleteKey, baseDepth);
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
      blockSize: readVarint(bytes, state),
      blocks: null,
      p: null,
    });
    const entry = terms.get(term);
    const blockCount = readVarint(bytes, state);
    entry.blocks = new Array(blockCount);
    for (let j = 0; j < blockCount; j++) {
      const block = {
        offset: readVarint(bytes, state),
        maxImpact: readVarint(bytes, state),
        filters: {},
      };
      for (const filter of (manifest.block_filters || [])) {
        if (filter.kind === "facet") {
          const words = new Array(filter.words);
          for (let w = 0; w < filter.words; w++) words[w] = readVarint(bytes, state);
          block.filters[filter.name] = { words };
        } else {
          block.filters[filter.name] = {
            min: readVarint(bytes, state),
            max: readVarint(bytes, state),
          };
        }
      }
      entry.blocks[j] = block;
    }
  }
  return { bytes, dataStart: state.pos, terms };
}

function parseCodes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x54 || bytes[1] !== 0x51 || bytes[2] !== 0x43 || bytes[3] !== 0x42) {
    throw new Error("Unsupported tqsearch code table");
  }

  const state = { pos: 4 };
  const total = readVarint(bytes, state);
  const fieldCount = readVarint(bytes, state);
  const fields = [];
  for (let i = 0; i < fieldCount; i++) {
    const len = readVarint(bytes, state);
    const start = state.pos;
    state.pos += len;
    fields.push({
      name: termDecoder.decode(bytes.subarray(start, state.pos)),
      width: bytes[state.pos++],
    });
  }

  const out = {};
  for (const field of fields) {
    if (field.width === 1) {
      out[field.name] = bytes.slice(state.pos, state.pos + total);
    } else {
      const ArrayType = field.width === 2 ? Uint16Array : Uint32Array;
      const values = new ArrayType(total);
      for (let i = 0; i < total; i++) {
        let value = 0;
        for (let b = 0; b < field.width; b++) {
          value += bytes[state.pos + i * field.width + b] * (2 ** (8 * b));
        }
        values[i] = value;
      }
      out[field.name] = values;
    }
    state.pos += total * field.width;
  }
  return out;
}

function packFileName(index) {
  return `${String(index).padStart(4, "0")}.bin`;
}

function parseTermRangeDirectory(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < TERM_RANGE_MAGIC.length; i++) {
    if (bytes[i] !== TERM_RANGE_MAGIC[i]) throw new Error("Unsupported tqsearch term range directory");
  }
  const state = { pos: TERM_RANGE_MAGIC.length };
  const count = readVarint(bytes, state);
  const ranges = new Map();
  for (let i = 0; i < count && i < (manifest?.shards?.length || 0); i++) {
    const packIndex = readVarint(bytes, state);
    ranges.set(manifest.shards[i], {
      pack: packFileName(packIndex),
      offset: readVarint(bytes, state),
      length: readVarint(bytes, state),
    });
  }
  return ranges;
}

function readUtf8(bytes, state) {
  const len = readVarint(bytes, state);
  const start = state.pos;
  state.pos += len;
  return termDecoder.decode(bytes.subarray(start, state.pos));
}

function parseTypoShard(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < TYPO_SHARD_MAGIC.length; i++) {
    if (bytes[i] !== TYPO_SHARD_MAGIC[i]) throw new Error("Unsupported tqsearch typo shard");
  }

  const state = { pos: TYPO_SHARD_MAGIC.length };
  const pairCount = readVarint(bytes, state);
  const pairs = new Array(pairCount);
  for (let i = 0; i < pairCount; i++) {
    pairs[i] = {
      surface: readUtf8(bytes, state),
      term: readUtf8(bytes, state),
      df: readVarint(bytes, state),
    };
  }
  const deleteKeyCount = readVarint(bytes, state);
  const keys = new Map();
  let previous = "";
  for (let i = 0; i < deleteKeyCount; i++) {
    const prefix = readVarint(bytes, state);
    const suffix = readUtf8(bytes, state);
    const key = previous.slice(0, prefix) + suffix;
    keys.set(key, {
      offset: readVarint(bytes, state),
      count: readVarint(bytes, state),
      candidates: null,
    });
    previous = key;
  }

  return { bytes, dataStart: state.pos, pairs, keys };
}

async function fetchGzipArrayBuffer(url) {
  if (!("DecompressionStream" in globalThis)) {
    const fallback = url.endsWith(".gz") ? url.slice(0, -3) : url;
    const response = await fetch(fallback);
    if (!response.ok) {
      throw new Error("tqsearch compressed index requires DecompressionStream");
    }
    return response.arrayBuffer();
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Unable to fetch ${url}`);
  return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

async function decompressGzipArrayBuffer(buffer) {
  if (!("DecompressionStream" in globalThis)) {
    throw new Error("tqsearch range packs require DecompressionStream");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function fetchRangeArrayBuffer(url, offset, length) {
  const end = offset + length - 1;
  const response = await fetch(url, {
    headers: { Range: `bytes=${offset}-${end}` },
  });
  if (response.status !== 206) {
    throw new Error(`Unable to range-fetch ${url} ${offset}-${end}`);
  }
  return response.arrayBuffer();
}

async function loadTypoManifest() {
  if (typoManifest !== null) return typoManifest;
  if (!typoManifestPromise) {
    typoManifestPromise = fetch("./tqsearch/typo/manifest.json")
      .then(response => response.ok ? response.json() : false)
      .catch(() => false);
  }
  typoManifest = await typoManifestPromise;
  availableTypoShards = new Set(typoManifest?.shards || []);
  typoShardRanges = new Map();
  const ranges = typoManifest?.shard_ranges || [];
  const packs = typoManifest?.packs || [];
  for (let i = 0; i < (typoManifest?.shards?.length || 0); i++) {
    const range = ranges[i];
    const pack = packs[range?.[0]];
    if (!range || !pack) continue;
    typoShardRanges.set(typoManifest.shards[i], {
      pack: pack.file,
      offset: range[1],
      length: range[2],
    });
  }
  return typoManifest;
}

function groupRangeFetches(items, gapBytes) {
  const byPack = new Map();
  for (const item of items) {
    if (!byPack.has(item.entry.pack)) byPack.set(item.entry.pack, []);
    byPack.get(item.entry.pack).push(item);
  }
  const groups = [];
  for (const [pack, packItems] of byPack) {
    const sorted = packItems
      .map(item => ({
        ...item,
        start: item.entry.offset,
        end: item.entry.offset + item.entry.length,
      }))
      .sort((a, b) => a.start - b.start);
    let current = null;
    for (const item of sorted) {
      if (!current || item.start > current.end + gapBytes) {
        current = { pack, start: item.start, end: item.end, items: [item] };
        groups.push(current);
      } else {
        current.items.push(item);
        current.end = Math.max(current.end, item.end);
      }
    }
  }
  return groups;
}

function groupTypoRangeFetches(items) {
  return groupRangeFetches(items, TYPO_RANGE_MERGE_GAP_BYTES);
}

async function loadTypoShards(shards) {
  const meta = await loadTypoManifest();
  if (!meta) return new Map();

  const wanted = [];
  const pending = [];
  for (const shard of new Set(shards)) {
    if (!availableTypoShards.has(shard)) continue;
    wanted.push(shard);
    if (typoShardCache.has(shard)) continue;
    const entry = typoShardRanges.get(shard);
    if (!entry) continue;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    typoShardCache.set(shard, promise);
    pending.push({ shard, entry, resolve, reject });
  }

  const groups = groupTypoRangeFetches(pending);
  await Promise.all(groups.map(async (group) => {
    try {
      const compressed = await fetchRangeArrayBuffer(
        `./tqsearch/typo/packs/${group.pack}`,
        group.start,
        group.end - group.start,
      );
      await Promise.all(group.items.map(async (item) => {
        const start = item.entry.offset - group.start;
        const end = start + item.entry.length;
        const parsed = parseTypoShard(await decompressGzipArrayBuffer(compressed.slice(start, end)));
        item.resolve(parsed);
      }));
    } catch (error) {
      for (const item of group.items) {
        typoShardCache.delete(item.shard);
        item.reject(error);
      }
    }
  }));

  const out = new Map();
  await Promise.all(wanted.map(async (shard) => {
    const data = await typoShardCache.get(shard);
    if (data) out.set(shard, data);
  }));
  return out;
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

function createPostingCursor(shard, entry, termIndex, isBase, blockMayPass = null) {
  return {
    shard,
    entry,
    termIndex,
    isBase,
    blockMayPass,
    blockIndex: 0,
    decoded: 0,
    pos: shard.dataStart + entry.offset,
    skippedBlocks: 0,
  };
}

function advanceCursorToCandidateBlock(cursor) {
  while (cursor.blockMayPass) {
    const block = cursor.entry.blocks[cursor.blockIndex];
    if (!block || cursor.blockMayPass(block)) return;
    cursor.blockIndex++;
    cursor.decoded = Math.min(cursor.entry.count, cursor.blockIndex * cursor.entry.blockSize);
    const next = cursor.entry.blocks[cursor.blockIndex];
    cursor.pos = cursor.shard.dataStart + cursor.entry.offset + (next?.offset ?? cursor.entry.byteLength);
    cursor.skippedBlocks++;
  }
}

function cursorRemainingMax(cursor) {
  advanceCursorToCandidateBlock(cursor);
  return cursor.entry.blocks[cursor.blockIndex]?.maxImpact || 0;
}

function decodeCursorBlock(cursor) {
  advanceCursorToCandidateBlock(cursor);
  const { entry, shard } = cursor;
  const block = entry.blocks[cursor.blockIndex];
  if (!block) return [];

  const next = entry.blocks[cursor.blockIndex + 1];
  const blockEnd = shard.dataStart + entry.offset + (next?.offset ?? entry.byteLength);
  const countEnd = Math.min(entry.count, (cursor.blockIndex + 1) * entry.blockSize);
  const state = { pos: cursor.pos };
  const rows = [];
  while (state.pos < blockEnd && cursor.decoded < countEnd) {
    rows.push([readVarint(shard.bytes, state), readVarint(shard.bytes, state)]);
    cursor.decoded++;
  }
  cursor.pos = state.pos;
  cursor.blockIndex++;
  return rows;
}

async function loadCodes() {
  if (codes) return codes;
  if (!codesPromise) codesPromise = fetchGzipArrayBuffer("./tqsearch/codes.bin.gz").then(parseCodes);
  codes = await codesPromise;
  return codes;
}

async function loadTermRangeDirectory() {
  if (termShardRanges.size) return termShardRanges;
  if (!termRangesPromise) {
    termRangesPromise = fetchGzipArrayBuffer("./tqsearch/terms/ranges.bin.gz")
      .then(parseTermRangeDirectory);
  }
  termShardRanges = await termRangesPromise;
  return termShardRanges;
}

function groupTermRangeFetches(items) {
  return groupRangeFetches(items, TERM_RANGE_MERGE_GAP_BYTES);
}

async function loadShards(shards) {
  await loadTermRangeDirectory();
  const wanted = [];
  const pending = [];
  for (const shard of new Set(shards)) {
    if (!availableShards.has(shard)) continue;
    wanted.push(shard);
    if (shardCache.has(shard)) continue;
    const entry = termShardRanges.get(shard);
    if (!entry) continue;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    shardCache.set(shard, promise);
    pending.push({ shard, entry, resolve, reject });
  }

  const groups = groupTermRangeFetches(pending);
  await Promise.all(groups.map(async (group) => {
    try {
      const compressed = await fetchRangeArrayBuffer(
        `./tqsearch/terms/packs/${group.pack}`,
        group.start,
        group.end - group.start,
      );
      await Promise.all(group.items.map(async (item) => {
        const start = item.entry.offset - group.start;
        const end = start + item.entry.length;
        const parsed = parseShard(await decompressGzipArrayBuffer(compressed.slice(start, end)));
        item.resolve(parsed);
      }));
    } catch (error) {
      for (const item of group.items) {
        shardCache.delete(item.shard);
        item.reject(error);
      }
    }
  }));

  const out = new Map();
  await Promise.all(wanted.map(async (shard) => {
    const data = await shardCache.get(shard);
    if (data) out.set(shard, data);
  }));
  return out;
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
  const entries = await termEntriesForTerms(terms);
  return entries.map(({ term, shard, entry }) => ({ term, posting: decodePosting(shard, entry) }));
}

async function termEntriesForTerms(terms) {
  const byShard = new Map();
  for (const term of terms) {
    const shard = shardFor(term);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push(term);
  }

  const out = [];
  const loadedShards = await loadShards([...byShard.keys()]);
  for (const [shard, shardTerms] of byShard.entries()) {
    const data = loadedShards.get(shard) || {};
    for (const term of shardTerms) {
      const entry = data.terms?.get(term);
      if (entry) out.push({ term, shard: data, entry });
    }
  }
  return out;
}

function boundedDamerauLevenshtein(a, b, maxDistance) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let prevPrev = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        prev[j] + 1,
        current[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [prevPrev, prev, current] = [prev, current, prevPrev];
  }
  return prev[b.length];
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function lcsLength(a, b) {
  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

function typoCandidateScore(token, term, df, distance) {
  const prefix = commonPrefixLength(token, term);
  const sequenceSimilarity = lcsLength(token, term) / Math.max(1, token.length);
  const sameFirst = token[0] && token[0] === term[0] ? 1.2 : -1.6;
  const sameLast = token[token.length - 1] === term[term.length - 1] ? 0.35 : 0;
  const lengthPenalty = Math.abs(token.length - term.length) * 0.25;
  return Math.log1p(df) * 1.15
    + Math.min(prefix, 4) * 0.15
    + sequenceSimilarity * 4.0
    + sameFirst
    + sameLast
    - distance * 2.35
    - lengthPenalty;
}

function typoCandidatesForDeleteKey(shard, key) {
  if (!shard.keys) return [];
  const entry = shard.keys.get(key);
  if (!entry) return [];
  if (entry.candidates) return entry.candidates;
  const state = { pos: shard.dataStart + entry.offset };
  const candidates = new Array(entry.count);
  for (let i = 0; i < entry.count; i++) {
    candidates[i] = shard.pairs[readVarint(shard.bytes, state)] || { surface: "", term: "", df: 0 };
  }
  entry.candidates = candidates;
  return candidates;
}

async function typoCandidatesForToken(token, debug) {
  const meta = await loadTypoManifest();
  if (!meta) return [];
  const minQueryLength = Math.max(2, (meta.min_surface_length || meta.min_term_length || 5) - (meta.max_edits || 2));
  const maxQueryLength = meta.max_surface_length || meta.max_term_length || 20;
  if (token.length < minQueryLength || token.length > maxQueryLength) return [];
  if (!/^[a-z][a-z0-9]*$/u.test(token) || /^\d+$/u.test(token)) return [];

  const maxEdits = typoMaxEditsFor(token);
  const deleteKeys = [...typoDeleteKeys(token, maxEdits)];
  const byShard = new Map();
  for (const key of deleteKeys) {
    const shard = typoShardFor(key);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push(key);
  }

  const candidates = new Map();
  const loadedShards = await loadTypoShards([...byShard.keys()]);
  for (const [shard, keys] of byShard.entries()) {
    debug.shards.add(shard);
    const data = loadedShards.get(shard) || {};
    for (const key of keys) {
      for (const { surface, term, df } of typoCandidatesForDeleteKey(data, key)) {
        if (surface === token) continue;
        const candidateKey = `${surface}${TYPO_SURFACE_SEPARATOR}${term}`;
        const previous = candidates.get(candidateKey);
        if (!previous || df > previous.df) candidates.set(candidateKey, { surface, term, df });
      }
    }
  }

  const verified = [];
  for (const candidate of candidates.values()) {
    const distance = boundedDamerauLevenshtein(token, candidate.surface, maxEdits);
    if (distance <= 0 || distance > maxEdits) continue;
    verified.push({
      ...candidate,
      distance,
      score: typoCandidateScore(token, candidate.surface, candidate.df, distance),
    });
  }
  debug.candidates += verified.length;
  return verified
    .sort((a, b) => b.score - a.score || a.distance - b.distance || b.df - a.df || a.term.localeCompare(b.term))
    .slice(0, TYPO_MAX_TOKEN_CANDIDATES);
}

async function correctedTypoQuery(baseTerms, presentTerms = new Map(), analyzedTerms = null) {
  if (!baseTerms.length || baseTerms.length > TYPO_MAX_QUERY_TERMS) return null;
  const plans = [];
  const debug = { shards: new Set(), candidates: 0 };
  const hasMissingTerms = baseTerms.some(token => !presentTerms.has(token));
  const terms = analyzedTerms || baseTerms.map(term => ({ raw: term, term }));

  for (let index = 0; index < terms.length; index++) {
    const item = terms[index];
    const token = item.term;
    const presentDf = presentTerms.get(token) || 0;
    if (presentDf > 0 && (hasMissingTerms || presentDf >= TYPO_PRESENT_DF_PROTECT)) continue;
    const candidates = await typoCandidatesForToken(item.raw, debug);
    const accepted = candidates
      .filter(candidate => candidate.score >= TYPO_MIN_ACCEPT_SCORE)
      .slice(0, 4);
    for (const best of accepted) {
      const corrected = baseTerms.slice();
      corrected[index] = best.term;
      if (corrected[index] === token) continue;
      const correction = {
        from: item.raw,
        to: best.term,
        surface: best.surface,
        distance: best.distance,
        df: best.df,
        score: Number(best.score.toFixed(3)),
      };
      plans.push({
        q: corrected.join(" "),
        baseTerms: corrected,
        corrections: [correction],
        score: best.score,
      });
    }
  }

  if (!plans.length) return null;
  plans.sort((a, b) => b.score - a.score || a.q.localeCompare(b.q));
  return {
    plans: plans.slice(0, 12),
    stats: {
      typoCandidateTerms: debug.candidates,
      typoShardLookups: debug.shards.size,
    },
  };
}

function allDocIds(total) {
  return Array.from({ length: total }, (_, i) => i);
}

function selectedSize(value) {
  return value?.size || 0;
}

function hasActiveFilters({ type, year_min, year_max, discipline, source }) {
  return !!type || !!year_min || !!year_max || selectedSize(discipline) > 0 || selectedSize(source) > 0;
}

function bitIsSet(words, value) {
  const word = Math.floor(value / 32);
  const bit = value % 32;
  return Math.floor((words[word] || 0) / (2 ** bit)) % 2 === 1;
}

function addBit(words, value) {
  if (value < 0) return;
  const word = Math.floor(value / 32);
  const bit = value % 32;
  if (!bitIsSet(words, value)) words[word] += 2 ** bit;
}

function wordsIntersect(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    let left = a[i] || 0;
    let right = b[i] || 0;
    while (left && right) {
      const leftBit = left % 2;
      const rightBit = right % 2;
      if (leftBit && rightBit) return true;
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }
  }
  return false;
}

function codeSetToWords(codes, wordCount) {
  const words = new Array(wordCount).fill(0);
  for (const code of codes || []) addBit(words, code);
  return words;
}

function makeFilterPlan({ type, year_min, year_max, discipline, source }) {
  const filters = new Map();
  const sourceCodes = selectedCodes("source", source);
  const disciplineCodes = selectedCodes("discipline", discipline);
  const typeCodes = type ? selectedCodes("type", new Set([type])) : null;
  const lo = year_min ? Number(year_min) : null;
  const hi = year_max ? Number(year_max) : null;

  for (const filter of (manifest.block_filters || [])) {
    if (filter.kind === "facet") {
      const codesForField = filter.name === "source" ? sourceCodes
        : filter.name === "discipline" ? disciplineCodes
        : filter.name === "type" ? typeCodes
        : null;
      if (codesForField?.size) {
        filters.set(filter.name, {
          kind: "facet",
          words: codeSetToWords(codesForField, filter.words),
        });
      }
    } else if (filter.name === "year" && (lo || hi)) {
      filters.set(filter.name, {
        kind: "number",
        min: lo || 0,
        max: hi || Infinity,
      });
    }
  }

  return {
    active: filters.size > 0,
    filters,
  };
}

function blockMatchesFilterPlan(block, plan) {
  if (!plan?.active) return true;
  for (const [name, filter] of plan.filters) {
    const summary = block.filters?.[name];
    if (!summary) continue;
    if (filter.kind === "facet") {
      if (!wordsIntersect(summary.words, filter.words)) return false;
    } else if ((summary.max || 0) < filter.min || (summary.min || Infinity) > filter.max) {
      return false;
    }
  }
  return true;
}

function minShouldMatchFor(baseTerms) {
  return baseTerms.length <= 4 ? baseTerms.length : baseTerms.length - 1;
}

function sortScored(scored, codeData, sort) {
  if (sort === "year_desc") {
    scored.sort((a, b) => (codeData.year[b.doc] || 0) - (codeData.year[a.doc] || 0) || b.score - a.score);
  } else if (sort === "year_asc") {
    scored.sort((a, b) => (codeData.year[a.doc] || 9999) - (codeData.year[b.doc] || 9999) || b.score - a.score);
  } else {
    scored.sort((a, b) => b.score - a.score || a.doc - b.doc);
  }
  return scored;
}

function collectEligibleScores(scores, hits, minShouldMatch) {
  const out = [];
  for (const [doc, score] of scores) {
    if ((hits.get(doc) || 0) >= minShouldMatch) out.push({ doc, score });
  }
  out.sort((a, b) => b.score - a.score || a.doc - b.doc);
  return out;
}

function remainingPotential(cursors, mask = 0) {
  let potential = 0;
  for (const cursor of cursors) {
    if (!bitIsSet([mask], cursor.termIndex)) potential += cursorRemainingMax(cursor);
  }
  return potential;
}

function cursorStats(cursors) {
  return {
    skippedBlocks: cursors.reduce((sum, cursor) => sum + cursor.skippedBlocks, 0),
  };
}

function stableTopK(scores, hits, masks, cursors, minShouldMatch, k) {
  const eligible = collectEligibleScores(scores, hits, minShouldMatch);
  if (eligible.length < k) return null;

  const top = eligible.slice(0, k);
  const topDocs = new Set(top.map(r => r.doc));
  const threshold = top[top.length - 1].score;
  let maxOutsidePotential = remainingPotential(cursors);

  for (const [doc, score] of scores) {
    if (topDocs.has(doc)) continue;
    const potential = score + remainingPotential(cursors, masks.get(doc) || 0);
    if (potential > maxOutsidePotential) maxOutsidePotential = potential;
    if (maxOutsidePotential >= threshold) return null;
  }

  return { top, totalLowerBound: eligible.length };
}

async function rerankWithDependencies(scored, baseTerms, candidateLimit = RERANK_CANDIDATES) {
  const features = dependencyTerms(baseTerms);
  const limit = Math.min(scored.length, candidateLimit);
  const disabledStats = {
    rerankCandidates: limit,
    dependencyFeatures: features.length,
    dependencyTermsMatched: 0,
    dependencyPostingsScanned: 0,
    dependencyCandidateMatches: 0,
  };
  if (!features.length || limit <= 1) return { scored, stats: disabledStats };

  const head = scored.slice(0, limit);
  const tail = scored.slice(limit);
  const candidateScores = new Map(head.map((row, idx) => [
    row.doc,
    { doc: row.doc, score: row.score, originalRank: idx },
  ]));
  const featureWeights = new Map(features.map(feature => [feature.term, feature.weight]));
  let dependencyTermsMatched = 0;
  let dependencyPostingsScanned = 0;
  let dependencyCandidateMatches = 0;

  for (const { term, posting } of await postingsForTerms(features.map(feature => feature.term))) {
    const weight = featureWeights.get(term) || 0;
    if (!weight) continue;
    dependencyTermsMatched++;
    const p = posting.p;
    dependencyPostingsScanned += p.length / 2;
    for (let i = 0; i < p.length; i += 2) {
      const candidate = candidateScores.get(p[i]);
      if (candidate) {
        candidate.score += p[i + 1] * weight;
        dependencyCandidateMatches++;
      }
    }
  }

  head.sort((a, b) => {
    const left = candidateScores.get(a.doc);
    const right = candidateScores.get(b.doc);
    return right.score - left.score || left.originalRank - right.originalRank || a.doc - b.doc;
  });
  for (const row of head) row.score = candidateScores.get(row.doc).score;
  return {
    scored: head.concat(tail),
    stats: {
      rerankCandidates: limit,
      dependencyFeatures: features.length,
      dependencyTermsMatched,
      dependencyPostingsScanned,
      dependencyCandidateMatches,
    },
  };
}

function applyDecodedRows(cursor, rows, scores, hits, masks, passesDoc) {
  const bit = cursor.termIndex < FAST_TOPK_MAX_TERMS ? 2 ** cursor.termIndex : 0;
  let accepted = 0;
  for (const [doc, impact] of rows) {
    if (passesDoc && !passesDoc(doc)) continue;
    scores.set(doc, (scores.get(doc) || 0) + impact);
    if (bit) {
      const mask = masks.get(doc) || 0;
      if (!bitIsSet([mask], cursor.termIndex)) masks.set(doc, mask + bit);
    }
    if (cursor.isBase) hits.set(doc, (hits.get(doc) || 0) + 1);
    accepted++;
  }
  return accepted;
}

async function scorePostingsWithBlocks({ baseTerms, terms, filterPlan = null, passesDoc = null }) {
  const baseTermSet = new Set(baseTerms);
  const entries = await termEntriesForTerms(terms);
  const blockMayPass = filterPlan?.active ? block => blockMatchesFilterPlan(block, filterPlan) : null;
  const cursors = entries.map(({ term, shard, entry }, termIndex) =>
    createPostingCursor(shard, entry, termIndex, baseTermSet.has(term), blockMayPass));
  const scores = new Map();
  const hits = new Map();
  const masks = new Map();
  let blocksDecoded = 0;
  let postingsDecoded = 0;
  let postingsAccepted = 0;

  while (true) {
    let best = null;
    for (const cursor of cursors) {
      const max = cursorRemainingMax(cursor);
      if (max > 0 && (!best || max > best.max)) best = { cursor, max };
    }
    if (!best) break;

    const rows = decodeCursorBlock(best.cursor);
    postingsDecoded += rows.length;
    postingsAccepted += applyDecodedRows(best.cursor, rows, scores, hits, masks, passesDoc);
    blocksDecoded++;
  }

  return {
    scored: collectEligibleScores(scores, hits, minShouldMatchFor(baseTerms)),
    stats: { blocksDecoded, postingsDecoded, postingsAccepted, ...cursorStats(cursors), exact: true },
  };
}

async function fastTopKSearch({ baseTerms, terms, page, size, filterPlan = null, passesDoc = null }) {
  const k = page * size;
  if (!baseTerms.length || k > FAST_TOPK_MAX_RESULTS || terms.length > FAST_TOPK_MAX_TERMS) return null;

  const baseTermSet = new Set(baseTerms);
  const entries = await termEntriesForTerms(terms);
  if (!entries.length || entries.length > FAST_TOPK_MAX_TERMS) return null;

  const blockMayPass = filterPlan?.active ? block => blockMatchesFilterPlan(block, filterPlan) : null;
  const cursors = entries.map(({ term, shard, entry }, termIndex) =>
    createPostingCursor(shard, entry, termIndex, baseTermSet.has(term), blockMayPass));
  const scores = new Map();
  const hits = new Map();
  const masks = new Map();
  const minShouldMatch = minShouldMatchFor(baseTerms);
  let blocksDecoded = 0;
  let postingsDecoded = 0;
  let postingsAccepted = 0;

  while (true) {
    let best = null;
    for (const cursor of cursors) {
      const max = cursorRemainingMax(cursor);
      if (max > 0 && (!best || max > best.max)) best = { cursor, max };
    }
    if (!best) break;

    const cursor = best.cursor;
    const rows = decodeCursorBlock(cursor);
    postingsDecoded += rows.length;
    postingsAccepted += applyDecodedRows(cursor, rows, scores, hits, masks, passesDoc);
    blocksDecoded++;

    if (blocksDecoded % FAST_TOPK_CHECK_BLOCKS === 0) {
      const stable = stableTopK(scores, hits, masks, cursors, minShouldMatch, k);
      if (stable) {
        return {
          scored: stable.top,
          totalLowerBound: stable.totalLowerBound,
          stats: { blocksDecoded, postingsDecoded, postingsAccepted, ...cursorStats(cursors), exact: false },
        };
      }
    }
  }

  const scored = collectEligibleScores(scores, hits, minShouldMatch);
  return {
    scored,
    totalLowerBound: scored.length,
    stats: { blocksDecoded, postingsDecoded, postingsAccepted, ...cursorStats(cursors), exact: true },
  };
}

async function exactSearch({ q, type, year_min, year_max, sort, discipline, source, page, size, rerank = true, baseTermsOverride = null, termsOverride = null }) {
  const query = q && q.trim() ? q.trim() : "";
  const start = (page - 1) * size;
  const baseTerms = baseTermsOverride || tokenize(query);
  const terms = termsOverride || queryTerms(query);
  const codeDataPromise = loadCodes();
  const filtersActive = hasActiveFilters({ type, year_min, year_max, discipline, source });
  const needsCodeBeforeScoring = filtersActive || sort === "year_desc" || sort === "year_asc" || !baseTerms.length;
  const codeData = needsCodeBeforeScoring ? await codeDataPromise : null;
  const filterPlan = filtersActive ? makeFilterPlan({ type, year_min, year_max, discipline, source }) : null;
  const passesFilters = filtersActive
    ? makeFilterPredicate({ type, year_min, year_max, discipline, source }, codeData)
    : () => true;
  let scored = [];
  let searchStats = { exact: true };

  if (!baseTerms.length) {
    scored = allDocIds(manifest.total)
      .filter(passesFilters)
      .map(doc => ({ doc, score: 0 }));
  } else if (filtersActive && filterPlan?.active) {
    const scoredResult = await scorePostingsWithBlocks({
      baseTerms,
      terms,
      filterPlan,
      passesDoc: passesFilters,
    });
    scored = scoredResult.scored;
    searchStats = scoredResult.stats;
  } else {
    const scores = new Map();
    const hits = new Map();
    const baseTermSet = new Set(baseTerms);
    let postingsDecoded = 0;
    for (const { term, posting } of await postingsForTerms(terms)) {
      const p = posting.p;
      postingsDecoded += p.length / 2;
      for (let i = 0; i < p.length; i += 2) {
        const doc = p[i];
        if (!passesFilters(doc)) continue;
        scores.set(doc, (scores.get(doc) || 0) + p[i + 1]);
        if (baseTermSet.has(term)) hits.set(doc, (hits.get(doc) || 0) + 1);
      }
    }
    scored = collectEligibleScores(scores, hits, minShouldMatchFor(baseTerms));
    searchStats = { exact: true, postingsDecoded, postingsAccepted: scored.length };
  }

  const finalCodeData = codeData || await codeDataPromise;
  sortScored(scored, finalCodeData, sort);
  let rerankStats = { rerankCandidates: 0, dependencyFeatures: 0, dependencyTermsMatched: 0, dependencyPostingsScanned: 0, dependencyCandidateMatches: 0 };
  if (rerank && (!sort || sort === "relevance") && baseTerms.length) {
    const reranked = await rerankWithDependencies(scored, baseTerms, Math.max(RERANK_CANDIDATES, start + size));
    scored = reranked.scored;
    rerankStats = reranked.stats;
  }
  const docIds = scored.map(r => r.doc);
  const visible = scored.slice(start, start + size);
  const results = await Promise.all(visible.map(r => loadDoc(r.doc)));

  return {
    total: scored.length,
    results,
    facets: countFacets(docIds, finalCodeData),
    stats: { ...searchStats, ...rerankStats },
  };
}

function shouldTryTypoFallback({ q, sort, page }, response) {
  if (!q || !q.trim() || page !== 1) return false;
  if (sort && sort !== "relevance") return false;
  return (response?.total || 0) < TYPO_FALLBACK_MIN_TOTAL;
}

async function maybeTypoFallback(params, response, baseTerms, analyzedTerms = null) {
  if (!shouldTryTypoFallback(params, response)) return response;
  const presentTerms = new Map((await termEntriesForTerms(baseTerms)).map(item => [item.term, item.entry.df || 0]));
  const correction = await correctedTypoQuery(baseTerms, presentTerms, analyzedTerms);
  if (!correction) {
    return {
      ...response,
      stats: {
        ...(response.stats || {}),
        typoAttempted: true,
        typoApplied: false,
      },
    };
  }

  let best = null;
  for (const plan of correction.plans) {
    const corrected = await exactSearch({
      ...params,
      q: plan.q,
      baseTermsOverride: plan.baseTerms,
      termsOverride: expandedTermsFromBaseTerms(plan.baseTerms),
    });
    const improved = corrected.total > response.total || corrected.results.length > response.results.length;
    if (!improved) continue;
    const value = plan.score + Math.min(corrected.total, 20) * 0.05;
    if (!best || value > best.value) best = { value, plan, response: corrected };
  }

  if (!best) {
    return {
      ...response,
      stats: {
        ...(response.stats || {}),
        typoAttempted: true,
        typoApplied: false,
        ...correction.stats,
      },
    };
  }

  return {
    ...best.response,
    correctedQuery: best.plan.q,
    corrections: best.plan.corrections,
    stats: {
      ...(best.response.stats || {}),
      typoAttempted: true,
      typoApplied: true,
      typoOriginalTotal: response.total,
      typoCorrectedQuery: best.plan.q,
      typoCorrections: best.plan.corrections,
      ...correction.stats,
    },
  };
}

export default {
  label: "tqsearch",
  hasSplash: true,

  async init() {
    manifest = await fetch("./tqsearch/manifest.json").then(r => r.json());
    for (const shard of manifest.shards) availableShards.add(shard);
    return {
      total: manifest.total,
      sources: manifest.facets.source.map(s => ({ id: s.value, name: s.label, n: s.n })),
      builtAt: manifest.built_at,
    };
  },

  async search({ q, type, year_min, year_max, sort, discipline, source, page, size, exact = false, rerank = true }) {
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

    const analyzedTerms = analyzeQuery(query);
    const baseTerms = analyzedTerms.map(item => item.term);
    const terms = expandedTermsFromBaseTerms(baseTerms);
    const filtersActive = hasActiveFilters({ type, year_min, year_max, discipline, source });

    if (!exact && query && page === 1 && (!sort || sort === "relevance")
    ) {
      const codeData = filtersActive ? await loadCodes() : null;
      const filterPlan = filtersActive ? makeFilterPlan({ type, year_min, year_max, discipline, source }) : null;
      const passesFilters = filtersActive
        ? makeFilterPredicate({ type, year_min, year_max, discipline, source }, codeData)
        : null;
      const candidateSize = rerank ? Math.max(size, RERANK_CANDIDATES) : size;
      const fast = await fastTopKSearch({ baseTerms, terms, page, size: candidateSize, filterPlan, passesDoc: passesFilters });
      if (fast && fast.scored.length >= Math.min(size, fast.totalLowerBound) && fast.totalLowerBound >= TYPO_FALLBACK_MIN_TOTAL) {
        const reranked = rerank
          ? await rerankWithDependencies(fast.scored, baseTerms, candidateSize)
          : { scored: fast.scored, stats: { rerankCandidates: 0, dependencyFeatures: 0, dependencyTermsMatched: 0, dependencyPostingsScanned: 0, dependencyCandidateMatches: 0 } };
        const visible = reranked.scored.slice(start, start + size);
        const results = await Promise.all(visible.map(r => loadDoc(r.doc)));
        return {
          total: fast.totalLowerBound,
          approximate: true,
          results,
          facets: manifest.facets,
          stats: { ...fast.stats, ...reranked.stats },
        };
      }
    }

    const response = await exactSearch({ q, type, year_min, year_max, sort, discipline, source, page, size, rerank });
    if (exact) return response;
    return maybeTypoFallback({ q, type, year_min, year_max, sort, discipline, source, page, size, rerank }, response, baseTerms, analyzedTerms);
  },
};
