/**
 * Shared UI logic for the FastAPI and Pagefind variants. Both HTML pages
 * import this module and pass their backend adapter to bootstrap().
 *
 * The backend adapter is a tiny duck-typed object:
 *
 *   {
 *     label: "fastapi" | "pagefind",
 *     hasSplash: boolean,        // does the HTML have an init splash overlay?
 *     async init(): { total, sources, builtAt? },
 *     async search({...state}): { total, results: [...], facets: {...} },
 *   }
 *
 * Result shape (per-record):
 *   { id, title, authors, abstract, year, type, source_id, source_name,
 *     discipline, url, excerpt }
 *
 * Facet shape (per-field):
 *   { discipline: [{value, label, n}], source: [...], decade: [...] }
 */

// ----------------------------------------------------------- helpers --
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const fmt = (n) => Number(n).toLocaleString("fr-CA");
export const escapeHTML = (s = "") => String(s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TYPE_STYLES = {
  thesis:  { label: "Thèse",   cls: "bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200" },
  memoire: { label: "Mémoire", cls: "bg-sky-100 dark:bg-sky-900/40 text-sky-800 dark:text-sky-200" },
};

/** Strip combining marks + lowercase, building a map from each stripped-text
 *  index back to the index of the corresponding character in `text`. Used by
 *  highlight() so we can match against the diacritic-folded form (what the
 *  search engine indexes) and wrap <mark> around the original (accented)
 *  characters in the displayed string.
 */
function stripWithMap(text) {
  let stripped = "";
  const map = [];                  // stripped[i] ↔ text[map[i]]
  for (let i = 0; i < text.length; i++) {
    const nfd = text[i].normalize("NFD");
    let core = "";
    for (const c of nfd) {
      if (!/[̀-ͯ]/.test(c)) core += c.toLowerCase();
    }
    for (const c of core) { stripped += c; map.push(i); }
  }
  return { stripped, map };
}

const _escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Iterative Levenshtein. Cheap enough for token-vs-vocabulary comparisons
 *  at the scale we use (≤200 vocabulary entries × a handful of tokens). */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Find the closest vocabulary entry for a token within an edit-distance
 *  budget of ~1 typo per 4 chars. Returns null if nothing's close. */
function closestMatch(token, vocabulary) {
  if (token.length < 4) return null;
  const budget = Math.max(1, Math.floor(token.length / 4));
  let best = null, bestDist = budget + 1;
  for (const entry of vocabulary) {
    if (Math.abs(entry.length - token.length) > budget) continue;
    const d = editDistance(token, entry);
    if (d < bestDist) { bestDist = d; best = entry; }
  }
  return best && best !== token ? best : null;
}

/** Build a "did you mean: …" suggestion by token-substituting against the
 *  vocabulary built at bootstrap. */
function didYouMean(query, vocabulary) {
  const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const rawTokens = query.split(/\s+/).filter(Boolean);
  let changed = false;
  const corrected = rawTokens.map(tok => {
    const folded = fold(tok);
    const match = closestMatch(folded, vocabulary);
    if (match && match !== folded) {
      changed = true;
      return match;
    }
    return tok;
  }).join(" ");
  return changed ? corrected : null;
}

function highlight(text, q) {
  if (!text) return "";
  const safe = escapeHTML(text);
  if (!q) return safe;

  const tokens = q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/\s+/).filter(t => t.length >= 2);
  if (!tokens.length) return safe;

  const { stripped, map } = stripWithMap(text);
  const re = new RegExp(tokens.map(_escapeRe).join("|"), "g");

  // Collect [start, end) ranges in the *original* (un-stripped) text.
  const ranges = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }   // safety
    const s = m.index;
    const e = s + m[0].length;
    if (e > map.length) break;
    ranges.push({ start: map[s], end: map[e - 1] + 1 });
  }
  if (!ranges.length) return safe;

  // Stitch the output: alternating plain + <mark>…</mark> from the original.
  let out = "";
  let pos = 0;
  for (const { start, end } of ranges) {
    if (start < pos) continue;     // skip overlapping range (regex shouldn't produce them)
    if (start > pos) out += escapeHTML(text.slice(pos, start));
    out += "<mark>" + escapeHTML(text.slice(start, end)) + "</mark>";
    pos = end;
  }
  if (pos < text.length) out += escapeHTML(text.slice(pos));
  return out;
}

