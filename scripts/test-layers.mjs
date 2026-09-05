#!/usr/bin/env node
/**
 * Test layer availability by fetching a sample tile or style for each layer.
 *
 * Writes two things:
 *   1. layers/**.json  — the layer's current "availability" (+ "lastChecked"),
 *      a point-in-time snapshot.
 *   2. status/**.json  — an append-only history of every probe, mirroring the
 *      provider file's path under layers/. See schema/status.schema.json.
 *
 * The history is what separates a service that has been up for two years from
 * one that happens to answer today, so it lives in its own tree: appending to
 * the provider files would rewrite them weekly and bury hand edits in the diff.
 *
 * Usage:
 *   node scripts/test-layers.mjs [--file layers/world/openstreetmap.json] [--dry-run]
 *
 * API keys: copy apikeys.example.json → apikeys.json and fill in your keys.
 * In CI: pass keys via environment variables prefixed with APIKEY_ (e.g. APIKEY_OPENWEATHERMAP).
 * Layers whose key is missing are recorded as "unknown" rather than dropped, so
 * the history shows how much evidence an uptime figure actually rests on.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { resolveTimeTokens, hasTimeToken } from '../lib/time.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const LAYERS_DIR = join(ROOT, 'layers');
const STATUS_DIR = join(ROOT, 'status');

/** Probes retained per layer: two years of the weekly cron. */
const HISTORY_LIMIT = 104;
const TIMEOUT_MS = 8000;



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

/**
 * Origin to send as Referer. Some providers authenticate on it alone — Stadia
 * issues no API key and registers domains as Properties; MapTiler locks its key
 * to allowed origins — so probing without it records healthy layers as broken.
 *
 * Which origin is registered is an access credential of whoever runs this, like
 * the keys themselves, so it lives in apikeys.json (gitignored) or the
 * environment, never in this file.
 */
const REFERER = process.env.PROBE_REFERER ?? apiKeys.referer ?? null;
delete apiKeys.referer;   // an origin, not a {key-…} substitution
if (!REFERER) {
    console.log('ℹ️  No referer configured (apikeys.json "referer" or PROBE_REFERER).\n' +
                '   Origin-locked providers will be recorded as auth-required.');
}

function substituteKeys(url) {
    return url.replace(/\{key-([^}]+)\}/g, (match, name) => apiKeys[name] ?? match);
}

const TEST_ZOOM = 2, TEST_X = 2, TEST_Y = 1;

/** Bing-style quadkey for a tile, the same encoding MapLibre's {quadkey} produces. */
function quadkey(z, x, y) {
    let key = '';
    for (let i = z; i > 0; i--) {
        let digit = 0;
        const mask = 1 << (i - 1);
        if (x & mask) digit += 1;
        if (y & mask) digit += 2;
        key += digit;
    }
    return key;
}

function sampleTileUrl(url) {
    return substituteKeys(url)
        .replace(/\{z\}/g, TEST_ZOOM)
        .replace(/\{x\}/g, TEST_X)
        .replace(/\{y\}/g, TEST_Y)
        .replace(/\{quadkey\}/g, quadkey(TEST_ZOOM, TEST_X, TEST_Y))
        .replace(/\{ratio\}/g, '')
        .replace(/\{prefix\}/g, ((TEST_X % 16).toString(16) + (TEST_Y % 16).toString(16)))
        .replace(/{s}/g, 'a')
        .replace(/\{bbox-epsg-3857\}/g, '-20037508.34,-10018754.17,0,0');
}

/** Every {key-<name>} referenced anywhere in a layer's endpoints. */
function requiredKeys(layer) {
    const cfg = layer.webmapxConfig ?? {};
    const urls = [...(cfg.source?.tiles ?? [])];
    if (cfg.source?.url) urls.push(cfg.source.url);
    if (typeof cfg.source?.data === 'string') urls.push(cfg.source.data);
    if (cfg.url) urls.push(cfg.url);
    const keys = new Set();
    for (const u of urls) {
        for (const [, name] of u.matchAll(/\{key-([^}]+)\}/g)) keys.add(name);
    }
    return keys;
}

