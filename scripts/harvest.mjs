#!/usr/bin/env node
/**
 * Populate harvested/ from the curated pointers in sources/.
 *
 * This is the build step, not a data edit: harvested/ is gitignored and
 * regenerated wholesale, the way node_modules is. Git holds the endpoints and
 * the code that reads them; running this produces everything else.
 *
 * Usage:
 *   node scripts/harvest.mjs [--source pdok-plugin] [--dry-run]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const SOURCES = join(ROOT, 'sources');
const OUT = join(ROOT, 'harvested');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
/**
 * Legends and attribute schemas need a request per service, which a plain
 * harvest should not pay for. --enrich opts in; responses are cached under
 * .cache/ so re-running is cheap.
 */
const enrich = args.includes('--enrich');
const CACHE = join(ROOT, '.cache');
const only = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;

/**
 * Features a WFS layer asks for, and the page size it asks in.
 *
 * A WFS becomes a GeoJSON source, and a GeoJSON source is fetched whole — there
 * is no bbox to narrow it, because MapLibre does not template one. Unbounded,
 * adding "Panden" would ask PDOK for ten million buildings.
 *
 * The cap cannot be reached in one request: PDOK returns 1000 features however
 * large a COUNT is asked for, and most servers set some such ceiling. So the
 * URL stored here is the first page, and the layer carries the cap and page size
 * for a client that wants the rest — see fetchWfsFeatures() in index.html.
 */
const WFS_FEATURE_CAP = 20000;
/** Only if a service declares no CountDefault of its own. */
const WFS_PAGE_FALLBACK = 1000;

// STYLES is sent empty rather than omitted: the spec requires the parameter,
// most servers forgive its absence, and ArcGIS Server answers StylesNotDefined.
const WMS_TAIL = 'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true' +
                 '&STYLES=&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
const slug = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const arr = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/**
 * Attribution a harvested layer must carry.
 *
 * A licence is a condition of use, not a note in a catalogue: a CC BY layer
 * copied out of here without its credit line is being used in breach of the
 * terms, and the consumer has no way of knowing. So the credit travels inside
 * webmapxConfig.source.attribution, where every renderer already shows it,
 * rather than staying on the provider record where only this UI would see it.
 *
 * Sources state their own text when the licensor dictates one — the
 * Klimaateffectatlas asks for "Klimaateffectatlas, <year>". {year} resolves at
 * harvest time. Otherwise it is built from the provider's name, site and
 * licence, which is what an attribution-required licence asks for.
 */
function attributionFor(source) {
    const p = source.provider ?? {};
    if (p.attribution) return String(p.attribution).replace(/\{year\}/g, new Date().getFullYear());
    if (!p.name) return undefined;
    const who = p.url ? `<a href="${p.url}">${p.name}</a>` : p.name;
    return p.license ? `&copy; ${who} (${p.license})` : `&copy; ${who}`;
}

function mkLayer({ id, name, title, abstract, datasetId, url, kind, background, bounds,
                   attribution, sourceLayer, featureCount }) {
    // Three shapes, because three ways of delivering the same data: a raster
    // tile template, a vector tile template with a source-layer to draw from,
    // and a GeoJSON document fetched whole.
    let src, layerType;
    if (kind === 'geojson' || kind === 'wfs') {
        src = { type: 'geojson', data: url, ...(attribution ? { attribution } : {}) };
        layerType = 'fill';
    } else if (kind === 'vector') {
        src = {
            type: 'vector', tiles: [url],
            ...(attribution ? { attribution } : {}),
            ...(bounds ? { bounds } : {}),
        };
        layerType = 'fill';
    } else {
        src = {
            type: 'raster', tiles: [url], tileSize: 256,
            ...(attribution ? { attribution } : {}),
            ...(bounds ? { bounds } : {}),
        };
        layerType = 'raster';
    }
    return {
        id, ...(name ? { name } : {}), title,
        ...(abstract ? { abstract: abstract.slice(0, 600) } : {}),
        ...(datasetId ? { datasetId } : {}),
        ...(featureCount !== undefined ? { featureCount } : {}),
        type: kind, requiresKey: false,
        webmapxConfig: {
            source: src,
            // The abstract goes in metadata, not only on our own record: webmapx's
            // layer-info dialog reads layer.metadata.abstract and shows a
            // "no information available" placeholder when it is absent.
            layer: {
                id, type: layerType,
                ...(sourceLayer ? { 'source-layer': sourceLayer } : {}),
                metadata: {
                    title,
                    ...(abstract ? { abstract: abstract.slice(0, 600) } : {}),
                    legendRole: background ? 'background' : 'overlay',
                },
            },
        },
    };
}

