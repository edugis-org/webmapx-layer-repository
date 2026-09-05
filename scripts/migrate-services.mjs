#!/usr/bin/env node
/**
 * One-shot migration: provider.layers[] -> provider.services[].layers[]
 *
 * Services are inferred from the endpoints the layers already share. That
 * grouping is not a guess about the data — the endpoint is what a layer is
 * actually fetched from, so layers sharing one share an operator, a rate limit
 * and a failure mode. Rerunning is safe: files already migrated are skipped.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const LAYERS = join(ROOT, 'layers');
const dryRun = process.argv.includes('--dry-run');

/**
 * The endpoint a layer is served from.
 *
 * OGC services genuinely have one: a single URL answers GetCapabilities for all
 * their layers, so grouping on it reconstructs the real service. XYZ templates
 * have no such notion — the URL *is* the layer — so those group by origin, which
 * is the largest unit that still shares an operator, a rate limit and a failure
 * mode. Splitting them per template would produce one "service" per layer and
 * say nothing.
 */
function endpointOf(layer) {
    const cfg = layer.webmapxConfig ?? {};
    const u = cfg.source?.tiles?.[0] ?? cfg.source?.url ?? cfg.url ??
              (typeof cfg.source?.data === 'string' ? cfg.source.data : null);
    if (!u) return { endpoint: null, type: 'geojson' };

    let type = 'xyz';
    if (/service=wmts/i.test(u) || /\/wmts\//i.test(u)) type = 'wmts';
    else if (/service=wms|request=getmap/i.test(u)) type = 'wms';
    else if (/service=wfs/i.test(u)) type = 'wfs';
    else if (/\/ogc\//i.test(u)) type = 'ogc-api-tiles';
    else if (cfg.type === 'style' || (cfg.url && !cfg.source)) type = 'style';
    else if (cfg.source?.type === 'geojson') type = 'geojson';
    else if (cfg.source?.type === 'vector') type = 'vector-tiles';

    const [base] = u.split('?');
    let origin;
    try { origin = new URL(base.replace(/\{[^}]+\}/g, 'x')).origin; } catch { return { endpoint: null, type }; }

    if (type === 'wms' || type === 'wfs' || type === 'wcs') {
        return { endpoint: base, type };                    // one URL serves every layer
    }
    if (type === 'wmts' || type === 'ogc-api-tiles') {
        // RESTful WMTS puts style, matrix set and tile indices in the path;
        // the service ends at the version segment.
        const versioned = base.match(/^(.*\/(?:wmts|ogc)\/v[\d_]+)/i);
        if (versioned) return { endpoint: versioned[1], type };
        // RESTful WMTS templates run <service root>/<layer>/<style>/[<time>/]<matrixset>/...
        // so the service root is everything before the layer segment.
        const styled = base.match(/^(.*)\/[^/]+\/default\//i);
        if (styled) return { endpoint: styled[1], type };
        return { endpoint: base.replace(/\/[^/]*\{[^}]+\}[^/]*(?=\/|$)/g, ''), type };
    }
    return { endpoint: origin, type };                      // xyz, style, geojson, vector-tiles
}

const slug = s => String(s ?? 'service').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60) || 'service';

function providerFiles(dir) {
    const out = [];
    for (const e of readdirSync(dir)) {
        if (e === 'index.json') continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) { if (e !== 'styles') out.push(...providerFiles(full)); }
        else if (e.endsWith('.json')) {
            try { const r = JSON.parse(readFileSync(full, 'utf8')); if (r.$ref || !r.provider) continue; }
            catch { continue; }
            out.push(full);
        }
    }
    return out;
}

let migrated = 0, skipped = 0, services = 0;
for (const file of providerFiles(LAYERS)) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (doc.services) { skipped++; continue; }
    if (!Array.isArray(doc.layers) || doc.layers.length === 0) { skipped++; continue; }

    const groups = new Map();
    for (const layer of doc.layers) {
        const { endpoint, type } = endpointOf(layer);
        const key = `${type}|${endpoint ?? 'inline'}`;
        const g = groups.get(key) ?? { type, endpoint, layers: [] };
        g.layers.push(layer);
        groups.set(key, g);
    }

    const used = new Set();
    doc.services = [...groups.values()].map(g => {
        let id = slug(g.endpoint
            ? (g.endpoint.replace(/^https?:\/\/[^/]+/, '') || new URL(g.endpoint).hostname)
            : g.type);
        if (!id || id === 'service') id = g.type;
        if (!/[a-z]/.test(id)) id = `${g.type}-${id}`;
        while (used.has(id)) id += '-2';
        used.add(id);
        // Availability is measured per layer; the service is up if anything on it is.
        const avail = g.layers.some(l => l.availability === 'up') ? 'up'
                    : (g.layers.find(l => l.availability)?.availability ?? undefined);
        return {
            id,
            title: `${doc.provider.name} ${g.type.toUpperCase()}`,
            type: g.type,
            ...(g.endpoint ? { endpoint: g.endpoint } : {}),
            ...(avail ? { availability: avail } : {}),
            layers: g.layers,
        };
    });
    services += doc.services.length;
    delete doc.layers;
    if (!dryRun) writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    console.log(`${relative(ROOT, file).padEnd(58)} ${doc.services.length} service(s), ` +
                `${doc.services.reduce((a, s) => a + s.layers.length, 0)} layers`);
    migrated++;
}
console.log(`\nmigrated ${migrated} files into ${services} services, skipped ${skipped}`);
if (dryRun) console.log('(dry-run: nothing written)');