/** The single URL that stands in for the layer, or null if it has none. */
function probeUrl(layer) {
    const cfg = layer.webmapxConfig;
    if (!cfg) return null;
    // {time} is resolved before the request, exactly as a consumer would.
    const t = u => resolveTimeTokens(u, layer.time);
    // Composite styles carry a style-JSON URL instead of a tile template.
    if (cfg.url) return { url: t(substituteKeys(cfg.url)), method: 'GET' };
    const tiles = cfg.source?.tiles;
    if (Array.isArray(tiles) && tiles.length > 0) {
        return { url: t(sampleTileUrl(tiles[0])), method: 'HEAD' };
    }
    if (cfg.source?.url) return { url: t(substituteKeys(cfg.source.url)), method: 'GET' };
    // GeoJSON sources carry the endpoint in source.data, as a URL or inline object.
    if (typeof cfg.source?.data === 'string') {
        return { url: t(substituteKeys(cfg.source.data)), method: 'GET' };
    }
    return null;
}

/**
 * One probe. Returns a check record matching status.schema.json:
 * { availability, httpStatus?, ms?, reason? }
 */
async function testLayer(layer) {
    const target = probeUrl(layer);
    if (!target) return { availability: 'unknown', reason: 'no testable endpoint in webmapxConfig' };

    const missing = [...requiredKeys(layer)].filter(k => !apiKeys[k]);
    if (missing.length > 0) {
        return { availability: 'unknown', reason: `missing key: ${missing.join(', ')}` };
    }

    const started = Date.now();
    try {
        const res = await fetch(target.url, {
            method: target.method,
            headers: REFERER ? { Referer: REFERER } : {},
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const ms = Date.now() - started;
        if (res.ok) return { availability: 'up', httpStatus: res.status, ms };
        if (res.status === 401 || res.status === 403) {
            return {
                availability: 'auth-required', httpStatus: res.status, ms,
                reason: `HTTP ${res.status} (endpoint answered but rejected our credentials)`,
            };
        }
        return { availability: 'down', httpStatus: res.status, ms, reason: `HTTP ${res.status}` };
    } catch (e) {
        // No HTTP response at all: DNS failure, TLS error, timeout, connection refused.
        return { availability: 'unreachable', ms: Date.now() - started, reason: String(e.message ?? e) };
    }
}

/** Legacy "status" field, kept in sync so the current UI keeps rendering. */
function legacyStatus(availability) {
    return (availability === 'up' || availability === 'auth-required') ? 'active' : 'unknown';
}

const FAILURE = new Set(['down', 'unreachable', 'auth-required']);

function summarise(checks) {
    const verdicts = checks.filter(c => c.availability !== 'unknown');
    const up = verdicts.filter(c => c.availability === 'up');
    const untested = checks.length - verdicts.length;

    // Trailing failures since the last success. Probes we could not run are
    // stepped over rather than treated as either outcome.
    let consecutiveFailures = 0;
    for (let i = checks.length - 1; i >= 0; i--) {
        const a = checks[i].availability;
        if (a === 'up') break;
        if (FAILURE.has(a)) consecutiveFailures++;
    }

    const lastWith = pred => [...checks].reverse().find(pred)?.date;

    return {
        firstChecked: checks[0]?.date,
        lastChecked: checks[checks.length - 1]?.date,
        current: checks[checks.length - 1]?.availability,
        checks: checks.length,
        up: up.length,
        // Probes recorded as unknown are excluded from both sides: a layer we
        // could not test is not a layer that failed.
        uptime: verdicts.length ? Number((up.length / verdicts.length).toFixed(4)) : null,
        untested,
        consecutiveFailures,
        lastUp: lastWith(c => c.availability === 'up'),
        lastDown: lastWith(c => c.availability === 'down' || c.availability === 'unreachable'),
    };
}

function historyPathFor(providerFile) {
    return join(STATUS_DIR, relative(LAYERS_DIR, providerFile));
}

function loadHistory(providerFile, data) {
    const path = historyPathFor(providerFile);
    if (existsSync(path)) {
        try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* rebuild below */ }
    }
    return {
        provider: data.provider?.id ?? '',
        source: relative(LAYERS_DIR, providerFile),
        layers: {},
    };
}

function recordCheck(history, layerId, check, date) {
    const rec = history.layers[layerId] ??= { checks: [] };
    // Re-running on the same day replaces that day's entry instead of stacking.
    const existing = rec.checks.findIndex(c => c.date === date);
    const entry = { date, ...check };
    if (existing >= 0) rec.checks[existing] = entry;
    else rec.checks.push(entry);

    if (rec.checks.length > HISTORY_LIMIT) {
        rec.checks = rec.checks.slice(rec.checks.length - HISTORY_LIMIT);
    }
    rec.summary = summarise(rec.checks);
    return rec.summary;
}

function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function allProviderFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'index.json') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === 'styles') continue; // style-variant sidecars, not provider files
            results.push(...allProviderFiles(full));
        } else if (entry.endsWith('.json')) {
            try {
                const raw = JSON.parse(readFileSync(full, 'utf8'));
                if (raw.$ref) continue;      // link file — points at a dir already scanned
                if (!raw.provider) continue; // not a provider file
            } catch { continue; }
            results.push(full);
        }
    }
    return results;
}

