#!/usr/bin/env node
/**
 * Scans layers/ directory tree and writes layers/index.json.
 * Run after adding or removing provider files.
 * Also run by the GitHub Actions CI workflow.
 *
 * Usage: node scripts/build-index.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const LAYERS_DIR = join(ROOT, 'layers');

function allJsonFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'index.json') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...allJsonFiles(full));
        } else if (entry.endsWith('.json')) {
            results.push(full);
        }
    }
    return results;
}

const files = allJsonFiles(LAYERS_DIR);
const index = [];

for (const file of files) {
    const rel = relative(LAYERS_DIR, file);
    const parts = rel.split('/');
    const region = parts.slice(0, -1).join('/') || 'world';

    try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        index.push({
            path: rel,
            region,
            providerId: data.provider?.id,
            providerName: data.provider?.name,
            access: data.provider?.access,
            categories: data.provider?.categories ?? [],
            layerCount: data.layers?.length ?? 0,
        });
    } catch (e) {
        console.warn(`⚠️  Skipped ${rel}: ${e.message}`);
    }
}

const outPath = join(LAYERS_DIR, 'index.json');
writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');
console.log(`✅ Wrote ${outPath} (${index.length} providers)`);