/**
 * Collections behind an OGC API Tiles service, as vector-tile layers.
 *
 * The catalogue lists one row for the whole service, so the collections have to
 * be asked for: /tiles names the tileset templates, /collections names the
 * source-layers to draw from them. WebMercatorQuad is the one MapLibre can use;
 * PDOK also publishes NetherlandsRDNewQuad and ETRS89-LAEA, which it cannot.
 * The template speaks OGC's {tileMatrix}/{tileRow}/{tileCol}, MapLibre speaks
 * {z}/{y}/{x} — the same numbers in the same order, renamed.
 */
async function ogcApiTileLayers(source, service) {
    const base = service.endpoint.replace(/\/$/, '');
    const tilesets = JSON.parse(await cachedText(`${base}/tiles?f=json`)).tilesets ?? [];
    const mercator = tilesets.find(t => t.tileMatrixSetId === 'WebMercatorQuad');
    if (!mercator) return [];
    const item = (mercator.links ?? []).find(l => /item$/.test(l.rel ?? ''))?.href;
    if (!item) return [];
    const template = item
        .replace('{tileMatrix}', '{z}').replace('{tileRow}', '{y}').replace('{tileCol}', '{x}');

    // The template can name a different host than the catalogue did — PDOK's
    // bestuurlijkegebieden answers for brk-bestuurlijke-gebieden — so the
    // collections are read from the endpoint the service points at, not ours.
    const root = template.split('/tiles/')[0];
    const collections = JSON.parse(await cachedText(`${root}/collections?f=json`)).collections ?? [];

    return collections.map(c => mkLayer({
        id: `${source.provider.id}-${slug(service.id)}-${slug(c.id)}`,
        name: c.id,
        title: c.title ?? `${service.title} — ${c.id}`,
        abstract: c.description,
        url: template, kind: 'vector', sourceLayer: c.id,
        bounds: bboxOf(c) ?? source.bounds,
        attribution: attributionFor(source),
    }));
}

/** WGS84 extent of an OGC API collection, where it states one. */
function bboxOf(collection) {
    const bbox = collection?.extent?.spatial?.bbox?.[0];
    if (!Array.isArray(bbox)) return null;
    const b = bbox.length === 6 ? [bbox[0], bbox[1], bbox[3], bbox[4]] : bbox.slice(0, 4);
    return b.length === 4 && b.every(v => Number.isFinite(Number(v))) ? b.map(Number) : null;
}

