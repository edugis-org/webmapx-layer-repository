#!/usr/bin/env node
/**
 * Scans layers/ directory tree and writes layers/index.json.
 * Run after adding or removing provider files.
 * Also run by the GitHub Actions CI workflow.
 *
 * Link files: a JSON file containing only { "$ref": "../some/directory" } expands to all
 * provider files in the referenced directory, appearing under the link file's region.
 *
 * Usage: node scripts/build-index.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { layerCount, services, allLayers } from '../lib/catalog.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const LAYERS_DIR = join(ROOT, 'layers');
const HARVESTED_DIR = join(ROOT, 'harvested');

function providerJsonFiles(dir) {
    // Recursive — used when expanding a $ref directory; skips nested $ref link files
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'index.json' || entry === 'catalogues.json') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...providerJsonFiles(full));
        } else if (entry.endsWith('.json')) {
            try {
                const raw = JSON.parse(readFileSync(full, 'utf8'));
                if (!raw.$ref) results.push(full);
            } catch { /* skip unparseable */ }
        }
    }
    return results;
}

function allJsonFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'index.json' || entry === 'catalogues.json') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === 'styles') continue; // reserved — not a region
            results.push(...allJsonFiles(full));
        } else if (entry.endsWith('.json')) {
            results.push(full);
        }
    }
    return results;
}

function findLayerStyles(file, providerId) {
    // Look in {same-dir}/styles/{providerId}-{layerId}.json
    const stylesDir = join(file, '..', 'styles');
    if (!existsSync(stylesDir)) return {};
    const prefix = `${providerId}-`;
    const styleFiles = readdirSync(stylesDir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    const map = {};
    for (const sf of styleFiles) {
        try {
            const raw = JSON.parse(readFileSync(join(stylesDir, sf), 'utf8'));
            if (raw.layerId) {
                map[raw.layerId] = relative(LAYERS_DIR, join(stylesDir, sf));
            }
        } catch { /* skip */ }
    }
    return map;
}

const LAYER_NAME_CAP = 150;

/**
 * Every distinct line of real text a provider's layers carry.
 *
 * The index summarises a large provider into a word list, which answers "does
 * this provider mention `auto`" but cannot answer `"aantal autos"` — the word
 * order is gone. This keeps the sentences themselves, deduplicated, and is
 * written to a separate file the page fetches only when a query is quoted:
 * roughly 4% of the harvest's bytes, because the bulk of a harvested layer is
 * its ready-to-mount config, not its prose.
 */
function phraseLines(raw) {
    const lines = new Set();
    const add = value => {
        for (const v of [value].flat()) {
            if (typeof v === 'string' && v.trim()) lines.add(v.trim().toLowerCase());
        }
    };
    for (const service of services(raw)) {
        add(service.title); add(service.name); add(service.abstract); add(service.keywords);
        for (const layer of service.layers ?? []) {
            add(layer.title); add(layer.name); add(layer.abstract); add(layer.keywords);
        }
    }
    return [...lines];
}

/**
 * Every distinct word of 3+ characters from everything a layer is described
 * by, lowercased: its title AND its literal name, its abstract and keywords,
 * plus the titles and abstracts of the services holding it. Deduping keeps
 * this small even for a 17000-layer harvest, and the header search does
 * substring matching, so `auto` still finds "autos per huishouden".
 */
function layerWords(raw) {
    const words = new Set();
    const add = value => {
        for (const v of [value].flat()) {
            if (typeof v !== 'string') continue;
            for (const word of v.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
                if (word.length > 2) words.add(word);
            }
        }
    };
    for (const service of services(raw)) {
        add(service.title); add(service.name); add(service.abstract); add(service.keywords);
        for (const layer of service.layers ?? []) {
            add(layer.title); add(layer.name); add(layer.abstract); add(layer.keywords);
        }
    }
    return [...words];
}

/** path -> the provider's phrase lines, written out as layers/phrases.json. */
const phrases = {};

function indexEntry(file, region, refSource, harvested = false) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const providerId = raw.provider?.id;
    const layerStyles = providerId ? findLayerStyles(file, providerId) : {};
    const path = harvested
        ? `../harvested/${relative(HARVESTED_DIR, file)}`
        : relative(LAYERS_DIR, file);
    const lines = phraseLines(raw);
    if (lines.length) phrases[path] = lines;
    return {
        path: harvested
            ? `../harvested/${relative(HARVESTED_DIR, file)}`   // gitignored build output
            : relative(LAYERS_DIR, file),
        region,
        ...(harvested ? { harvested: true } : {}),
        providerId,
        providerName: raw.provider?.name,
        access: raw.provider?.access,
        categories: raw.provider?.categories ?? [],
        layerCount: layerCount(raw),
        serviceCount: services(raw).length,
        requiresKey: allLayers(raw).some(l => l.requiresKey === true),
        // Enough layer titles for the header search to find a provider by its
        // content, capped so a harvested WMS with hundreds of layers does not
        // dominate the index.
        layerNames: allLayers(raw).slice(0, LAYER_NAME_CAP)
            .map(l => l.title ?? l.name).filter(Boolean),
        // The capped titles keep phrase search working for the first layers;
        // this is every distinct word from every title, so a provider with
        // 12000 layers is still findable by a word from layer 9000. Deduped it
        // costs a couple of thousand entries, not a couple of hundred thousand.
        layerWords: layerWords(raw),
        ...(Object.keys(layerStyles).length ? { layerStyles } : {}),
        ...(refSource ? { linkedFrom: refSource } : {}),
    };
}

