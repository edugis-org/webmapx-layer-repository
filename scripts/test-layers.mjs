#!/usr/bin/env node
/**
 * Test layer availability by fetching a sample tile or endpoint for each layer.
 * Updates "status" and "lastChecked" fields in the JSON files.
 *
 * Usage:
 *   node scripts/test-layers.mjs [--file layers/world/openstreetmap.json] [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find(a => a.startsWith('--file=') || a === '--file');
const targetFile = fileArg
    ? (fileArg === '--file' ? args[args.indexOf('--file') + 1] : fileArg.slice(7))
    : null;

const TEST_ZOOM = 2, TEST_X = 2, TEST_Y = 1;

function sampleTileUrl(url) {
    return url
        .replace('{z}', TEST_ZOOM)
        .replace('{x}', TEST_X)
        .replace('{y}', TEST_Y)
        .replace(/{s}/g, 'a')
        .replace(/\{apikey:[^}]+\}/g, 'TEST_KEY')
        .replace(/\{bbox-epsg-3857\}/g, '-20037508.34,-10018754.17,0,0');
}

async function testLayer(layer) {
    const cfg = layer.webmapxConfig;
    if (!cfg) return { status: 'unknown', reason: 'no webmapxConfig' };

    const tiles = cfg.tiles;
    if (!Array.isArray(tiles) || tiles.length === 0) {
        return { status: 'unknown', reason: 'no tiles array' };
    }

    const url = sampleTileUrl(tiles[0]);
    try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (res.ok || res.status === 403 /* key required but endpoint exists */) {
            return { status: 'active' };
        }
        return { status: 'unknown', reason: `HTTP ${res.status}` };
    } catch (e) {
        return { status: 'unknown', reason: String(e.message ?? e) };
    }
}

function allJsonFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...allJsonFiles(full));
        } else if (entry.endsWith('.json')) {
            results.push(full);
        }
    }
    return results;
}

const files = targetFile
    ? [resolve(ROOT, targetFile)]
    : allJsonFiles(join(ROOT, 'layers'));

const today = new Date().toISOString().slice(0, 10);
let totalLayers = 0, passed = 0, failed = 0;

for (const file of files) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    let changed = false;

    console.log(`\n📂 ${file.replace(ROOT + '/', '')}`);
    console.log(`   Provider: ${data.provider.name}`);

    for (const layer of data.layers ?? []) {
        if (layer.requiresKey) {
            console.log(`   ⚠️  ${layer.title} — skipped (requires API key)`);
            continue;
        }
        totalLayers++;
        const result = await testLayer(layer);
        const icon = result.status === 'active' ? '✅' : '❌';
        console.log(`   ${icon} ${layer.title}${result.reason ? ' — ' + result.reason : ''}`);

        if (!dryRun && (layer.status !== result.status || layer.lastChecked !== today)) {
            layer.status = result.status;
            layer.lastChecked = today;
            changed = true;
        }
        if (result.status === 'active') passed++; else failed++;
    }

    if (changed && !dryRun) {
        writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        console.log(`   💾 updated`);
    }
}

console.log(`\n─────────────────────────────────`);
console.log(`Tested: ${totalLayers}  ✅ ${passed}  ❌ ${failed}`);
if (dryRun) console.log('(dry-run: no files written)');
