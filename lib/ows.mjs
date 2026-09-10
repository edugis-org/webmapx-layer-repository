/**
 * Splitting an OWS URL into an endpoint and a request.
 *
 * A GetCapabilities URL is an endpoint plus a request, and harvesting needs the
 * endpoint back so it can compose GetMap, GetFeature and GetFeatureInfo of its
 * own. Cutting at the "?" is the obvious way and the wrong one: plenty of
 * services put something load-bearing in the query string. MapServer addresses a
 * whole mapfile that way (?map=/srv/data/x.map), and a service may equally carry
 * a key, a ref, an instance id or anything else its operator invented. Drop it
 * and the endpoint stops being that service — it becomes a 404, or somebody
 * else's data.
 *
 * So the rule is inverted: keep every parameter, and remove only the ones this
 * repository is about to write itself. Those are the standard request keywords,
 * and they are the only ones whose meaning is known here. Anything unrecognised
 * is a vendor parameter by definition and belongs to the endpoint.
 */

/**
 * The request keywords of WMS, WFS and OWS common — the parameters we compose.
 *
 * Kept deliberately narrow. A name that is not on this list is not "probably
 * safe to drop": it is a parameter whose meaning we do not know, which is the
 * precise case for carrying it through untouched.
 */
const REQUEST_PARAMS = new Set([
    // OWS common
    'SERVICE', 'REQUEST', 'VERSION', 'ACCEPTVERSIONS', 'EXCEPTIONS',
    // WMS GetMap
    'LAYERS', 'STYLES', 'FORMAT', 'TRANSPARENT', 'SRS', 'CRS', 'BBOX',
    'WIDTH', 'HEIGHT', 'BGCOLOR', 'TIME', 'ELEVATION', 'SLD', 'SLD_BODY',
    // WMS GetFeatureInfo
    'QUERY_LAYERS', 'INFO_FORMAT', 'FEATURE_COUNT', 'X', 'Y', 'I', 'J',
    // WMS GetLegendGraphic
    'LAYER', 'RULE', 'SCALE', 'SLD_VERSION',
    // WFS GetFeature
    'TYPENAME', 'TYPENAMES', 'COUNT', 'MAXFEATURES', 'OUTPUTFORMAT',
    'SRSNAME', 'STARTINDEX', 'RESULTTYPE', 'PROPERTYNAME', 'FILTER',
    'SORTBY', 'NAMESPACES', 'FEATUREID',
]);

/**
 * The endpoint a request URL was sent to, vendor parameters intact.
 *
 * Returns a base URL ready to have a query appended by withQuery(). A trailing
 * "/" is trimmed only when nothing else follows, so it cannot eat a path.
 */
export function endpointOf(url) {
    const raw = String(url);
    const cut = raw.indexOf('?');
    if (cut < 0) return raw.replace(/\/$/, '');

    const base = raw.slice(0, cut).replace(/\/$/, '');
    const kept = [];
    for (const pair of raw.slice(cut + 1).split('&')) {
        if (!pair) continue;
        // A catalogue that stored its links as HTML and never unescaped them
        // hands out "?amp;Request=GetCapabilities" — geocat.ch does this for the
        // Zurich forestry services. That is the standard keyword wearing a
        // decoding artefact, not somebody's vendor parameter, so read it as one.
        const name = decodeURIComponent(pair.split('=')[0]).replace(/^amp;/i, '').toUpperCase();
        if (!REQUEST_PARAMS.has(name)) kept.push(pair);
    }
    return kept.length ? `${base}?${kept.join('&')}` : base;
}

/**
 * Append a query to an endpoint that may already carry vendor parameters.
 *
 * The separator is the whole point: an endpoint holding ?map=... takes "&", a
 * bare one takes "?". Getting this wrong is how a second "?" ends up in a URL.
 */
export function withQuery(endpoint, query) {
    if (!query) return endpoint;
    return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`;
}
