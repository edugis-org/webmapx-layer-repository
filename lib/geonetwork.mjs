/**
 * A GeoNetwork catalogue, read as a source of layers.
 *
 * GeoNetwork is a metadata catalogue, not a service: it holds records that
 * *describe* datasets, and each record lists the online resources the dataset
 * can be reached through — a WMS here, a WFS there, a download page, a
 * landing page. So the adapter's job is not "read a capabilities document"
 * but "find the records that point at something renderable, and keep what the
 * record already knows that a capabilities document does not": the abstract,
 * the keywords, the licence, the responsible organisation, the extent.
 *
 * ## Which API
 *
 * GeoNetwork 4 publishes three ways in, and they are not equally usable:
 *
 * - `/srv/api/search/records/_search` — a pass-through to its Elasticsearch
 *   index. One POST returns records, links, extents and facets together, and
 *   it is what GeoNetwork's own UI uses. This is the one used here.
 * - `/srv/<lang>/csw` — CSW 2.0.2. Standard, XML, and every field needs a
 *   second parse; it would drag fast-xml-parser into the browser for nothing.
 * - `/srv/api/collections/main/items` — OGC API Records. The better answer
 *   eventually, but only on recent 4.x: the Dutch national catalogue answers
 *   404 for it today while the search API answers fine.
 *
 * ## Why this file has no Node in it
 *
 * Nothing here imports anything. It uses `fetch`, which Node has had since
 * 18 and browsers have always had, so the same file is the harvest reader
 * and the browser client — the previewer loads it with a plain
 * `<script type="module">`, with no bundler and no build step, which is all
 * static hosting allows. "Compiling an adapter for the browser" turns out to
 * mean "do not write anything that needs compiling".
 *
 * A browser can talk to these catalogues directly because they answer
 * `Access-Control-Allow-Origin: *` — checked against the Dutch national
 * catalogue, the EEA SDI, geocat.ch and metawal.wallonie.be. That is a
 * property of those deployments, not of GeoNetwork, so a catalogue added
 * later has to be checked the same way before the previewer can search it.
 */

/** Link protocols a web map can actually draw, in the spelling records use. */
export const RENDERABLE_PROTOCOLS = ['OGC:WMS', 'OGC:WMTS', 'OGC:WFS'];

/** GeoNetwork stores every translatable field as {default, lang<xxx>}. */
const text = v => (v && typeof v === 'object' ? v.default ?? Object.values(v)[0] : v) ?? undefined;
const arr = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** The search endpoint of a catalogue, from its GeoNetwork base URL. */
export function searchEndpoint(base) {
    return `${String(base).replace(/\/$/, '')}/srv/api/search/records/_search`;
}

/** The human-readable page for a record, for a "see the metadata" link. */
export function recordUrl(base, uuid) {
    return `${String(base).replace(/\/$/, '')}/srv/search?uuid=${encodeURIComponent(uuid)}`;
}

/**
 * The Elasticsearch query a search turns into.
 *
 * Kept separate from the request so a caller can inspect or extend it, and so
 * the shape is testable without a network. `protocols` is the important
 * filter: without it a search returns the whole catalogue, most of which
 * describes datasets with no renderable endpoint at all.
 */
export function buildQuery({ text: q, protocols = RENDERABLE_PROTOCOLS, bbox, size = 20, from = 0 } = {}) {
    const must = [];
    if (q) must.push({ query_string: { query: q, default_operator: 'AND' } });
    if (protocols?.length) must.push({ terms: { linkProtocol: protocols } });
    if (bbox) {
        // A record's extent is indexed as a geo_shape under `geom`.
        const [w, s, e, n] = bbox;
        must.push({ geo_shape: { geom: {
            shape: { type: 'envelope', coordinates: [[w, n], [e, s]] },
            relation: 'intersects',
        } } });
    }
    return {
        size, from,
        query: { bool: { must: must.length ? must : [{ match_all: {} }] } },
        // Every record carries a full ISO document under `document`, which is
        // large and useless here; the fields asked for are the ones normalize()
        // reads. Excluding rather than listing keeps the request honest when a
        // catalogue names a field slightly differently.
        _source: { excludes: ['document', 'record', 'userinfo', 'overview'] },
    };
}

/**
 * Ask a catalogue for records.
 *
 * Returns `{ total, records }` with records already normalized, because a raw
 * hit is a hundred fields of GeoNetwork internals and two of them matter.
 */
