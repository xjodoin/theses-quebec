/**
 * Benchmark adapter for the standalone Rangefind package.
 *
 * This is intentionally not the production backend. It lets the shared
 * benchmark runners compare the extracted open-source engine against the
 * thesis-specific tqsearch implementation.
 */

import { createSearch } from "../rangefind-lib/runtime.js";

let engine = null;
let manifest = null;

function facet(name) {
  return manifest?.facets?.[name] || [];
}

function globalFacets() {
  return {
    discipline: facet("discipline"),
    source: facet("source_id"),
    decade: facet("decade").slice().sort((a, b) => a.value.localeCompare(b.value)),
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
  };
}

export default {
  label: "rangefind",
  hasSplash: true,

  async init() {
    engine = await createSearch({ baseUrl: new URL("./rangefind/", location.href).href });
    manifest = engine.manifest;
    return {
      total: manifest.total,
      sources: facet("source_id").map(s => ({ id: s.value, name: s.label, n: s.n })),
      builtAt: manifest.built_at,
    };
  },

  async search({ q, type, year_min, year_max, discipline, source, page, size }) {
    const filters = { facets: {}, numbers: {} };
    if (type) filters.facets.type = [type];
    if (discipline?.size) filters.facets.discipline = [...discipline];
    if (source?.size) filters.facets.source_id = [...source];
    if (year_min || year_max) filters.numbers.year = {
      min: year_min || undefined,
      max: year_max || undefined,
    };

    const response = await engine.search({
      q: q || "",
      page,
      size,
      filters,
    });

    return {
      total: response.total,
      correctedQuery: response.correctedQuery || null,
      corrections: response.corrections || null,
      results: response.results.map(resultRow),
      facets: globalFacets(),
      stats: response.stats || {},
    };
  },
};
