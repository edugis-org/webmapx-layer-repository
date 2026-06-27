#!/usr/bin/env node
/**
 * Test layer availability by fetching a sample tile or endpoint for each layer.
 * Updates "status" and "lastChecked" fields in the JSON files.
 *
 * Usage:
 *   node scripts/test-layers.mjs [--file layers/world/openstreetmap.json] [--dry-run]
 *
 * API keys: copy apikeys.example.json → apikeys.json and fill in your keys.
 * Layers with requiresKey:true are skipped unless apikeys.json provides the matching key.
 * In CI: pass keys via environment variables prefixed with APIKEY_ (e.g. APIKEY_OPENWEATHERMAP).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find(a => a.startsWith('--file=') || a === '--file');
const targetFile = fileArg
    ? (fileArg === '--file' ? args[args.indexOf('--file') + 1] : fileArg.slice(7))
    : null;

// Load API keys: file first, then env vars (CI)
let apiKeys = {};
const keysPath = join(ROOT, 'apikeys.json');
if (existsSync(keysPath)) {
    apiKeys = JSON.parse(readFileSync(keysPath, 'utf8'));
    console.log(`🔑 Loaded apikeys.json (${Object.keys(apiKeys).length} keys)`);
}
for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('APIKEY_')) {
        const name = k.slice(7).toLowerCase();
        if (!apiKeys[name]) apiKeys[name] = v;
    }
}

function substituteKeys(url) {
    return url.replace(/\{key-([^}]+)\}/g, (match, name) => apiKeys[name] ?? match);
}

const TEST_ZOOM = 2, TEST_X = 2, TEST_Y = 1;

function sampleTileUrl(url) {
    const substituted = substituteKeys(url);
    return substituted
        .replace('{z}', TEST_ZOOM)
        .replace('{x}', TEST_X)
        .replace('{y}', TEST_Y)
        .replace(/{s}/g, 'a')
        .replace(/\{bbox-epsg-3857\}/g, '-20037508.34,-10018754.17,0,0');
}

/** Return the set of key names referenced in a layer's tile URLs */
function requiredKeys(layer) {
    const tiles = layer.webmapxConfig?.tiles ?? [];
    const keys = new Set();
    for (const t of tiles) {
        for (const [, name] of t.matchAll(/\{key-([^}]+)\}/g)) keys.add(name);
    }
    return keys;
}

async function testLayer(layer) {
    const cfg = layer.webmapxConfig;
    if (!cfg) return { status: 'unknown', reason: 'no webmapxConfig' };

    const tiles = cfg.tiles;
    if (!Array.isArray(tiles) || tiles.length === 0) {
        return { status: 'unknown', reason: 'no tiles array' };
    }

    const needed = requiredKeys(layer);
    const missing = [...needed].filter(k => !apiKeys[k]);
    if (missing.length > 0) {
        return { status: null, reason: `skipped (missing key: ${missing.join(', ')})` };
    }

    const url = sampleTileUrl(tiles[0]);
    try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        if (res.ok) return { status: 'active' };
        if (res.status === 403) return { status: 'active', reason: 'HTTP 403 (key rejected or endpoint needs auth)' };
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
let totalLayers = 0, passed = 0, failed = 0, skipped = 0;

for (const file of files) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    let changed = false;

    console.log(`\n📂 ${file.replace(ROOT + '/', '')}`);
    console.log(`   Provider: ${data.provider.name}`);

    for (const layer of data.layers ?? []) {
        totalLayers++;
        const result = await testLayer(layer);

        if (result.status === null) {
            skipped++;
            console.log(`   ⚠️  ${layer.title} — ${result.reason}`);
            continue;
        }

        const icon = result.status === 'active' ? '✅' : '❌';
        const note = result.reason ? ` — ${result.reason}` : '';
        console.log(`   ${icon} ${layer.title}${note}`);

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
console.log(`Tested: ${totalLayers}  ✅ ${passed}  ❌ ${failed}  ⚠️  ${skipped} skipped`);
if (dryRun) console.log('(dry-run: no files written)');
