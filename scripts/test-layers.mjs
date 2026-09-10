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
 *   node scripts/test-layers.mjs --harvested [--dry-run]
 *
 * --harvested probes harvested/ instead of layers/, one sample per service
 * rather than every layer, and writes its history to status/harvested/. See
 * sampleService() for what sampling can and cannot see.
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
import { services, layerEntries } from '../lib/catalog.mjs';
import { regionBounds } from '../lib/regions.mjs';
import { recordCheck, HISTORY_LIMIT } from '../lib/uptime.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const LAYERS_DIR = join(ROOT, 'layers');
const HARVESTED_DIR = join(ROOT, 'harvested');
const STATUS_DIR = join(ROOT, 'status');

/** Probes retained per layer: two years of the weekly cron. */
const TIMEOUT_MS = 8000;



const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
/**
 * Probe harvested/ instead of layers/, sampling each service rather than
 * testing every layer. See sampleService() for why the two modes differ.
 */
const harvestedMode = args.includes('--harvested');
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
const DEFAULT_BBOX = '-20037508.34,-10018754.17,0,0';

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

/** Longitude/latitude to Web Mercator metres. */
function toMercator([lng, lat]) {
    const R = 6378137;
    const y = Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180) / 2)) * R;
    return [lng * Math.PI / 180 * R, y];
}

/**
 * BBOX for a WMS probe. Asking a municipal layer to render a quarter of the
 * planet is slow enough to time out and says nothing about whether it works, so
 * probe inside the layer's own extent when it declares one.
 */
function sampleBbox(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 4) return DEFAULT_BBOX;
    const [w, s, e, n] = bounds;
    // A small box at the centre: enough to exercise the service, cheap to render.
    const cx = (w + e) / 2, cy = (s + n) / 2;
    const dx = Math.max((e - w) / 20, 0.01), dy = Math.max((n - s) / 20, 0.01);
    const [x0, y0] = toMercator([cx - dx, cy - dy]);
    const [x1, y1] = toMercator([cx + dx, cy + dy]);
    return `${x0.toFixed(2)},${y0.toFixed(2)},${x1.toFixed(2)},${y1.toFixed(2)}`;
}

