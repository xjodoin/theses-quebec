/**
 * Production search backend: Rangefind static index over HTTP range requests.
 *
 * The index is built by scripts/build_rangefind.mjs from data/theses.db.
 * This adapter maps the shared UI's query state (web/common.js) onto the
 * Rangefind runtime and exposes facet counts and autocomplete.
 */

import { createSearch } from "../rangefind/runtime.browser.js";

let engine = null;
let manifest = null;
let globalFacetCache = null;

// The generational engine merges facet counts across generations, so an
// empty-query facet request yields the corpus-wide distribution. Requested
// once at init and reused for the sidebar (query-independent, matching the
// UI's existing behavior). size is generous so every discipline/source shows.
async function loadGlobalFacets() {
  const response = await engine.search({
    q: "",
    size: 1,
    facets: { fields: ["discipline", "source_id", "decade", "type"], size: 500 },
  });
  const map = (field) => (response.facets?.[field]?.values || [])
    .map((v) => ({ value: v.value, label: v.label, n: v.count }));
  globalFacetCache = {
    discipline: map("discipline"),
    source: map("source_id"),
    decade: map("decade").slice().sort((a, b) => a.value.localeCompare(b.value)),
    type: map("type"),
  };
}

function resultRow(row) {
  return {
    id: String(row.id),
    title: row.title,
    authors: row.authors || "",
    advisors: row.advisors || null,
    abstract: row.abstract || null,
    year: row.year ? Number(row.year) : null,
    type: row.type || "",
    source_id: row.source_id || "",
    source_name: row.source_name || row.source_id || "",
    discipline: row.discipline || "",
    url: row.url || "",
    excerpt: null,
    score: row.score,
    highlights: row.highlights || null,
  };
}

export default {
  label: "rangefind",
  hasSplash: true,

  async init() {
    engine = await createSearch({ baseUrl: new URL("./rangefind/", location.href).href });
    manifest = engine.manifest;
    await loadGlobalFacets();
    return {
      total: manifest.total,
      sources: (globalFacetCache.source || []).map((s) => ({ id: s.value, name: s.label, n: s.n })),
      builtAt: manifest.built_at || manifest.builtAt || null,
    };
  },

  // Type-ahead suggestions (titles, author names, disciplines).
  async suggest(q) {
    if (typeof engine?.suggest !== "function") return [];
    const response = await engine.suggest({ q, size: 8 });
    return (response.suggestions || []).map((s) => s.text);
  },

  async search({ q, type, year_min, year_max, discipline, source, page, size, exact }) {
    const filters = { facets: {}, numbers: {} };
    if (type) filters.facets.type = [type];
    if (discipline?.size) filters.facets.discipline = [...discipline];
    if (source?.size) filters.facets.source_id = [...source];
    if (year_min || year_max) {
      filters.numbers.year = { min: year_min || undefined, max: year_max || undefined };
    }

    const response = await engine.search({
      q: q || "",
      page,
      size,
      filters,
      exact,
      highlight: q ? { fields: ["title", "abstract"], maxChars: 260 } : undefined,
    });

    return {
      total: response.total,
      approximate: !!response.approximate,
      correctedQuery: response.correctedQuery || null,
      corrections: response.corrections || null,
      results: response.results.map(resultRow),
      facets: globalFacetCache,
      stats: response.stats || {},
    };
  },
};