// ----------------------------------------------------------- citations -
function slug(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}
function citeKey(r) {
  const lastname = (r.authors || "").split(/;\s*/)[0]?.split(",")[0] || "record";
  const yr = r.year || "";
  const titleWord = (r.title || "").split(/\s+/).find(w => w.length >= 3) || "";
  return `${slug(lastname)}${yr}${slug(titleWord)}` || "record";
}
function bibtex(r) {
  const type = r.type === "memoire" ? "@mastersthesis" : "@phdthesis";
  const fields = [];
  if (r.authors) fields.push(`  author = {${r.authors.split(/;\s*/).join(" and ")}}`);
  if (r.title)   fields.push(`  title  = {${r.title}}`);
  if (r.year)    fields.push(`  year   = {${r.year}}`);
  if (r.source_name) fields.push(`  school = {${r.source_name}}`);
  fields.push(`  type   = {${r.type === "memoire" ? "Mémoire de maîtrise" : "Thèse de doctorat"}}`);
  if (r.url)     fields.push(`  url    = {${r.url}}`);
  return `${type}{${citeKey(r)},\n${fields.join(",\n")}\n}`;
}
function apa(r) {
  const authors = (r.authors || "").split(/;\s*/).filter(Boolean).map(a => {
    const [last, first = ""] = a.split(",").map(s => s.trim());
    return `${last}, ${first.split(/\s+/).map(w => w[0] ? w[0] + "." : "").join(" ")}`.trim();
  });
  const authorStr = authors.length === 1 ? authors[0]
    : authors.length === 2 ? `${authors[0]}, & ${authors[1]}`
    : authors.length >= 3 ? `${authors.slice(0, -1).join(", ")}, & ${authors[authors.length - 1]}`
    : "";
  const yr = r.year || "s. d.";
  const ttype = r.type === "memoire" ? "Mémoire de maîtrise" : "Thèse de doctorat";
  return `${authorStr} (${yr}). *${r.title || ""}* [${ttype}, ${r.source_name || ""}]. ${r.url || ""}`.trim();
}
function ris(r) {
  const lines = ["TY  - THES"];
  for (const a of (r.authors || "").split(/;\s*/).filter(Boolean)) lines.push(`AU  - ${a}`);
  if (r.title) lines.push(`TI  - ${r.title}`);
  if (r.year)  lines.push(`PY  - ${r.year}`);
  if (r.source_name) lines.push(`PB  - ${r.source_name}`);
  lines.push(`M3  - ${r.type === "memoire" ? "Mémoire de maîtrise" : "Thèse de doctorat"}`);
  if (r.url) lines.push(`UR  - ${r.url}`);
  lines.push("ER  - ");
  return lines.join("\n");
}
const CITERS = { bibtex, apa, ris };

