/**
 * Word-by-word substring search over layer and provider text.
 *
 * A bare query is split on whitespace and every term must appear somewhere in
 * the haystack as a substring, in any order: `vier cbs` matches
 * "CBS Vierkant 100m 2022". Terms are substrings rather than whole words
 * because the useful prefixes here are fragments — `vier`, `inw`, `dichtst`.
 *
 * Double quotes make a phrase, matched with its spaces intact: `"vier cbs"`
 * matches only that literal sequence. An unbalanced quote is treated as if it
 * were closed at the end of the query, so the filter keeps working while the
 * user is still typing the closing quote.
 */

/** Query text -> terms. Each term is a substring the haystack must contain. */
export function parseQuery(query) {
    const terms = [];
    const re = /"([^"]*)"?|(\S+)/g;
    for (let m; (m = re.exec(query ?? '')) !== null;) {
        const term = (m[1] ?? m[2] ?? '').trim().toLowerCase();
        if (term) terms.push(term);
    }
    return terms;
}

/** True when every term appears in `text`. No terms means no filtering. */
export function matchesTerms(text, terms) {
    if (!terms.length) return true;
    const hay = String(text ?? '').toLowerCase();
    return terms.every(t => hay.includes(t));
}

/** Join the fields a query should search, skipping empties. */
export function searchText(...fields) {
    return fields.flat().filter(Boolean).join(' ');
}

/** Filter `items` by `query`, reading each item's text with `textOf`. */
export function filterByQuery(items, query, textOf) {
    const terms = parseQuery(query);
    if (!terms.length) return items;
    return items.filter(item => matchesTerms(textOf(item), terms));
}
