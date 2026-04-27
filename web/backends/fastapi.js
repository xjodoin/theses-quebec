/**
 * Backend adapter for the FastAPI variant (`api/app.py`).
 *
 * Maps the common UI's `search({q, filters, sort, page, size})` call to the
 * existing /api/search + /api/facets endpoints, normalising the response so
 * common.js doesn't need to know which backend it's talking to.
 */
export default {
  label: "fastapi",
  hasSplash: false,

  async init() {
    const r = await fetch("/api/sources").then(r => r.json());
    const total = r.sources.reduce((a, s) => a + s.n, 0);
    return {
      total,
      sources: r.sources.map(s => ({ id: s.source_id, name: s.source_name, n: s.n })),
      builtAt: null,
    };
  },

  async search({ q, type, year_min, year_max, sort, discipline, source, page, size }) {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (type) p.set("type", type);
    if (year_min) p.set("year_min", year_min);
    if (year_max) p.set("year_max", year_max);
    if (sort && sort !== "relevance") p.set("sort", sort);
    for (const d of discipline) p.append("discipline", d);
    for (const s of source) p.append("source", s);

    const [results, facets] = await Promise.all([
      fetch(`/api/search?${p}&page=${page}&size=${size}`).then(r => r.json()),
      fetch(`/api/facets?${p}`).then(r => r.json()),
    ]);

    return {
      total: results.total,
      results: results.results.map(r => ({
        id: r.oai_identifier,
        title: r.title,
        authors: r.authors,
        abstract: r.abstract,
        year: r.year,
        type: r.type,
        source_id: r.source_id,
        source_name: r.source_name,
        discipline: r.discipline,
        url: r.url,
        excerpt: null,   // FastAPI doesn't generate excerpts; common.js falls back to highlight()
      })),
      facets: {
        discipline: facets.disciplines.map(d => ({ value: d.name, label: d.name, n: d.n })),
        source:     facets.sources.map(s => ({ value: s.id, label: s.name, n: s.n })),
        decade:     facets.decades.map(d => ({ value: d.name, label: d.name, n: d.n })),
      },
    };
  },
};