// ----------------------------------------------------------- bootstrap --
export async function bootstrap(backend, options = {}) {
  const state = {
    q: "", type: "", year_min: null, year_max: null, sort: "relevance",
    discipline: new Set(), source: new Set(),
    page: 1, size: 20,
  };
  const facetState = { discFilter: "", discShowAll: false, srcShowAll: false };
  let lastFacets = {};
  // Vocabulary for didYouMean — folded (lowercased + diacritic-stripped) labels
  // from discipline + source facets. Built lazily on the first non-zero search
  // and reused thereafter; stable enough that we don't need to recompute it
  // every keystroke.
  let vocabulary = null;

  // ---------------------------------------------------------- url sync ---
  function readURL() {
    const p = new URLSearchParams(location.search);
    state.q = p.get("q") || "";
    state.type = p.get("type") || "";
    state.year_min = p.get("year_min") ? +p.get("year_min") : null;
    state.year_max = p.get("year_max") ? +p.get("year_max") : null;
    state.sort = p.get("sort") || "relevance";
    state.page = +p.get("page") || 1;
    state.discipline = new Set(p.getAll("discipline"));
    state.source = new Set(p.getAll("source"));
  }
  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.type) p.set("type", state.type);
    if (state.year_min) p.set("year_min", state.year_min);
    if (state.year_max) p.set("year_max", state.year_max);
    if (state.sort && state.sort !== "relevance") p.set("sort", state.sort);
    if (state.page > 1) p.set("page", state.page);
    for (const d of state.discipline) p.append("discipline", d);
    for (const s of state.source) p.append("source", s);
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  // ---------------------------------------------------------- rendering ---
  function renderResults(results) {
    const ul = $("#results");
    ul.innerHTML = "";
    if (!results.length) {
      const suggestion = (state.q && vocabulary) ? didYouMean(state.q, vocabulary) : null;
      const suggestHTML = suggestion ? `
          <p class="text-sm text-ink-600 dark:text-ink-300 mt-3">
            Voulez-vous dire :
            <button data-suggest="${escapeHTML(suggestion)}" class="font-medium text-accent-500 dark:text-accent-300 hover:text-accent-600 dark:hover:text-accent-200 underline decoration-dotted underline-offset-2">« ${escapeHTML(suggestion)} »</button> ?
          </p>` : "";
      ul.innerHTML = `
        <li class="bg-white dark:bg-ink-800 border border-dashed border-ink-300 dark:border-ink-600 rounded-lg p-8 text-center">
          <div class="w-12 h-12 mx-auto rounded-full bg-ink-100 dark:bg-ink-700 grid place-items-center text-ink-400 dark:text-ink-500 mb-3">
            <svg viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5" stroke-linecap="round"/></svg>
          </div>
          <p class="font-medium text-ink-700 dark:text-ink-200">Aucun résultat</p>
          <p class="text-sm text-ink-500 dark:text-ink-400 mt-1">Essayez d'élargir vos critères ou utilisez d'autres mots-clés.</p>${suggestHTML}
          <button onclick="document.getElementById('reset').click()" class="mt-4 text-sm font-medium text-accent-500 dark:text-accent-300 hover:text-accent-600 dark:hover:text-accent-200">Réinitialiser la recherche →</button>
        </li>`;
      const sb = ul.querySelector("[data-suggest]");
      if (sb) sb.addEventListener("click", () => {
        const term = sb.dataset.suggest;
        state.q = term; state.page = 1;
        $("#q").value = term;
        $("#q-clear").classList.toggle("hidden", !term);
        runSearch();
      });
      return;
    }
    const tpl = $("#tmpl-result");
    for (const r of results) {
      const node = tpl.content.cloneNode(true);
      const li = node.querySelector("li");
      li._record = r;

      const ts = TYPE_STYLES[r.type] || { label: r.type || "Document", cls: "bg-ink-100 dark:bg-ink-700 text-ink-700 dark:text-ink-200" };
      const tb = li.querySelector("[data-type-badge]");
      tb.textContent = ts.label;
      tb.className += " " + ts.cls;
      li.querySelector("[data-discipline]").textContent = r.discipline || "Non classé";

      const link = li.querySelector("[data-link]");
      link.href = r.url || "#";
      link.innerHTML = highlight(r.title || "(sans titre)", state.q);

      const authors = li.querySelector("[data-authors]");
      authors.innerHTML = r.authors
        ? highlight((r.authors.split(/;\s*/).slice(0, 4).join(" · ")), state.q)
        : '<span class="text-ink-400 dark:text-ink-500 italic">auteur·rice non renseigné</span>';

      const ab = li.querySelector("[data-abstract]");
      if (r.excerpt) ab.innerHTML = r.excerpt;
      else if (r.abstract) ab.innerHTML = highlight(r.abstract, state.q);
      else ab.remove();

      li.querySelector("[data-source]").textContent = r.source_name || "";
      li.querySelector("[data-year]").textContent = r.year || "—";
      li.querySelector("[data-open]").href = r.url || "#";
      ul.appendChild(node);
    }
  }

  function renderPager(total, page, size) {
    const pager = $("#pager");
    pager.innerHTML = "";
    const totalPages = Math.max(1, Math.ceil(total / size));
    if (totalPages <= 1) { $("#page-info").textContent = ""; return; }
    $("#page-info").textContent = `Page ${page} sur ${fmt(totalPages)}`;
    const mk = (label, p, opts = {}) => {
      const b = document.createElement("button");
      b.innerHTML = label;
      b.disabled = !!opts.disabled;
      if (opts.ariaLabel) b.setAttribute("aria-label", opts.ariaLabel);
      b.className = "min-w-[2.25rem] h-9 px-3 rounded-md text-sm font-medium transition " +
        (opts.active ? "bg-ink-900 dark:bg-ink-700 text-white shadow-card"
          : opts.disabled ? "text-ink-300 dark:text-ink-600 cursor-not-allowed"
            : "text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-700");
      if (!opts.disabled && !opts.active) {
        b.onclick = () => { state.page = p; runSearch(); window.scrollTo({ top: 0, behavior: "smooth" }); };
      }
      return b;
    };
    pager.appendChild(mk("‹ Précédent", Math.max(1, page - 1), { disabled: page === 1, ariaLabel: "Page précédente" }));
    const win = 1, pages = new Set([1, totalPages, page]);
    for (let i = page - win; i <= page + win; i++) if (i > 0 && i <= totalPages) pages.add(i);
    let prev = 0;
    for (const p of [...pages].sort((a, b) => a - b)) {
      if (p - prev > 1) pager.appendChild(Object.assign(document.createElement("span"), { textContent: "…", className: "px-1 text-ink-400 dark:text-ink-500" }));
      pager.appendChild(mk(p, p, { active: p === page, ariaLabel: `Page ${p}` }));
      prev = p;
    }
    pager.appendChild(mk("Suivante ›", Math.min(totalPages, page + 1), { disabled: page === totalPages, ariaLabel: "Page suivante" }));
  }

  function renderFacets(facets) {
    lastFacets = facets;

    // discipline (with text filter input + show-more toggle)
    const discAll = (facets.discipline || []).filter(d =>
      !facetState.discFilter ||
      d.label.toLowerCase().includes(facetState.discFilter.toLowerCase()));
    const discVisible = facetState.discShowAll ? discAll : discAll.slice(0, 8);
    const discEl = $("#facet-disciplines");
    discEl.innerHTML = "";
    for (const it of discVisible) discEl.appendChild(facetRow(it.value, it.n, state.discipline, "disc", it.label));
    if (discAll.length > 8) {
      const btn = document.createElement("button");
      btn.className = "text-xs text-accent-500 dark:text-accent-300 hover:text-accent-600 dark:hover:text-accent-200 font-medium px-2 py-1 mt-1";
      btn.textContent = facetState.discShowAll ? "↑ moins de disciplines" : `+ ${discAll.length - 8} disciplines`;
      btn.onclick = () => { facetState.discShowAll = !facetState.discShowAll; renderFacets(lastFacets); };
      discEl.appendChild(btn);
    }
    if (!discAll.length) {
      discEl.innerHTML = `<p class="text-xs text-ink-400 dark:text-ink-500 italic px-2">Aucune discipline correspondant à "${escapeHTML(facetState.discFilter)}"</p>`;
    }
    updateFacetBadge("#disc-active", state.discipline.size);

    // sources
    const srcAll = facets.source || [];
    const srcVisible = facetState.srcShowAll ? srcAll : srcAll.slice(0, 8);
    const srcEl = $("#facet-sources");
    srcEl.innerHTML = "";
    for (const it of srcVisible) srcEl.appendChild(facetRow(it.value, it.n, state.source, "src", it.label));
    if (srcAll.length > 8) {
      const btn = document.createElement("button");
      btn.className = "text-xs text-accent-500 dark:text-accent-300 hover:text-accent-600 dark:hover:text-accent-200 font-medium px-2 py-1 mt-1";
      btn.textContent = facetState.srcShowAll ? "↑ moins" : `+ ${srcAll.length - 8} dépôts`;
      btn.onclick = () => { facetState.srcShowAll = !facetState.srcShowAll; renderFacets(lastFacets); };
      srcEl.appendChild(btn);
    }
    updateFacetBadge("#src-active", state.source.size);

    // decades — horizontal bar chart, one row per decade, sorted chronologically.
    // Bar width is proportional to the largest decade in the current result
    // set; clicking a row toggles a year-range filter on that decade.
    const decEl = $("#facet-decades");
    decEl.innerHTML = "";
    const decades = (facets.decade || []).slice().sort((a, b) => a.value.localeCompare(b.value));
    const maxN = decades.reduce((m, d) => Math.max(m, d.n), 0) || 1;
    for (const d of decades) {
      const start = parseInt(d.value, 10);
      const active = state.year_min === start && state.year_max === start + 9;
      const pct = Math.max(2, Math.round((d.n / maxN) * 100));
      const b = document.createElement("button");
      b.className = "w-full text-left rounded px-2 py-1 transition group " +
        (active ? "bg-ink-800 dark:bg-ink-600 text-white"
          : "hover:bg-ink-100 dark:hover:bg-ink-700 text-ink-700 dark:text-ink-200");
      b.setAttribute("aria-pressed", String(active));
      b.setAttribute("aria-label", `Décennie ${d.label}, ${d.n} résultats`);
      const barColor = active
        ? "bg-white/30"
        : "bg-accent-200/70 dark:bg-accent-300/30 group-hover:bg-accent-300/80 dark:group-hover:bg-accent-300/40";
      const countColor = active ? "text-ink-100" : "text-ink-500 dark:text-ink-400";
      b.innerHTML = `
        <div class="flex items-baseline justify-between text-xs mb-0.5">
          <span class="tabular-nums">${escapeHTML(d.label)}</span>
          <span class="tabular-nums ${countColor}">${fmt(d.n)}</span>
        </div>
        <div class="h-1.5 rounded-full bg-ink-100/70 dark:bg-ink-700/70 overflow-hidden">
          <div class="h-full ${barColor} rounded-full transition-all" style="width: ${pct}%"></div>
        </div>`;
      b.onclick = () => {
        if (active) { state.year_min = state.year_max = null; }
        else { state.year_min = start; state.year_max = start + 9; }
        $("#year_min").value = state.year_min || "";
        $("#year_max").value = state.year_max || "";
        state.page = 1;
        runSearch();
      };
      decEl.appendChild(b);
    }
  }

  function facetRow(value, count, set, key, label = value) {
    const id = `${key}-${value}`.replace(/\W+/g, "-");
    const checked = set.has(value);
    const row = document.createElement("label");
    row.className = "flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-ink-100 dark:hover:bg-ink-700 group";
    row.innerHTML = `<input type="checkbox" id="${id}" ${checked ? "checked" : ""} class="rounded border-ink-300 dark:border-ink-600 dark:bg-ink-800 text-accent-500 focus:ring-accent-300 focus:ring-offset-0">
      <span class="flex-1 min-w-0 truncate ${checked ? "font-medium text-ink-900 dark:text-ink-50" : "text-ink-700 dark:text-ink-200"}">${escapeHTML(label)}</span>
      <span class="text-xs ${checked ? "text-accent-500 dark:text-accent-300 font-medium" : "text-ink-400 dark:text-ink-500"} tabular-nums">${fmt(count)}</span>`;
    row.querySelector("input").onchange = (ev) => {
      if (ev.target.checked) set.add(value); else set.delete(value);
      state.page = 1;
      runSearch();
    };
    return row;
  }

  function updateFacetBadge(sel, n) {
    const el = $(sel); if (!el) return;
    if (n > 0) { el.textContent = n; el.classList.remove("hidden"); } else el.classList.add("hidden");
  }

  function renderActiveChips() {
    const c = $("#active-chips");
    c.innerHTML = "";
    const chips = [];
    if (state.q) chips.push({ label: `« ${state.q} »`, on: () => { state.q = ""; $("#q").value = ""; } });
    if (state.type) chips.push({ label: state.type === "thesis" ? "Thèses" : "Mémoires",
                                 on: () => { state.type = ""; updateTypeButtons(); } });
    for (const d of state.discipline) chips.push({ label: d, on: () => state.discipline.delete(d) });
    for (const s of state.source) chips.push({ label: s, on: () => state.source.delete(s) });
    if (state.year_min || state.year_max) chips.push({
      label: `${state.year_min || "…"} – ${state.year_max || "…"}`,
      on: () => { state.year_min = state.year_max = null; $("#year_min").value = ""; $("#year_max").value = ""; },
    });
    for (const x of chips) {
      const b = document.createElement("button");
      b.className = "inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 hover:border-ink-300 dark:hover:border-ink-600 text-ink-700 dark:text-ink-200 text-xs";
      b.innerHTML = `${escapeHTML(x.label)}<span class="text-ink-400 dark:text-ink-500">×</span>`;
      b.onclick = () => { x.on(); state.page = 1; runSearch(); };
      c.appendChild(b);
    }
    $("#active-filters").classList.toggle("hidden", chips.length === 0);
  }

  function updateTypeButtons() {
    $$(".type-btn").forEach(b => {
      const a = b.dataset.type === state.type;
      b.classList.toggle("bg-ink-800", a);
      b.classList.toggle("dark:bg-ink-700", a);
      b.classList.toggle("text-white", a);
      b.classList.toggle("hover:bg-ink-100", !a);
      b.classList.toggle("dark:hover:bg-ink-700", !a);
      b.setAttribute("aria-selected", String(a));
    });
  }

  // ---------------------------------------------------------- detail modal --
  function openDetailModal(record) {
    const modal = $("#detail-modal");
    if (!modal) return;
    modal._currentRecord = record;

    const setVal = (sel, v) => { const el = $(sel, modal); if (el) el.textContent = v ?? ""; };
    const setHref = (sel, v) => { const el = $(sel, modal); if (el && v) el.href = v; };

    setVal("[data-title]", record.title || "(sans titre)");
    const tb = $("[data-type-badge]", modal);
    if (tb) {
      const ts = TYPE_STYLES[record.type] || TYPE_STYLES.thesis;
      tb.textContent = ts.label;
      tb.className = (tb.className.split(" ").filter(c => !c.startsWith("bg-") && !c.startsWith("text-") && !c.includes("dark:")).join(" ") + " " + ts.cls).trim();
    }
    setVal("[data-discipline]", record.discipline || "Non classé");
    setVal("[data-authors]", record.authors || "—");
    const ttype = record.type === "memoire" ? "Mémoire de maîtrise" : "Thèse de doctorat";
    setVal("[data-meta]", [record.source_name, record.year, ttype].filter(Boolean).join(" · "));
    setVal("[data-abstract]", record.abstract || "(résumé non disponible)");
    setHref("[data-source-url]", record.url);
    buildCitation(record);

    modal.classList.remove("hidden");
    document.body.classList.add("overflow-hidden");
    modal.dataset.lastFocus = document.activeElement?.id || "";
    setTimeout(() => $("[data-close]", modal)?.focus(), 0);
  }
  function closeDetailModal() {
    const modal = $("#detail-modal");
    if (!modal || modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    document.body.classList.remove("overflow-hidden");
    const lf = modal.dataset.lastFocus;
    if (lf) document.getElementById(lf)?.focus();
  }
  function buildCitation(r) {
    const modal = $("#detail-modal");
    const fmt = (localStorage.getItem("tq:cite-format") || "bibtex");
    $$(".cite-tab", modal).forEach(b => {
      const active = b.dataset.citeFmt === fmt;
      b.classList.toggle("bg-ink-200", active);
      b.classList.toggle("dark:bg-ink-700", active);
    });
    const out = $("[data-cite-output]", modal);
    if (out) out.textContent = (CITERS[fmt] || bibtex)(r);
  }

  // ---------------------------------------------------------- core loop --
  let lastSearchToken = 0;
  async function runSearch() {
    writeURL();
    renderActiveChips();
    $("#results").innerHTML = "<li class=\"bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-5 space-y-3\">"
      + "<div class=\"skeleton h-5 w-3/4 rounded\"></div>"
      + "<div class=\"skeleton h-4 w-1/3 rounded\"></div>"
      + "<div class=\"skeleton h-4 w-full rounded\"></div></li>".repeat(5);
    $("#status").innerHTML = `<span class="skeleton inline-block w-32 h-4 rounded align-middle"></span>`;

    const t0 = performance.now();
    const myToken = ++lastSearchToken;
    let response;
    try {
      response = await backend.search({ ...state });
    } catch (err) {
      if (myToken !== lastSearchToken) return;
      $("#status").innerHTML = `<span class="text-red-600 dark:text-red-400">Erreur : ${escapeHTML(err.message)}</span>`;
      console.error(err);
      return;
    }
    if (myToken !== lastSearchToken) return;   // a newer search has started

    const dt = (performance.now() - t0).toFixed(0);
    $("#status").innerHTML =
      `<span class="font-medium text-ink-900 dark:text-ink-50">${fmt(response.total)}</span> ` +
      `${response.total === 1 ? "résultat" : "résultats"}` +
      (state.q ? ` pour <span class="text-ink-900 dark:text-ink-50">« ${escapeHTML(state.q)} »</span>` : "") +
      ` <span class="text-ink-400 dark:text-ink-500">· ${dt} ms</span>`;

    // Build the didYouMean vocabulary from the first non-empty facets we see.
    // Discipline + source labels are the most useful corrections; we also
    // sprinkle in tokens that appear inside multi-word labels so a typo in
    // "psychologie" still maps even when the full label is "Psychologie".
    if (!vocabulary && response.facets) {
      const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const set = new Set();
      const harvest = (arr) => {
        for (const it of (arr || [])) {
          for (const tok of fold(it.label).split(/[^a-z0-9]+/)) {
            if (tok.length >= 4) set.add(tok);
          }
        }
      };
      harvest(response.facets.discipline);
      harvest(response.facets.source);
      if (set.size) vocabulary = [...set];
    }

    renderResults(response.results);
    renderPager(response.total, state.page, state.size);
    renderFacets(response.facets);
  }

  // ---------------------------------------------------------- wiring -----
  let qTimer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    $("#q-clear").classList.toggle("hidden", !e.target.value);
    qTimer = setTimeout(() => { state.q = e.target.value; state.page = 1; runSearch(); }, 200);
  });
  $("#q-clear").addEventListener("click", () => {
    $("#q").value = ""; state.q = ""; state.page = 1;
    $("#q-clear").classList.add("hidden"); runSearch();
  });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; state.page = 1; runSearch(); });
  $("#year_min").addEventListener("change", (e) => { state.year_min = e.target.value ? +e.target.value : null; state.page = 1; runSearch(); });
  $("#year_max").addEventListener("change", (e) => { state.year_max = e.target.value ? +e.target.value : null; state.page = 1; runSearch(); });
  $$(".type-btn").forEach(b => b.addEventListener("click", () => {
    state.type = b.dataset.type; state.page = 1; updateTypeButtons(); runSearch();
  }));
  $("#disc-search").addEventListener("input", (e) => {
    facetState.discFilter = e.target.value;
    renderFacets(lastFacets);
  });
  $("#reset").addEventListener("click", () => {
    state.q = ""; state.type = ""; state.year_min = null; state.year_max = null;
    state.discipline.clear(); state.source.clear(); state.sort = "relevance"; state.page = 1;
    $("#q").value = ""; $("#year_min").value = ""; $("#year_max").value = ""; $("#sort").value = "relevance";
    $("#q-clear").classList.add("hidden");
    facetState.discFilter = ""; $("#disc-search").value = "";
    facetState.discShowAll = false; facetState.srcShowAll = false;
    updateTypeButtons(); runSearch();
  });

  // Copy link button
  const copyLinkBtn = $("#copy-link");
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(location.href); } catch { return; }
      const orig = copyLinkBtn.dataset.copyLabel || copyLinkBtn.textContent;
      copyLinkBtn.dataset.copyLabel = orig;
      copyLinkBtn.textContent = "Copié !";
      setTimeout(() => { copyLinkBtn.textContent = orig; }, 1500);
    });
  }

  // Result card click → detail modal.
  // Exceptions:
  //   - clicking the small "ouvrir ↗" link (`[data-open]`) navigates to the
  //     source page (it's the explicit "I want to leave" gesture)
  //   - clicking a chip / button (filter chips) lets that handler fire
  //   - selecting text doesn't trigger
  // The title link `[data-link]` *does* open the modal — we cancel its
  // default navigation. Right-click and Cmd/Ctrl+click still respect the
  // href so users can open the source in a new tab if they want.
  $("#results").addEventListener("click", (e) => {
    if (e.target.closest("[data-open]")) return;
    if (e.target.closest("button")) return;
    if (window.getSelection?.()?.toString().length > 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    if (e.target.closest("[data-link]")) e.preventDefault();
    const li = e.target.closest("li");
    if (li?._record) openDetailModal(li._record);
  });
  $("#results").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("[data-open], button, input, textarea, select")) return;
    const li = e.target.closest("li");
    if (li?._record) { e.preventDefault(); openDetailModal(li._record); }
  });

  // Detail modal
  const detailModal = $("#detail-modal");
  if (detailModal) {
    // Close on overlay click or close-button click. Note `data-close` lives
    // on the X button; `data-overlay` on the dim backdrop.
    detailModal.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]") || e.target.matches("[data-overlay]")) {
        closeDetailModal();
      }
    });
    $$(".cite-tab", detailModal).forEach(b => b.addEventListener("click", () => {
      localStorage.setItem("tq:cite-format", b.dataset.citeFmt);
      if (detailModal._currentRecord) buildCitation(detailModal._currentRecord);
    }));
    const copyCite = $("[data-cite-copy]", detailModal);
    const copyLabel = $("[data-cite-copy-label]", detailModal);
    if (copyCite) copyCite.addEventListener("click", async () => {
      const txt = $("[data-cite-output]", detailModal)?.textContent || "";
      try { await navigator.clipboard.writeText(txt); } catch { return; }
      if (copyLabel) {
        const orig = copyLabel.textContent;
        copyLabel.textContent = "Copié !";
        setTimeout(() => { copyLabel.textContent = orig; }, 1500);
      }
    });
  }

  // Mobile drawer
  $("#open-filters-mobile")?.addEventListener("click", () => {
    $("#sidebar").classList.remove("-translate-x-full");
    $("#sidebar-backdrop").classList.remove("hidden");
  });
  function closeDrawer() {
    $("#sidebar").classList.add("-translate-x-full");
    $("#sidebar-backdrop").classList.add("hidden");
  }
  $("#close-filters-mobile")?.addEventListener("click", closeDrawer);
  $("#sidebar-backdrop")?.addEventListener("click", closeDrawer);

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      e.preventDefault(); $("#q").focus();
    }
    if (e.key === "Escape") {
      if (detailModal && !detailModal.classList.contains("hidden")) { closeDetailModal(); return; }
      if (document.activeElement === $("#q")) {
        $("#q").blur();
        if ($("#q").value) { $("#q").value = ""; state.q = ""; state.page = 1; runSearch(); }
      }
    }
  });

  // Theme toggle
  const themeToggle = $("#theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const cur = document.documentElement.classList.contains("dark") ? "dark" : "light";
      const next = cur === "dark" ? "light" : "dark";
      if (next === "dark") document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
      localStorage.setItem("tq:theme", next);
    });
  }

  // ---------------------------------------------------------- bootstrap --
  function syncFormFromState() {
    $("#q").value = state.q;
    $("#year_min").value = state.year_min || "";
    $("#year_max").value = state.year_max || "";
    $("#sort").value = state.sort;
    $("#q-clear").classList.toggle("hidden", !state.q);
    updateTypeButtons();
  }

  readURL();
  if (backend.hasSplash && $("#splash-status")) {
    $("#splash-status").textContent = "Chargement de l'index…";
  }
  let init;
  try {
    init = await backend.init();
  } catch (err) {
    if ($("#splash-status")) {
      $("#splash-status").innerHTML = `<span class="text-red-600 dark:text-red-400">Erreur : ${escapeHTML(err.message)}</span>`;
    }
    console.error(err);
    return;
  }

  // header totals
  if (init.total !== undefined) {
    $("#totals").innerHTML =
      `<span class="font-medium text-ink-700 dark:text-ink-200">${fmt(init.total)}</span> thèses` +
      `<span class="text-ink-300 dark:text-ink-600 mx-1.5">·</span>` +
      `<span class="font-medium text-ink-700 dark:text-ink-200">${init.sources.length}</span> dépôts`;
  }
  const footerSrc = $("#footer-sources");
  if (footerSrc && init.sources) footerSrc.textContent = init.sources.map(s => s.name).join(" · ");
  const footerBuilt = $("#footer-built");
  if (footerBuilt && init.builtAt) {
    const d = new Date(init.builtAt).toLocaleDateString("fr-CA", { year: "numeric", month: "long", day: "numeric" });
    footerBuilt.textContent = `Index construit le ${d}.`;
  }

  if ($("#splash")) $("#splash").style.display = "none";
  if ($("#q").disabled) $("#q").disabled = false;
  syncFormFromState();
  await runSearch();
}