/** A catalogue that has already walked the provider's services for us. */
async function readPdokPluginList(source) {
    const res = await fetch(source.url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source.url}`);
    const rows = await res.json();
    const inc = source.include ?? {};
    const wanted = new Set(inc.serviceTypes ?? ['wms', 'wmts', 'api tiles']);
    const services = new Map();

    for (const r of rows) {
        if (!wanted.has(r.service_type)) continue;
        if (inc.crs && r.crs && !r.crs.includes(inc.crs)) continue;
        if (inc.match && !new RegExp(inc.match, 'i').test(`${r.name} ${r.title}`)) continue;
        if (inc.exclude && new RegExp(inc.exclude, 'i').test(`${r.name} ${r.title}`)) continue;

        const endpoint = r.service_url.split('?')[0];
        const key = `${r.service_type}|${endpoint}`;
        const svc = services.get(key) ?? {
            id: slug(endpoint.replace(/^https?:\/\/[^/]+/, '')) || slug(r.service_title),
            title: r.service_title, abstract: r.service_abstract,
            type: r.service_type === 'api tiles' ? 'ogc-api-tiles' : r.service_type,
            endpoint, capabilitiesUrl: r.service_url,
            ...(r.crs ? { crs: r.crs.split(',') } : {}),
            ...(r.imgformats ? { formats: r.imgformats.split(',') } : {}),
            ...(r.service_md_id ? { metadataId: r.service_md_id } : {}),
            harvestedFrom: source.id,
            layers: [], _ids: new Set(),
        };
        let id = `${source.provider.id}-${slug(r.name)}`;
        while (svc._ids.has(id)) id += '-2';
        svc._ids.add(id);

        // WMTS in this catalogue is RESTful; WMS needs a GetMap template built.
        let url, kind;
        if (r.service_type === 'wms') {
            url = `${endpoint}?LAYERS=${encodeURIComponent(r.name)}&${WMS_TAIL}`; kind = 'wms';
        } else if (r.service_type === 'wmts') {
            url = `${endpoint}/${r.name}/EPSG:3857/{z}/{x}/{y}.png`; kind = 'wmts';
        } else if (r.service_type === 'api tiles') {
            // The row describes the service; its collections are read below.
            services.set(key, svc);
            continue;
        } else if (r.service_type === 'wfs') {
            // A GeoJSON source fetches the whole document, so the request is
            // capped: WFS_FEATURE_CAP features of a national dataset is a
            // preview, and the alternative is a browser pulling millions.
            url = `${endpoint}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
                  `&TYPENAMES=${encodeURIComponent(r.name)}` +
                  `&OUTPUTFORMAT=application/json&COUNT=${WFS_PAGE_FALLBACK}&SRSNAME=EPSG:4326`;
            kind = 'wfs';
        } else { continue; }

        const built = mkLayer({
            id, name: r.name, title: r.title, abstract: r.abstract, datasetId: r.dataset_md_id,
            url, kind, bounds: source.bounds, attribution: attributionFor(source),
            background: /achtergrond|luchtfoto|ortho|topografi/i.test(r.title),
        });
        // The page size is the service's to state, and enrichment reads it from
        // the service's capabilities; the cap is ours.
        if (kind === 'wfs') built.featureCap = WFS_FEATURE_CAP;
        svc.layers.push(built);
        services.set(key, svc);
    }
    for (const s of services.values()) delete s._ids;

    // An OGC API Tiles row describes a service, not a layer: ask it what it holds.
    for (const svc of services.values()) {
        if (svc.type !== 'ogc-api-tiles') continue;
        try { svc.layers = await ogcApiTileLayers(source, svc); }
        catch { svc.layers = []; }   // a service that will not describe itself
    }
    return [...services.values()];
}