export async function search(base, options = {}) {
    const { signal, fetchImpl = fetch } = options;
    const res = await fetchImpl(searchEndpoint(base), {
        method: 'POST',
        // Accept-Language is not politeness here: Node's fetch defaults it to
        // `*`, and GeoNetwork answers 400 "Couldn't find 3-letter language code
        // for *" rather than picking a language. Browsers send a real list and
        // never hit it, so the harvest would be the only side that broke.
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Language': options.language ?? 'eng',
        },
        body: JSON.stringify(buildQuery(options)),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${searchEndpoint(base)}`);
    const body = await res.json();
    return {
        total: body?.hits?.total?.value ?? 0,
        records: arr(body?.hits?.hits).map(h => normalize(h, base)),
    };
}

/** One catalogue record, reduced to what a layer catalogue can use. */
export function normalize(hit, base) {
    const s = hit?._source ?? {};
    return {
        uuid: s.uuid ?? s.metadataIdentifier ?? hit?._id,
        title: text(s.resourceTitleObject) ?? '(untitled)',
        abstract: text(s.resourceAbstractObject),
        type: arr(s.resourceType)[0],               // dataset | service | series
        organisation: text(arr(s.OrgForResourceObject)[0]) ?? text(arr(s.OrgObject)[0]),
        license: text(arr(s.licenseObject)[0]) ?? text(arr(s.MD_LegalConstraintsUseLimitationObject)[0]),
        keywords: arr(s.tag).map(text).filter(Boolean),
        topics: arr(s.cl_topic).map(t => t?.key).filter(Boolean),
        bounds: boundsOf(s),
        links: arr(s.link).map(linkOf).filter(l => l.url),
        catalogue: base,
        metadataUrl: base ? recordUrl(base, s.uuid ?? hit?._id) : undefined,
    };
}

function linkOf(l) {
    return {
        protocol: l?.protocol ?? '',
        url: text(l?.urlObject) ?? l?.url,
        // The layer name inside the service. A WMS link without one describes
        // the endpoint rather than a layer, and cannot become a layer here.
        name: text(l?.nameObject) ?? l?.name,
        description: text(l?.descriptionObject),
    };
}

/**
 * WGS84 extent of a record, [west, south, east, north].
 *
 * Records carry `geom` as one or more GeoJSON geometries — a record covering
 * two provinces has two — so the union is taken. Records with no extent are
 * common and are not an error; the caller falls back to the source's bounds.
 */
export function boundsOf(source) {
    const geoms = arr(source?.geom);
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const eat = c => {
        if (typeof c?.[0] === 'number') {
            w = Math.min(w, c[0]); e = Math.max(e, c[0]);
            s = Math.min(s, c[1]); n = Math.max(n, c[1]);
        } else arr(c).forEach(eat);
    };
    geoms.forEach(g => eat(g?.coordinates));
    return Number.isFinite(w) && Number.isFinite(n) ? [w, s, e, n] : null;
}

/** The renderable links of a record, one entry per drawable layer. */
export function renderableLinks(record, protocols = RENDERABLE_PROTOCOLS) {
    const wanted = new Set(protocols.map(p => p.toUpperCase()));
    return record.links.filter(l => {
        const p = String(l.protocol).toUpperCase();
        // Protocols are spelled loosely across catalogues: "OGC:WMS",
        // "OGC:WMS-1.3.0-http-get-map" and "WMS" all occur.
        return [...wanted].some(x => p === x || p.startsWith(`${x}-`) || p === x.split(':').pop());
    }).filter(l => l.name);   // a link naming no layer describes the endpoint
}

/** The endpoint of a link, with the GetCapabilities query stripped off. */
export function endpointOf(url) {
    return String(url).split('?')[0].replace(/\/$/, '');
}

/** Which of our service types a link protocol is. */
export function serviceTypeOf(protocol) {
    const p = String(protocol).toUpperCase();
    if (p.includes('WMTS')) return 'wmts';
    if (p.includes('WFS')) return 'wfs';
    if (p.includes('WMS')) return 'wms';
    return null;
}

/**
 * A MapLibre-ready raster tile template for a WMS layer.
 *
 * 1.1.1 names the projection SRS and 1.3.0 names it CRS; a catalogue link
 * rarely states which version the service speaks, so 1.3.0 is asked for —
 * every WMS since 2004 answers it, while some newer services reject 1.1.1
 * outright. STYLES is sent empty rather than omitted because the spec
 * requires the parameter and ArcGIS Server enforces that.
 */
export function wmsTileUrl(endpoint, layer, { version = '1.3.0', format = 'image/png' } = {}) {
    const axis = version.startsWith('1.3') ? 'CRS' : 'SRS';
    return `${endpoint}?LAYERS=${encodeURIComponent(layer)}&SERVICE=WMS&VERSION=${version}`
         + `&REQUEST=GetMap&FORMAT=${encodeURIComponent(format)}&TRANSPARENT=true&STYLES=`
         + `&${axis}=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256`;
}

/** A first-page GeoJSON request for a WFS feature type. */
export function wfsGeojsonUrl(endpoint, typeName, { count = 1000 } = {}) {
    return `${endpoint}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature`
         + `&TYPENAMES=${encodeURIComponent(typeName)}`
         + `&OUTPUTFORMAT=application/json&COUNT=${count}&SRSNAME=EPSG:4326`;
}

/**
 * A webmapx source+layer for one renderable link, ready to preview.
 *
 * This is the whole point of the browser side: a search result becomes a map
 * layer without a harvest, a build or a round trip through this repository.
 * WMTS is deliberately absent — a WMTS link states no tile matrix set, and
 * guessing a grid produces a layer whose every tile 404s. Those need the
 * capabilities document, which the harvest reads and the previewer does not.
 */
export function webmapxConfigFor(record, link, { attribution } = {}) {
    const type = serviceTypeOf(link.protocol);
    const endpoint = endpointOf(link.url);
    const bounds = record.bounds;
    const credit = attribution ?? attributionFor(record);
    if (type === 'wms') {
        return {
            source: {
                type: 'raster', tileSize: 256,
                tiles: [wmsTileUrl(endpoint, link.name)],
                ...(credit ? { attribution: credit } : {}),
                ...(bounds ? { bounds } : {}),
            },
            layer: { type: 'raster' },
        };
    }
    if (type === 'wfs') {
        return {
            source: {
                type: 'geojson', data: wfsGeojsonUrl(endpoint, link.name),
                ...(credit ? { attribution: credit } : {}),
            },
            layer: { type: 'fill' },
        };
    }
    return null;
}

/**
 * The credit line a record already carries.
 *
 * A licence is a condition of use, so it travels with the layer rather than
 * staying in the catalogue where only this UI would see it — the same reason
 * the harvest writes attribution into every layer it produces.
 */
export function attributionFor(record) {
    if (!record?.organisation) return undefined;
    return record.license ? `© ${record.organisation} (${record.license})` : `© ${record.organisation}`;
}

/**
 * Records grouped into services, the shape the rest of this repository uses.
 *
 * A catalogue is organised by dataset and this repository is organised by
 * endpoint, so the regrouping is the adapter's real work: forty records
 * pointing at one GeoServer are one service with forty layers, not forty
 * services. Layer ids are made unique within the run because two records can
 * describe the same layer of the same service.
 */
export function servicesFromRecords(records, {
    protocols = RENDERABLE_PROTOCOLS, providerId = 'geonetwork', fallbackBounds, attribution,
} = {}) {
    const services = new Map();
    const seen = new Set();
    for (const record of records) {
        for (const link of renderableLinks(record, protocols)) {
            const type = serviceTypeOf(link.protocol);
            const endpoint = endpointOf(link.url);
            if (!type || !endpoint) continue;
            const key = `${type}|${endpoint}`;
            const svc = services.get(key) ?? {
                id: slug(endpoint.replace(/^https?:\/\//, '')) || `${providerId}-${type}`,
                title: endpoint.replace(/^https?:\/\//, ''),
                type, endpoint,
                capabilitiesUrl: `${endpoint}?SERVICE=${type.toUpperCase()}&REQUEST=GetCapabilities`,
                layers: [],
            };
            let id = `${providerId}-${slug(link.name)}`;
            while (seen.has(id)) id += '-2';
            seen.add(id);

            const cfg = webmapxConfigFor(record, link, { attribution });
            if (!cfg && type !== 'wmts') continue;
            const bounds = record.bounds ?? fallbackBounds;
            svc.layers.push({
                id, name: link.name,
                title: record.title,
                ...(record.abstract ? { abstract: record.abstract } : {}),
                ...(record.keywords.length ? { keywords: record.keywords.slice(0, 12) } : {}),
                ...(bounds ? { bounds } : {}),
                metadataId: record.uuid,
                ...(record.metadataUrl ? { metadataUrl: record.metadataUrl } : {}),
                webmapxConfig: cfg ?? undefined,
            });
            services.set(key, svc);
        }
    }
    return [...services.values()];
}

export const slug = s => String(s ?? '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60);