const files = targetFile ? [resolve(ROOT, targetFile)] : allProviderFiles(LAYERS_DIR);

const today = new Date().toISOString().slice(0, 10);
const tally = { total: 0, up: 0, down: 0, unreachable: 0, 'auth-required': 0, unknown: 0 };

const ICON = { up: '✅', down: '❌', unreachable: '🚫', 'auth-required': '🔒', unknown: '⚠️ ' };

for (const file of files) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data.provider) {
        console.log(`\n⏭️  ${relative(ROOT, file)} — not a provider file, skipped`);
        continue;
    }
    const history = loadHistory(file, data);
    let layersChanged = false;

    console.log(`\n📂 ${relative(ROOT, file)}`);
    console.log(`   Provider: ${data.provider.name}`);

    for (const layer of data.layers ?? []) {
        tally.total++;
        const check = await testLayer(layer);
        tally[check.availability]++;

        const summary = recordCheck(history, layer.id, check, today);

        const note = check.reason ? ` — ${check.reason}` : '';
        const rate = summary.uptime === null ? 'no verdicts yet'
            : `${(summary.uptime * 100).toFixed(0)}% of ${summary.checks - summary.untested}`;
        console.log(`   ${ICON[check.availability]} ${layer.title}${note}  [${rate}]`);

        if (layer.availability !== check.availability || layer.lastChecked !== today) {
            layer.availability = check.availability;
            layer.status = legacyStatus(check.availability);  // transitional, for the current UI
            layer.lastChecked = today;
            layersChanged = true;
        }
    }

    if (!dryRun) {
        if (layersChanged) {
            writeJson(file, data);
            console.log(`   💾 ${relative(ROOT, file)}`);
        }
        writeJson(historyPathFor(file), history);
        console.log(`   📈 ${relative(ROOT, historyPathFor(file))}`);
    }
}

console.log(`\n─────────────────────────────────`);
console.log(`Tested ${tally.total} layers — ✅ ${tally.up} up  ❌ ${tally.down} down  ` +
            `🚫 ${tally.unreachable} unreachable  🔒 ${tally['auth-required']} auth  ⚠️  ${tally.unknown} untested`);
if (dryRun) console.log('(dry-run: no files written)');