/** A service describing itself. */
async function readWmsCapabilities(source) {
    const res = await fetch(source.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source.url}`);
    const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' })
        .parse(await res.text());
    const cap = xml.WMS_Capabilities ?? xml.WMT_MS_Capabilities;
    if (!cap) throw new Error('no WMS capabilities element');
    const endpoint = source.url.split('?')[0];
    const inc = source.include ?? {};

    // Layers nest; only those with a <Name> are requestable.
    const out = []; const ids = new Set();
    (function walk(node, inheritedCrs, inheritedBounds) {
        for (const l of arr(node?.Layer)) {
            const crs = [...new Set([...inheritedCrs, ...arr(l.CRS ?? l.SRS).map(String)])];
            // Per the spec a nested layer inherits its parent's extent.
            const extent = boundsOf(l) ?? inheritedBounds;
            if (l.Name !== undefined) {
                const name = String(l.Name);
                const title = String(l.Title ?? name);
                if (!(inc.crs && !crs.includes(inc.crs))
                    && !(inc.match && !new RegExp(inc.match, 'i').test(`${name} ${title}`))
                    && !(inc.exclude && new RegExp(inc.exclude, 'i').test(`${name} ${title}`))) {
                    let id = `${source.provider.id}-${slug(name)}`;
                    while (ids.has(id)) id += '-2';
                    ids.add(id);
                    const layer = mkLayer({
                        id, name, title, abstract: l.Abstract ? String(l.Abstract) : undefined,
                        url: `${endpoint}?LAYERS=${encodeURIComponent(name)}&${WMS_TAIL}`, kind: 'wms',
                        // The layer's own extent where it states one; the
                        // source's only as a fallback.
                        bounds: extent ?? source.bounds,
                        attribution: attributionFor(source),
                    });
                    // Styles and their legends are in the document already being
                    // parsed, so they cost nothing here. Only attribute schemas,
                    // which are a request per layer against a separate WFS, are
                    // worth hiding behind --enrich.
                    const styles = stylesOf(l);
                    out.push(...(styles.length
                        ? expandStyles(layer, styles, inc.expandStyles !== false)
                        : [layer]));
                }
            }
            walk(l, crs, extent);
        }
    })(cap.Capability, [], null);

    const root = arr(cap.Capability?.Layer)[0] ?? {};
    return [{
        id: slug(endpoint.replace(/^https?:\/\/[^/]+/, '')) || 'wms',
        title: String(cap.Service?.Title ?? source.title ?? 'WMS'),
        ...(cap.Service?.Abstract ? { abstract: String(cap.Service.Abstract).slice(0, 600) } : {}),
        type: 'wms', endpoint, capabilitiesUrl: source.url, stylesRead: true,
        crs: [...new Set(arr(root.CRS ?? root.SRS).map(String))],
        harvestedFrom: source.id,
        layers: inc.limit ? out.slice(0, inc.limit) : out,
    }];
}


/** Fetch with an on-disk cache, so --enrich is cheap to re-run. */
async function cachedText(url, timeout = 60000) {
    const key = join(CACHE, Buffer.from(url).toString('base64url').slice(0, 180) + '.txt');
    if (existsSync(key)) return readFileSync(key, 'utf8');
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(key, text);
    return text;
}

const XML = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

/**
 * layer name -> its published styles, read from a WMS capabilities document.
 *
 * Every style is kept, not just the first legend found. A WMS style is a
 * different rendering of the same source, which is what a webmapx layer is, so
 * a layer with 127 styles describes 127 layers — and for a service like CBS
 * Vierkantstatistieken each style is a different variable (inhabitants, distance
 * to a pharmacy), not a restyle of one.
 */
/**
 * A layer's own extent, from the capabilities document.
 *
 * WMS 1.3.0 states it as EX_GeographicBoundingBox and 1.1.1 as
 * LatLonBoundingBox, both in WGS84. Without it a layer inherits the source's
 * bounds, which describe the service: every TIGERweb layer would claim the
 * whole world because the service spans Guam to Maine, and "zoom to layer"
 * would land on the globe instead of on the data.
 */
function boundsOf(layerNode) {
    const ex = arr(layerNode.EX_GeographicBoundingBox)[0];
    if (ex) {
        const b = [ex.westBoundLongitude, ex.southBoundLatitude,
                   ex.eastBoundLongitude, ex.northBoundLatitude].map(Number);
        if (b.every(Number.isFinite)) return b;
    }
    const ll = arr(layerNode.LatLonBoundingBox)[0];
    if (ll) {
        const b = [ll['@minx'], ll['@miny'], ll['@maxx'], ll['@maxy']].map(Number);
        if (b.every(Number.isFinite)) return b;
    }
    return null;
}

function stylesOf(layerNode) {
    return arr(layerNode.Style).map(st => ({
        name: st.Name === undefined ? undefined : String(st.Name),
        title: st.Title === undefined ? undefined : String(st.Title),
        legendUrl: arr(st.LegendURL)[0]?.OnlineResource?.['@xlink:href'],
    })).filter(st => st.name || st.legendUrl);
}

async function stylesFor(capabilitiesUrl) {
    const cap = XML.parse(await cachedText(capabilitiesUrl));
    const root = cap.WMS_Capabilities ?? cap.WMT_MS_Capabilities;
    const out = new Map();
    (function walk(node, inheritedBounds) {
        for (const l of arr(node?.Layer)) {
            const bounds = boundsOf(l) ?? inheritedBounds;
            if (l.Name !== undefined) out.set(String(l.Name), { styles: stylesOf(l), bounds });
            walk(l, bounds);
        }
    })(root?.Capability, null);
    return out;
}

/**
 * Turn a layer with several published styles into one layer per style.
 *
 * The style rides in the GetMap STYLES parameter, so each expansion is a
 * complete config with its own legend and title — nothing needs to know these
 * layers share a source. A single style is left alone: naming a layer after the
 * only rendering it has adds nothing. Its legend is still attached, and so is
 * the default style's, since a service that publishes styles without saying
 * which is default serves the first one.
 */
function expandStyles(layer, styles, expand = true) {
    const named = styles.filter(st => st.name);
    if (!expand || named.length < 2) {
        const only = styles[0];
        if (only?.legendUrl) layer.legendUrl = String(only.legendUrl);
        if (only?.title && only?.name) layer.styleTitle = only.title;
        return [layer];
    }
    return named.map(st => {
        const title = st.title || st.name;
        const out = {
            ...layer,
            id: `${layer.id}-${slug(st.name)}`,
            title: `${layer.title} — ${title}`,
            styleName: st.name,
            styleTitle: title,
            ...(st.legendUrl ? { legendUrl: String(st.legendUrl) } : {}),
        };
        const src = out.webmapxConfig.source;
        out.webmapxConfig = {
            ...out.webmapxConfig,
            source: { ...src, tiles: src.tiles.map(t => `${t}&STYLES=${encodeURIComponent(st.name)}`) },
            layer: {
                ...out.webmapxConfig.layer,
                id: out.id,
                metadata: { ...out.webmapxConfig.layer.metadata, title: out.title },
            },
        };
        return out;
    });
}

/** Where a WFS might sit beside a WMS. A guess, confirmed by asking it. */
function featuresEndpointFor(endpoint) {
    if (/\/wms\//.test(endpoint)) return endpoint.replace('/wms/', '/wfs/');
    if (/\/wms$/.test(endpoint)) return endpoint.replace(/\/wms$/, '/wfs');
    if (/\/ows$/.test(endpoint)) return endpoint;   // GeoServer serves every service off /ows
    return null;
}

/**
 * What a WFS says about paging: its own page size and whether it can page.
 *
 * WFS 2.0 states both in OperationsMetadata — `CountDefault` is the ceiling it
 * applies to COUNT (PDOK: 1000, whatever is asked for) and `ImplementsResultPaging`
 * says whether STARTINDEX works. Reading them beats guessing: a server with a
 * larger page needs fewer requests, and one that cannot page must not be asked to.
 */
function pagingOf(cap) {
    const ops = cap['ows:OperationsMetadata'] ?? cap.OperationsMetadata ?? {};
    const constraints = arr(ops['ows:Constraint'] ?? ops.Constraint);
    const valueOf = name => {
        const c = constraints.find(x => x['@name'] === name);
        const v = c?.['ows:DefaultValue'] ?? c?.DefaultValue;
        return v === undefined ? undefined : String(v);
    };
    const count = Number(valueOf('CountDefault'));
    const paging = valueOf('ImplementsResultPaging');
    return {
        pageSize: Number.isFinite(count) && count > 0 ? count : WFS_PAGE_FALLBACK,
        canPage: paging === undefined ? true : /true/i.test(paging),
    };
}

/**
 * Ask a WFS what it is and what it holds.
 *
 * Returns the endpoint the service names for itself — not the URL we guessed to
 * reach it, which can redirect or be one of several aliases — and the set of
 * feature types it publishes. Knowing the set up front means DescribeFeatureType
 * is only requested for layers that actually have one, instead of once per layer
 * and mostly for nothing.
 */
async function wfsCapabilities(candidateUrl) {
    const url = `${candidateUrl}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`;
    const doc = XML.parse(await cachedText(url, 60000));
    const cap = doc['wfs:WFS_Capabilities'] ?? doc.WFS_Capabilities;
    if (!cap) throw new Error('no WFS capabilities element');

    const list = cap['wfs:FeatureTypeList'] ?? cap.FeatureTypeList;
    const types = arr(list?.['wfs:FeatureType'] ?? list?.FeatureType);
    const typeNames = new Set();
    for (const t of types) {
        const name = t['wfs:Name'] ?? t.Name;
        if (name === undefined) continue;
        const full = String(name);
        typeNames.add(full);
        // A WMS layer is often named without the workspace the WFS prefixes.
        if (full.includes(':')) typeNames.add(full.split(':').pop());
    }

    // The endpoint the service publishes for itself, from its own operations
    // metadata rather than from the URL we happened to reach it on.
    const ops = arr(cap['ows:OperationsMetadata']?.['ows:Operation'] ?? cap.OperationsMetadata?.Operation);
    const describe = ops.find(o => o['@name'] === 'DescribeFeatureType') ?? ops[0];
    const get = describe?.['ows:DCP']?.['ows:HTTP']?.['ows:Get'] ?? describe?.DCP?.HTTP?.Get;
    const href = arr(get)[0]?.['@xlink:href'];

    return {
        endpoint: href ? String(href).split('?')[0] : candidateUrl,
        typeNames,
        ...pagingOf(cap),
    };
}

/**
 * Fill in legends and attribute schemas for services already harvested.
 * Failures are expected and silent per service: a raster service has no WFS,
 * and plenty of WMS servers publish no LegendURL.
 */
async function enrichServices(services, expand) {
    let legends = 0, schemas = 0, expansions = 0;
    for (const svc of services) {
        // Sources read from a capabilities document already carry their styles
        // and legends, extracted during that parse. Only catalogue-derived
        // services (the PDOK plugin list) still need the document fetched.
        if (svc.type === 'wms' && svc.capabilitiesUrl && !svc.stylesRead) {
            try {
                const map = await stylesFor(svc.capabilitiesUrl);
                const out = [];
                for (const l of svc.layers) {
                    const entry = map.get(l.name);
                    // A catalogue gave us this layer, so nothing had read its own
                    // extent; the capabilities document states it.
                    if (entry?.bounds && l.webmapxConfig?.source) {
                        l.webmapxConfig.source.bounds = entry.bounds;
                    }
                    const styles = entry?.styles?.length ? entry.styles : null;
                    if (!styles) { out.push(l); continue; }
                    const expanded = expand ? expandStyles(l, styles) : [l];
                    if (!expand) {
                        const href = styles.map(st => st.legendUrl).find(Boolean);
                        if (href) l.legendUrl = String(href);
                    }
                    legends += expanded.filter(x => x.legendUrl).length;
                    expansions += expanded.length - 1;
                    out.push(...expanded);
                }
                svc.layers = out;
            } catch { /* no capabilities, or no styles in them */ }
        }
        // A service listed as a WFS in a catalogue is asked about itself; a WMS is
        // asked about the WFS that may sit beside it.
        if (svc.type === 'wfs') {
            try {
                const wfs = await wfsCapabilities(svc.endpoint);
                svc.featurePageSize = wfs.pageSize;
                svc.featurePaging = wfs.canPage;
            } catch { /* it will be paged at the fallback size */ }
            continue;
        }
        const candidate = svc.type === 'wms' ? featuresEndpointFor(svc.endpoint) : null;
        if (!candidate) continue;

        let wfs;
        try { wfs = await wfsCapabilities(candidate); }
        catch { continue; }   // no WFS beside this WMS: a genuinely raster service

        // Which WMS layers have a feature type, and under which name — that is
        // all a capabilities document can say. The attribute list itself needs
        // DescribeFeatureType, which the previewer asks for when someone opens a
        // layer: one request for the layer being looked at, instead of thousands
        // at harvest for layers nobody opens. Every endpoint here answers with
        // Access-Control-Allow-Origin: *, so the browser can.
        const featureTypes = {};
        for (const name of new Set(svc.layers.map(l => l.name).filter(Boolean))) {
            const typeName = wfs.typeNames.has(name) ? name
                : [...wfs.typeNames].find(t => t.split(':').pop() === name.split(':').pop());
            if (typeName) { featureTypes[name] = typeName; schemas++; }
        }
        if (Object.keys(featureTypes).length) {
            svc.featuresEndpoint = wfs.endpoint;
            svc.featureTypes = featureTypes;
            svc.featurePageSize = wfs.pageSize;
            svc.featurePaging = wfs.canPage;
        }
        process.stdout.write('.');
    }
    return { legends, schemas, expansions };
}

const READERS = { 'pdok-plugin-list': readPdokPluginList, 'wms-capabilities': readWmsCapabilities };

const sources = readdirSync(SOURCES).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(SOURCES, f), 'utf8')))
    .filter(s => s.enabled !== false)
    .filter(s => !only || s.id === only);

if (!dryRun && !only && existsSync(OUT)) rmSync(OUT, { recursive: true });

let totalLayers = 0, totalServices = 0, failed = 0;
/** Output file -> document, so several sources can feed one provider file. */
const written = new Map();
for (const source of sources) {
    const reader = READERS[source.type];
    if (!reader) { console.error(`✖ ${source.id}: no reader for type "${source.type}"`); failed++; continue; }
    process.stdout.write(`⛏  ${source.id} … `);
    let services;
    try { services = await reader(source); }
    catch (e) { console.log(`failed: ${e.message}`); failed++; continue; }

    // A source can decline enrichment. Reading legends is one request per
    // service, but attribute schemas are one per layer, and a service offering
    // 16,000 layers would turn a harvest into a small denial of service against
    // the people publishing the data for free.
    if (enrich && (source.include ?? {}).enrich !== false) {
        process.stdout.write('\n   enriching ');
        const expand = (source.include ?? {}).expandStyles !== false;
        const { legends, schemas, expansions } = await enrichServices(services, expand);
        process.stdout.write(` ${legends} legends, ${schemas} feature types` +
                             `${expand ? `, +${expansions} style layers` : ''}\n   `);
    }

    const layers = services.reduce((n, s) => n + s.layers.length, 0);
    services = services.filter(s => s.layers.length > 0);
    const doc = {
        provider: {
            ...source.provider,
            abstract: source.title,
            categories: source.provider.categories ?? [],
            regions: (source.region ?? 'world').split('/').slice(1),
            cost: { model: source.provider.access === 'free' ? 'free' : 'freemium' },
            lifecycle: 'stable',
        },
        services,
    };
    // One provider can be reached through several sources — RIVM publishes the
    // Atlas Leefomgeving, Atlas Natuurlijk Kapitaal and DMG endpoints separately
    // — and they all belong in that provider's file. Merge rather than
    // overwrite, and keep whichever provider record has the most to say.
    const file = join(OUT, source.region ?? 'world', `${source.provider.id}.json`);
    const existing = written.get(file);
    if (existing) {
        const seen = new Set(existing.services.map(s => s.id));
        for (const svc of doc.services) {
            let id = svc.id, n = 2;
            while (seen.has(id)) id = `${svc.id}-${n++}`;
            seen.add(id);
            existing.services.push({ ...svc, id });
        }
        existing.provider.categories = [...new Set([
            ...(existing.provider.categories ?? []), ...(doc.provider.categories ?? [])])];
    } else {
        written.set(file, doc);
    }
    const merged = written.get(file);
    if (!dryRun) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
    }
    totalServices += services.length; totalLayers += layers;
    console.log(`${services.length} services, ${layers} layers → ${relative(ROOT, file)}` +
                `${existing ? ` (merged, now ${merged.services.length} services)` : ''}`);
}
console.log(`\n${totalServices} services, ${totalLayers} layers from ${sources.length} source(s)` +
            (failed ? `, ${failed} failed` : ''));
if (dryRun) console.log('(dry-run: nothing written)');
