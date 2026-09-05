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

function providerJsonFiles(dir) {
    // Recursive — used when expanding a $ref directory; skips nested $ref link files
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'index.json') continue;
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
        if (entry === 'index.json') continue;
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

function indexEntry(file, region, refSource) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const providerId = raw.provider?.id;
    const layerStyles = providerId ? findLayerStyles(file, providerId) : {};
    return {
        path: relative(LAYERS_DIR, file),
        region,
        providerId,
        providerName: raw.provider?.name,
        access: raw.provider?.access,
        categories: raw.provider?.categories ?? [],
        layerCount: layerCount(raw),
        serviceCount: services(raw).length,
        requiresKey: allLayers(raw).some(l => l.requiresKey === true),
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

const outPath = join(LAYERS_DIR, 'index.json');
writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');
console.log(`✅ Wrote ${outPath} (${index.length} entries)`);