function sampleTileUrl(url, bounds) {
    return substituteKeys(url)
        .replace(/\{z\}/g, TEST_ZOOM)
        .replace(/\{x\}/g, TEST_X)
        .replace(/\{y\}/g, TEST_Y)
        .replace(/\{quadkey\}/g, quadkey(TEST_ZOOM, TEST_X, TEST_Y))
        .replace(/\{ratio\}/g, '')
        .replace(/\{prefix\}/g, ((TEST_X % 16).toString(16) + (TEST_Y % 16).toString(16)))
        .replace(/{s}/g, 'a')
        .replace(/\{bbox-epsg-3857\}/g, sampleBbox(bounds));
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
function probeUrl(layer, regionHint) {
    const cfg = layer.webmapxConfig;
    if (!cfg) return null;
    // {time} is resolved before the request, exactly as a consumer would.
    const t = u => resolveTimeTokens(u, layer.time);
    // Composite styles carry a style-JSON URL instead of a tile template.
    if (cfg.url) return { url: t(substituteKeys(cfg.url)), method: 'GET' };
    const tiles = cfg.source?.tiles;
    if (Array.isArray(tiles) && tiles.length > 0) {
        return { url: t(sampleTileUrl(tiles[0], cfg.source?.bounds ?? regionHint)), method: 'HEAD' };
    }
    if (cfg.source?.url) return { url: t(substituteKeys(cfg.source.url)), method: 'GET' };
    // GeoJSON sources carry the endpoint in source.data, as a URL or inline object.
    if (typeof cfg.source?.data === 'string') {
        return { url: t(substituteKeys(cfg.source.data)), method: 'GET' };
    }
    return null;
}

/**
 * What a layer's config promises the response will be.
 *
 * A raster source must answer with an image, a GeoJSON source with JSON, a
 * composite style with its style document. Knowing this up front is what lets a
 * 200 be disbelieved.
 */
function expectedPayload(layer) {
    const cfg = layer.webmapxConfig ?? {};
    if (cfg.url) return 'json';                       // composite style document
    if (cfg.source?.type === 'geojson' || typeof cfg.source?.data === 'string') return 'json';
    if (Array.isArray(cfg.source?.tiles)) {
        return cfg.source.type === 'vector' ? 'binary' : 'image';
    }
    return 'any';
}

/**
 * A response body that answers 200 while carrying something other than the data.
 *
 * Three of these have already been found in this repository, so none is
 * hypothetical: a WMS answering 200 text/xml with a ServiceException because the
 * LAYERS name is wrong; an HTML error page from a service that lost its backend;
 * and a domain-parking page, after cmems-du.eu lapsed and was re-registered by a
 * third party, which this prober scored as up at 200 for five days running.
 */
const PARKED = /301domains|domain (is )?for sale|hugedomains|sedoparking|afternic|buy this domain|parked (free )?courtesy|intercepted by/i;

function classifyBody(body, contentType) {
    if (PARKED.test(body)) {
        return 'domain parked — this host no longer belongs to the provider';
    }
    // The tag must end here: ServiceExceptionReport is the wrapper, and matching
    // it captures the whitespace before the real message instead of the message.
    const fault = body.match(/<(?:ServiceException|ows:ExceptionText)(?:\s[^>]*)?>([^<]{0,160})/i);
    if (fault) return `service exception: ${fault[1].trim().replace(/\s+/g, ' ') || 'no message'}`;
    if (/^\s*<(!doctype\s+html|html)\b/i.test(body)) return 'HTML page where data was expected';
    return `content-type ${contentType || 'unknown'} where data was expected`;
}

/**
 * Does the response actually carry what the layer promised?
 *
 * A status code says the server answered, not that it answered with the layer.
 * The content type settles it in the common case; where it does not — a HEAD
 * that returned no type, or a type that contradicts the config — the body is
 * read and classified, so the reason recorded names what really came back.
 */
async function verifyPayload(res, expected, target, headers) {
    if (expected === 'any') return null;
    const ct = res.headers.get('content-type') ?? '';
    const wanted = { image: /^image\//i, json: /json|^text\/plain/i, binary: /octet-stream|protobuf|mvt|pbf|x-protobuf/i }[expected];
    if (wanted.test(ct)) return null;

    // A HEAD can answer without a content type at all; ask for the body before
    // calling a layer broken on the strength of a missing header.
    let body = '';
    try {
        const r = target.method === 'HEAD'
            ? await fetch(target.url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
            : res;
        const type = r.headers.get('content-type') ?? ct;
        if (target.method === 'HEAD' && wanted.test(type)) return null;
        body = (await r.text()).slice(0, 4000);
        return classifyBody(body, type);
    } catch {
        return `content-type ${ct || 'unknown'} where data was expected`;
    }
}

/**
 * One probe. Returns a check record matching status.schema.json:
 * { availability, httpStatus?, ms?, reason? }
 */
async function testLayer(layer, regionHint) {
    const target = probeUrl(layer, regionHint);
    if (!target) return { availability: 'unknown', reason: 'no testable endpoint in webmapxConfig' };

    const missing = [...requiredKeys(layer)].filter(k => !apiKeys[k]);
    if (missing.length > 0) {
        return { availability: 'unknown', reason: `missing key: ${missing.join(', ')}` };
    }

    const started = Date.now();
    try {
        const headers = REFERER ? { Referer: REFERER } : {};
        let res = await fetch(target.url, {
            method: target.method,
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Plenty of servers reject HEAD, and not always with the 405 that would
        // say so: ArcGIS Server answers 400 text/html to a HEAD and 200 image/png
        // to the same URL as a GET. A HEAD failure is therefore evidence about
        // HEAD, not about the layer — so any failed HEAD is asked again as the
        // GET a real consumer would send, and only that answer is recorded.
        if (!res.ok && target.method === 'HEAD') {
            res = await fetch(target.url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        }
        const ms = Date.now() - started;
        if (res.ok) {
            // A 200 is the server answering, not the layer working.
            const wrong = await verifyPayload(res, expectedPayload(layer), target, headers);
            if (wrong) return { availability: 'down', httpStatus: res.status, ms, reason: wrong };
            return { availability: 'up', httpStatus: res.status, ms };
        }
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

/**
 * What a failed probe says about the rest of the service.
 *
 * A verdict is evidence about one layer, but not only about that layer. Where
 * the failure landed decides how much more asking is worth doing:
 *
 * - 'stop'     — the endpoint itself is gone or refuses us. A name that does not
 *                resolve, a refused connection, an expired certificate, a
 *                timeout, a rejected credential: none of it is about the layer,
 *                and the next 400 probes would all fail the same way, slowly.
 * - 'escalate' — the endpoint answered and this layer did not work: a 404, or a
 *                200 carrying a ServiceException. That is exactly the ambiguity
 *                worth spending requests on, because it separates one rotten
 *                layer from a service whose every name is wrong.
 * - 'done'     — the layer worked, so the service works. Nothing left to learn.
 */
function escalationFor(check) {
    if (check.availability === 'up') return 'done';
    if (check.availability === 'auth-required') return 'stop';
    if (check.availability === 'unreachable') return 'stop';
    return 'escalate';
}

/** How many layers a service is worth asking about before calling it. */
const MAX_SAMPLES = 4;

/**
 * Layers to sample, spread across the service rather than taken from the front.
 *
 * Harvested services list their layers in the order the capabilities document
 * or the catalogue gave them, which tends to group related layers together. The
 * first four would therefore probe one corner of the service; four spread evenly
 * probe four different corners, which is what makes "all its names are wrong"
 * distinguishable from "the first one is".
 */
function spread(layers, count) {
    if (layers.length <= count) return layers.slice();
    const step = layers.length / count;
    return Array.from({ length: count }, (_, i) => layers[Math.floor(i * step)]);
}

/**
 * Probe one harvested service by sampling its layers.
 *
 * Harvested services are too many to test exhaustively — one recent harvest held
 * 22945 layers across 614 services — and testing them exhaustively would not buy
 * much: layers of one service share an endpoint, a capabilities document and a
 * naming scheme, so they tend to fail together. What sampling catches is the
 * systematic case, which is the one that matters: a service whose layer names
 * came from catalogue metadata rather than its own capabilities, where every
 * name is a description and nothing renders.
 *
 * The escalation is the point. One probe settles a working service; a failure
 * buys up to MAX_SAMPLES probes, but only when the failure was about the layer.
 * A dead host costs one request, not four.
 */
async function sampleService(service, regionHint) {
    const layers = service.layers ?? [];
    if (layers.length === 0) return { verdict: 'unknown', checks: [], reason: 'service lists no layers' };

    const candidates = spread(layers, MAX_SAMPLES);
    const checks = [];
    for (const layer of candidates) {
        const check = await testLayer(layer, regionHint);
        checks.push({ layer, check });
        const next = escalationFor(check);
        if (next === 'done' || next === 'stop') break;
    }

    // One layer answering is enough: the endpoint serves what it claims to. The
    // verdict otherwise is the first real failure, the sampled layers agreeing.
    const up = checks.find(c => c.check.availability === 'up');
    if (up) return { verdict: 'up', checks, reason: null };
    const worst = checks[0].check;
    const all = checks.length > 1 ? ` (${checks.length} layers sampled, none worked)` : '';
    return { verdict: worst.availability, checks, reason: `${worst.reason ?? ''}${all}` };
}

/** Legacy "status" field, kept in sync so the current UI keeps rendering. */
function legacyStatus(availability) {
    return (availability === 'up' || availability === 'auth-required') ? 'active' : 'unknown';
}

/** The tree a run reads its provider files from. */
const SOURCE_DIR = harvestedMode ? HARVESTED_DIR : LAYERS_DIR;

/**
 * Where a provider file's history lives.
 *
 * Harvested history goes under status/harvested/ rather than beside the curated
 * history: harvested/world/europe/netherlands/pdok.json and its curated namesake
 * would otherwise write to one file, and they are not the same layers.
 */
function historyPathFor(providerFile) {
    return harvestedMode
        ? join(STATUS_DIR, 'harvested', relative(HARVESTED_DIR, providerFile))
        : join(STATUS_DIR, relative(LAYERS_DIR, providerFile));
}

function loadHistory(providerFile, data) {
    const path = historyPathFor(providerFile);
    if (existsSync(path)) {
        try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* rebuild below */ }
    }
    return {
        provider: data.provider?.id ?? '',
        source: relative(SOURCE_DIR, providerFile),
        layers: {},
    };
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

const files = targetFile ? [resolve(ROOT, targetFile)]
    : existsSync(SOURCE_DIR) ? allProviderFiles(SOURCE_DIR) : [];
if (harvestedMode && files.length === 0) {
    console.log('ℹ️  no harvested/ directory — run: npm run harvest');
}

/** Region path a provider file sits at, e.g. world/europe/netherlands */
const regionOf = file => relative(SOURCE_DIR, file).split('/').slice(0, -1).join('/') || 'world';

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

    if (harvestedMode) {
        for (const service of services(data)) {
            const { verdict, checks, reason } = await sampleService(service, regionBounds(regionOf(file)));
            tally.total++;
            tally[verdict]++;

            // The history is keyed by service, not by layer: a sample says
            // something about the service, and recording it against whichever
            // layer happened to be drawn would make a layer's history a record
            // of the times it was picked.
            const summary = recordCheck(history.layers, service.id, {
                availability: verdict,
                ...(checks[0]?.check.httpStatus ? { httpStatus: checks[0].check.httpStatus } : {}),
                ...(reason ? { reason } : {}),
            }, today, HISTORY_LIMIT);

            const rate = summary.uptime === null ? 'no verdicts yet'
                : `${(summary.uptime * 100).toFixed(0)}% of ${summary.checks - summary.untested}`;
            const note = reason ? ` — ${reason}` : '';
            const sampled = `${checks.length}/${(service.layers ?? []).length} sampled`;
            console.log(`   ${ICON[verdict]} ${service.title ?? service.id}${note}  [${sampled}, ${rate}]`);

            if (service.availability !== verdict) { service.availability = verdict; layersChanged = true; }
            service.lastChecked = today;
        }
        if (!dryRun) {
            // harvested/ is a build artifact, but the previewer reads it through
            // layers/index.json, so the verdict is written where it will be read.
            writeJson(file, data);
            writeJson(historyPathFor(file), history);
            console.log(`   📈 ${relative(ROOT, historyPathFor(file))}`);
        }
        continue;
    }

    for (const { layer, service } of layerEntries(data)) {
        tally.total++;
        const check = await testLayer(layer, regionBounds(regionOf(file)));
        tally[check.availability]++;

        const summary = recordCheck(history.layers, layer.id, check, today, HISTORY_LIMIT);

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
        // A service is up if anything it serves is: one dead layer does not
        // condemn the endpoint, but a wholly dead endpoint should be visible.
        service._seen = (service._seen ?? []).concat(check.availability);
    }

    for (const s of services(data)) {
        if (!s._seen) continue;
        const rolled = s._seen.includes('up') ? 'up'
            : (s._seen.find(a => a !== 'unknown') ?? 'unknown');
        if (s.availability !== rolled) { s.availability = rolled; layersChanged = true; }
        delete s._seen;
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
console.log(`Tested ${tally.total} ${harvestedMode ? 'services' : 'layers'} — ✅ ${tally.up} up  ❌ ${tally.down} down  ` +
            `🚫 ${tally.unreachable} unreachable  🔒 ${tally['auth-required']} auth  ⚠️  ${tally.unknown} untested`);
if (dryRun) console.log('(dry-run: no files written)');
