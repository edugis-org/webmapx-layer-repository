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
const only = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;

const WMS_TAIL = 'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true' +
                 '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256';
const slug = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const arr = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

function mkLayer({ id, name, title, abstract, datasetId, url, kind, background }) {
    const src = kind === 'geojson'
        ? { type: 'geojson', data: url }
        : { type: 'raster', tiles: [url], tileSize: 256 };
    return {
        id, ...(name ? { name } : {}), title,
        ...(abstract ? { abstract: abstract.slice(0, 600) } : {}),
        ...(datasetId ? { datasetId } : {}),
        type: kind, requiresKey: false,
        webmapxConfig: {
            source: src,
            layer: { id, type: 'raster', metadata: { title, legendRole: background ? 'background' : 'overlay' } },
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
            url, kind, background: /achtergrond|luchtfoto|ortho|topografi/i.test(r.title),
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
                    out.push(mkLayer({
                        id, name, title, abstract: l.Abstract ? String(l.Abstract) : undefined,
                        url: `${endpoint}?LAYERS=${encodeURIComponent(name)}&${WMS_TAIL}`, kind: 'wms',
                    }));
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
        type: 'wms', endpoint, capabilitiesUrl: source.url,
        crs: [...new Set(arr(root.CRS ?? root.SRS).map(String))],
        harvestedFrom: source.id,
        layers: inc.limit ? out.slice(0, inc.limit) : out,
    }];
}

const READERS = { 'pdok-plugin-list': readPdokPluginList, 'wms-capabilities': readWmsCapabilities };

const sources = readdirSync(SOURCES).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(SOURCES, f), 'utf8')))
    .filter(s => s.enabled !== false)
    .filter(s => !only || s.id === only);

if (!dryRun && !only && existsSync(OUT)) rmSync(OUT, { recursive: true });

let totalLayers = 0, totalServices = 0, failed = 0;
for (const source of sources) {
    const reader = READERS[source.type];
    if (!reader) { console.error(`✖ ${source.id}: no reader for type "${source.type}"`); failed++; continue; }
    process.stdout.write(`⛏  ${source.id} … `);
    let services;
    try { services = await reader(source); }
    catch (e) { console.log(`failed: ${e.message}`); failed++; continue; }

    const layers = services.reduce((n, s) => n + s.layers.length, 0);
    services = services.filter(s => s.layers.length > 0);
    const doc = {
        provider: {
            ...source.provider,
            abstract: source.title,
            categories: [], regions: (source.region ?? 'world').split('/').slice(1),
            cost: { model: source.provider.access === 'free' ? 'free' : 'freemium' },
            lifecycle: 'stable',
        },
        services,
    };
    const file = join(OUT, source.region ?? 'world', `${source.provider.id}.json`);
    if (!dryRun) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(doc, null, 2) + '\n'); }
    totalServices += services.length; totalLayers += layers;
    console.log(`${services.length} services, ${layers} layers → ${relative(ROOT, file)}`);
}
console.log(`\n${totalServices} services, ${totalLayers} layers from ${sources.length} source(s)` +
            (failed ? `, ${failed} failed` : ''));
if (dryRun) console.log('(dry-run: nothing written)');
