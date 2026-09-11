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

/**
 * Query text -> terms, keeping whether each was quoted.
 *
 * A quoted term is a phrase: it must appear with its spaces intact, which only
 * real layer text can satisfy. A caller holding just a summary of the text
 * (a deduplicated word list, say) cannot honour one and must say so rather
 * than match the phrase against words that happen to sit next to each other.
 */
export function parseTerms(query) {
    const terms = [];
    const re = /"([^"]*)"?|(\S+)/g;
    for (let m; (m = re.exec(query ?? '')) !== null;) {
        const text = (m[1] ?? m[2] ?? '').trim().toLowerCase();
        if (text) terms.push({ text, phrase: m[1] !== undefined });
    }
    return terms;
}

/** Query text -> terms. Each term is a substring the haystack must contain. */
export function parseQuery(query) {
    return parseTerms(query).map(t => t.text);
}

/** True when the query asks for a phrase, which needs the full layer text. */
export function hasPhrase(query) {
    return parseTerms(query).some(t => t.phrase);
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

/**
 * Filter `items` by `query`, reading each item's text with `textOf`.
 *
 * `phraseTextOf`, when given, returns the item's full, unsummarised text and is
 * used for quoted terms only. Without it a quoted term falls back to `textOf`,
 * which is right when that text is real prose and wrong when it is a word list
 * — so callers holding a summary pass the full text here.
 */
export function filterByQuery(items, query, textOf, phraseTextOf = null) {
    const terms = parseTerms(query);
    if (!terms.length) return items;
    const plain = terms.filter(t => !t.phrase).map(t => t.text);
    const phrases = terms.filter(t => t.phrase).map(t => t.text);
    return items.filter(item => {
        if (!matchesTerms(textOf(item), plain)) return false;
        if (!phrases.length) return true;
        return matchesTerms(phraseTextOf ? phraseTextOf(item) : textOf(item), phrases);
    });
}
