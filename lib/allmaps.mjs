/**
 * Allmaps: georeferenced scans of historical maps, indexed by geography.
 *
 * Allmaps holds one warped historical map per record, each with a footprint on
 * the earth and a tile endpoint that serves it as XYZ raster. There is no
 * theme, no keyword and no title in the record — what a map *is*, from the
 * catalogue's side, is where it covers and how much of the world it covers.
 * So that is the axis this indexes on: every map lands in the smallest curated
 * region whose extent contains its footprint, which produces the world →
 * continent → country → subdivision → city ladder the rest of the repository
 * is organised by, without anyone hand-filing 20,000 scans.
 *
 * The API (https://api.allmaps.org/openapi.json, v3) answers CORS `*` and
 * needs no key. Two of its traits shape everything here:
 *
 *   - `limit` is capped at 200 per response whatever is asked for, and there
 *     is no offset or cursor. Results come back newest-`modified` first, so
 *     paging is a keyset walk on `modifiedBefore`.
 *   - `containedBy` returned nothing for every extent tried — world included —
 *     so containment is computed here from each map's own geometry instead.
 */

const API = 'https://api.allmaps.org';
const TILES = 'https://allmaps.xyz';

/** The API's hard ceiling; asking for more returns 200 anyway. */
export const PAGE_SIZE = 200;

/**
 * Walk `/maps.geojson` newest-first, yielding pages until `cap` or the end.
 *
 * `modifiedBefore` is exclusive of nothing — it re-reads the boundary record —
 * so pages are deduplicated by id rather than trusted to be disjoint.
 */
export async function* mapPages({ bbox, cap = Infinity, fetchJson, maxArea } = {}) {
    let before = null;
    let seen = 0;
    const yielded = new Set();
    for (;;) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (bbox) params.set('intersects', bbox.join(','));
        if (maxArea) params.set('maxArea', String(maxArea));
        if (before) params.set('modifiedBefore', before);
        const page = await fetchJson(`${API}/maps.geojson?${params}`);
        const features = (page?.features ?? []).filter(f => {
            const id = f?.properties?.id;
            if (!id || yielded.has(id)) return false;
            yielded.add(id);
            return true;
        });
        if (!features.length) return;
        yield features;
        seen += features.length;
        if (seen >= cap) return;
        const last = page.features[page.features.length - 1]?.properties?.modified;
        // A page shorter than the ceiling is the end of the data, and a page
        // whose oldest record we already had would loop forever.
        if (page.features.length < PAGE_SIZE || !last || last === before) return;
        before = last;
    }
}

/** [minx, miny, maxx, maxy] of a GeoJSON geometry, or null when it has none. */
export function geometryBounds(geometry) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const walk = coords => {
        if (typeof coords[0] === 'number') {
            const [x, y] = coords;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            minx = Math.min(minx, x); maxx = Math.max(maxx, x);
            miny = Math.min(miny, y); maxy = Math.max(maxy, y);
            return;
        }
        for (const c of coords) walk(c);
    };
    if (!geometry?.coordinates) return null;
    walk(geometry.coordinates);
    if (!Number.isFinite(minx) || !Number.isFinite(miny)) return null;
    return [minx, miny, maxx, maxy];
}

/** Rough m² of an extent, good enough to compare a footprint against it. */
export function extentArea([minx, miny, maxx, maxy]) {
    const M_PER_DEG = 111320;
    const midLat = ((miny + maxy) / 2) * Math.PI / 180;
    return Math.abs(maxx - minx) * Math.cos(midLat) * M_PER_DEG
         * Math.abs(maxy - miny) * M_PER_DEG;
}