const files = allJsonFiles(LAYERS_DIR);
const index = [];

for (const file of files) {
    const rel = relative(LAYERS_DIR, file);
    const region = rel.split('/').slice(0, -1).join('/') || 'world';

    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));

        if (raw.$ref) {
            // $ref points to a directory — expand to all provider files there
            const targetDir = resolve(file, '..', raw.$ref);
            const stat = statSync(targetDir);
            if (!stat.isDirectory()) {
                console.warn(`⚠️  ${rel}: $ref is not a directory: ${raw.$ref}`);
                continue;
            }
            for (const provFile of providerJsonFiles(targetDir)) {
                index.push(indexEntry(provFile, region, rel));
            }
            console.log(`🔗 ${rel} → ${raw.$ref}/ (${providerJsonFiles(targetDir).length} providers)`);
        } else {
            index.push(indexEntry(file, region, null));
        }
    } catch (e) {
        console.warn(`⚠️  Skipped ${rel}: ${e.message}`);
    }
}

// harvested/ is produced by `npm run harvest` and is not in git. It is indexed
// when present so the site can serve it, and simply absent when it is not.
if (existsSync(HARVESTED_DIR)) {
    for (const file of providerJsonFiles(HARVESTED_DIR)) {
        const rel = relative(HARVESTED_DIR, file);
        const region = rel.split('/').slice(0, -1).join('/') || 'world';
        try { index.push(indexEntry(file, region, null, true)); }
        catch (e) { console.warn(`⚠️  harvested/${rel}: ${e.message}`); }
    }
    console.log(`⛏  included ${index.filter(e => e.harvested).length} harvested provider file(s)`);
} else {
    console.log('ℹ️  no harvested/ directory — run: npm run harvest');
}

/**
 * The catalogues the previewer may search live.
 *
 * A browser cannot list sources/, and the list of GeoNetwork catalogues is
 * curated there like every other endpoint, so it is projected out here — the
 * same curated/generated split the rest of the repository follows. Only what
 * the client needs travels: where to ask, what to call it, and the region to
 * frame results in.
 */
const catalogues = readdirSync(join(ROOT, 'sources'))
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(ROOT, 'sources', f), 'utf8')); } catch { return null; } })
    .filter(s => s && s.type === 'geonetwork-search' && s.enabled !== false)
    // A catalogue whose deployment refuses CORS preflight cannot be searched from
    // a page at all, so listing it would offer the reader a control that fails.
    .filter(s => s.liveSearch !== false)
    .map(s => ({
        id: s.id, title: s.title ?? s.provider?.name ?? s.id, url: s.url,
        provider: s.provider?.name, region: s.region ?? 'world',
        ...(s.bounds ? { bounds: s.bounds } : {}),
        ...(s.note ? { note: s.note } : {}),
    }));
writeFileSync(join(LAYERS_DIR, 'catalogues.json'), JSON.stringify(catalogues, null, 2) + '\n');
console.log(`🔎 Wrote layers/catalogues.json (${catalogues.length} searchable catalogue(s))`);

const phrasePath = join(LAYERS_DIR, 'phrases.json');
writeFileSync(phrasePath, JSON.stringify(phrases) + '\n');
const phraseKB = Math.round(statSync(phrasePath).size / 1024);
console.log(`💬 Wrote ${phrasePath} (${Object.keys(phrases).length} providers, ${phraseKB} KB)`);

const outPath = join(LAYERS_DIR, 'index.json');
writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');
console.log(`✅ Wrote ${outPath} (${index.length} entries)`);
