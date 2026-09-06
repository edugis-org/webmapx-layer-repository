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

const WMS_TAIL = 'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true' +
                 '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
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

function mkLayer({ id, name, title, abstract, datasetId, url, kind, background, bounds, attribution }) {
    const src = kind === 'geojson'
        ? { type: 'geojson', data: url, ...(attribution ? { attribution } : {}) }
        : {
            type: 'raster', tiles: [url], tileSize: 256,
            ...(attribution ? { attribution } : {}),
            ...(bounds ? { bounds } : {}),
        };
    return {
        id, ...(name ? { name } : {}), title,
        ...(abstract ? { abstract: abstract.slice(0, 600) } : {}),
        ...(datasetId ? { datasetId } : {}),
        type: kind, requiresKey: false,
        webmapxConfig: {
            source: src,
            // The abstract goes in metadata, not only on our own record: webmapx's
            // layer-info dialog reads layer.metadata.abstract and shows a
            // "no information available" placeholder when it is absent.
            layer: {
                id, type: 'raster',
                metadata: {
                    title,
                    ...(abstract ? { abstract: abstract.slice(0, 600) } : {}),
                    legendRole: background ? 'background' : 'overlay',
                },
            },
        },
    };
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
        } else { continue; }

        svc.layers.push(mkLayer({
            id, name: r.name, title: r.title, abstract: r.abstract, datasetId: r.dataset_md_id,
            url, kind, bounds: source.bounds, attribution: attributionFor(source),
            background: /achtergrond|luchtfoto|ortho|topografi/i.test(r.title),
        }));
        services.set(key, svc);
    }
    for (const s of services.values()) delete s._ids;
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
    (function walk(node, inheritedCrs) {
        for (const l of arr(node?.Layer)) {
            const crs = [...new Set([...inheritedCrs, ...arr(l.CRS ?? l.SRS).map(String)])];
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
                        bounds: source.bounds, attribution: attributionFor(source),
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
            walk(l, crs);
        }
    })(cap.Capability, []);

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
    (function walk(node) {
        for (const l of arr(node?.Layer)) {
            const styles = stylesOf(l);
            if (l.Name !== undefined && styles.length) out.set(String(l.Name), styles);
            walk(l);
        }
    })(root?.Capability);
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

    return { endpoint: href ? String(href).split('?')[0] : candidateUrl, typeNames };
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
                    const styles = map.get(l.name);
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