/** True when `inner` lies inside `outer`, both [minx, miny, maxx, maxy]. */
export function within(inner, outer) {
    return inner[0] >= outer[0] && inner[1] >= outer[1]
        && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/**
 * The deepest region whose extent contains the footprint.
 *
 * Depth, not area, decides: the tree is the thing being indexed into, and a
 * region's extent is a rectangle around a country, not the country. A map that
 * fits no region at all belongs to none — it is a warp gone wrong (footprints
 * spanning 400 degrees of longitude are not rare) and is dropped by the caller
 * rather than filed under "world" where it would bury the real world maps.
 */
export function regionFor(bounds, regions, { minFill = 0 } = {}) {
    let best = null;
    const area = extentArea(bounds);
    for (const [region, extent] of Object.entries(regions)) {
        if (!within(bounds, extent)) continue;
        // Containment alone would file a 350-metre plan of the Zócalo under
        // "world", because no region between the two exists in the table. A
        // footprint must also be a plausible fraction of the region it lands
        // in; one that is not says the ladder is missing a rung, which is a
        // fact about the table, not about the map.
        if (minFill && area / extentArea(extent) < minFill) continue;
        const depth = region.split('/').length;
        if (!best || depth > best.depth) best = { region, depth };
    }
    return best?.region ?? null;
}

/** The manifest ids a map's scan belongs to — its title lives there, not here. */
export function manifestIds(properties) {
    return (properties?._allmaps?.image?.canvases ?? [])
        .flatMap(canvas => (canvas.manifests ?? []).map(m => m.id))
        .map(id => id.split('/').pop())
        .filter(Boolean);
}

/**
 * Titles for a set of manifests, fetched from Allmaps rather than from the
 * institutions.
 *
 * The holding institution's own IIIF manifest is the richer record, but it is
 * not reachable in bulk: the Library of Congress answers a plain manifest
 * request with a Cloudflare challenge, and the scans in this catalogue come
 * from some fifty hosts with fifty different tempers. Allmaps has already
 * fetched and stored each manifest's label, from one endpoint, under one
 * policy — so that is what this reads.
 */
export async function manifestLabels(ids, { fetchJson, concurrency = 6, onProgress } = {}) {
    const labels = new Map();
    const queue = [...new Set(ids)];
    let done = 0;
    const worker = async () => {
        for (;;) {
            const id = queue.pop();
            if (!id) return;
            try {
                const doc = await fetchJson(`${API}/manifests/${id}`);
                const label = labelOf(doc?.label);
                if (label) labels.set(id, label);
            } catch { /* a manifest that will not load leaves its maps untitled */ }
            onProgress?.(++done);
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return labels;
}

/**
 * IIIF labels are language maps: { none: ["Map of the World."] }.
 *
 * They arrive as catalogue records rather than as display text — HTML entities
 * intact ("British &amp; German New Guinea"), and sometimes a second line
 * carrying the title in its original script. Both are tidied here: a layer
 * title is one line.
 */
export function labelOf(label) {
    if (!label) return null;
    const raw = typeof label === 'string'
        ? label
        : (v => (Array.isArray(v) ? v[0] : v))(
            Object.values(label).find(v => (Array.isArray(v) ? v.length : v)));
    if (typeof raw !== 'string') return null;
    const text = raw
        .replace(/&(amp|lt|gt|quot|#39|apos);/g, m => ({
            '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
        }[m]))
        .replace(/\s+/g, ' ')
        .trim();
    return text || null;
}

/**
 * The year a map's title states, when it states one.
 *
 * Only about a fifth of titles carry a year, and none of them carry a date
 * field — "Kent Ordnance Survey 1860" is the whole of what is known. A range
 * takes its first year. Anything outside 1400-2030 is some other number.
 */
export function yearFrom(title) {
    for (const match of String(title ?? '').matchAll(/\b(1[4-9]\d{2}|20[0-3]\d)\b/g)) {
        const year = Number(match[1]);
        if (year >= 1400 && year <= 2030) return year;
    }
    return null;
}

/** "David Rumsey Map Collection", when the record names who holds the scan. */
export function holderOf(properties) {
    const provider = properties?.resource?.provider?.[0];
    const label = provider?.label;
    if (!label) return null;
    const first = Object.values(label).find(v => Array.isArray(v) && v.length);
    return first?.[0] ?? null;
}

/**
 * One georeferenced scan as a layer.
 *
 * The tile server needs nothing but the map id, and `bounds` keeps MapLibre
 * from asking for tiles the warp never covers — which for a city plan is
 * almost the whole planet.
 */
export function layerFor(feature, { attribution, titles } = {}) {
    const p = feature.properties;
    const id = p.id.split('/').pop();
    const bounds = geometryBounds(feature.geometry);
    const holder = holderOf(p);
    const title = manifestIds(p).map(m => titles?.get(m)).find(Boolean) ?? null;
    const year = yearFrom(title);
    const credit = attribution
        ?? [holder, 'via <a href="https://allmaps.org">Allmaps</a>'].filter(Boolean).join(', ');
    // The georeference record names nothing, so the title comes from the IIIF
    // manifest and the holder from the scan's provider. A map with neither is
    // named by its id, which is at least unique.
    const label = title ?? (holder ? `${holder} — ${id}` : id);
    // What is known about the scan, said once and carried on the layer itself:
    // the layer table reads it, and so do the search index and phrases.json, so
    // a holder or a year is findable without opening the map.
    const abstract = [
        title ? `${title}.` : 'Georeferenced historical map.',
        year ? `Dated ${year} by its title.` : null,
        holder ? `Scan held by ${holder}.` : null,
        'Warped by Allmaps.',
    ].filter(Boolean).join(' ');
    return {
        id: `allmaps-${id}`,
        title: label,
        abstract,
        type: 'raster',
        status: 'active',
        requiresKey: false,
        webmapxConfig: {
            source: {
                type: 'raster',
                tiles: [`${TILES}/maps/${id}/{z}/{x}/{y}.png`],
                tileSize: 256,
                attribution: credit,
                ...(bounds ? { bounds } : {}),
            },
            layer: {
                id: `allmaps-${id}`,
                type: 'raster',
                metadata: {
                    title: label,
                    abstract,
                    ...(year ? { year } : {}),
                    ...(holder ? { holder } : {}),
                    // A warped scan is transparent outside its sheet and
                    // unreadable without context, so it is drawn over a
                    // basemap rather than instead of one.
                    legendRole: 'overlay',
                    allmapsId: id,
                    ...(p.resource?.id ? { iiifResource: p.resource.id } : {}),
                    ...(p._allmaps?.area ? { footprintArea: p._allmaps.area } : {}),
                },
            },
        },
        availability: 'up',
    };
}
