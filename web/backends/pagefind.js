/**
 * Backend adapter for the Pagefind static variant.
 *
 * Loads the chunked WASM index from /pagefind/, then maps common.js's search
 * call onto pagefind.search(...) + pagefind.filters(). Returns the same shape
 * as the FastAPI backend so common.js doesn't have to know which one is wired.
 */

let pagefind = null;
let meta = null;

const SOURCE_NAMES = new Map();

function firstFilterValue(filters, field) {
  const value = filters?.[field];
  if (Array.isArray(value)) return value[0] || null;
  if (typeof value === "string") return value;
  return null;
}

export default {
  label: "pagefind",
  hasSplash: true,

  async init() {
    // backends/pagefind.js → ../pagefind/pagefind.js (sibling of the HTML)
    pagefind = await import("../pagefind/pagefind.js");
    await pagefind.init();
    await pagefind.options({ excerptLength: 30 });
    meta = await fetch("./meta.json").then(r => r.json());
    for (const s of meta.sources) SOURCE_NAMES.set(s.id, s.name);
    return {
      total: meta.total,
      sources: meta.sources,
      builtAt: meta.built_at,
    };
  },

  async search({ q, type, year_min, year_max, sort, discipline, source, page, size }) {
    const filters = {};
    if (type) filters.type = type;
    if (discipline.size) filters.discipline = { any: [...discipline] };
    if (source.size) filters.source = { any: [...source] };
    if (year_min || year_max) {
      const lo = Math.max(1900, year_min || 1900);
      const hi = Math.min(2099, year_max || 2099);
      const decades = [];
      for (let d = Math.floor(lo / 10) * 10; d <= hi; d += 10) decades.push(`${d}s`);
      if (decades.length) filters.decade = { any: decades };
    }

    const opts = {};
    if (Object.keys(filters).length) opts.filters = filters;
    if (sort === "year_desc") opts.sort = { year: "desc" };
    else if (sort === "year_asc") opts.sort = { year: "asc" };

    const query = q && q.trim() ? q.trim() : null;
    const start = (page - 1) * size;
    const isDefaultSearch = !query
      && !Object.keys(filters).length
      && (!sort || sort === "relevance")
      && start + size <= (meta.initial_results?.length || 0);

    if (isDefaultSearch) {
      return {
        total: meta.total,
        results: meta.initial_results.slice(start, start + size),
        facets: meta.facets,
      };
    }

    // Search + global facet counts in parallel. search.filters is empty when
    // query is null; pagefind.filters() always returns a non-empty map.
    const [search, allFilters] = await Promise.all([
      pagefind.search(query, opts),
      pagefind.filters(),
    ]);

    const total = search.results.length;
    const visible = search.results.slice(start, start + size);
    const data = await Promise.all(visible.map(r => r.data()));

    const results = data.map((d, i) => {
      const m = d.meta || {};
      const sourceId = firstFilterValue(d.filters, "source");
      const typeValue = firstFilterValue(d.filters, "type");
      const disciplineValue = firstFilterValue(d.filters, "discipline");
      return {
        id: search.results[start + i].id,
        title: m.title,
        authors: m.authors,
        advisors: m.advisors || null,
        abstract: m.has_abstract === "1" ? (d.content || null) : null,
        year: m.year ? Number(m.year) : null,
        type: typeValue,
        source_id: sourceId,
        source_name: SOURCE_NAMES.get(sourceId) || sourceId,
        discipline: disciplineValue,
        url: d.url,
        excerpt: d.excerpt || null,
      };
    });

    const map = (search.filters && Object.keys(search.filters).length)
      ? search.filters : (allFilters || {});

    function toFacet(field, labelFn = v => v) {
      const m = map[field] || {};
      return Object.entries(m)
        .map(([value, n]) => ({ value, label: labelFn(value), n }))
        .sort((a, b) => b.n - a.n);
    }

    return {
      total,
      results,
      facets: {
        discipline: toFacet("discipline"),
        source: toFacet("source", id => SOURCE_NAMES.get(id) || id),
        decade: toFacet("decade").sort((a, b) => a.value.localeCompare(b.value)),
      },
    };
  },
};
