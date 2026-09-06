/**
 * Probe the endpoints in sources/, not the layers they yield.
 *
 * Availability is a property of a service, not of each dataset behind it. One
 * PDOK WMS answering means all 127 layers harvested from it are reachable, so
 * probing them individually measures the same fact ten thousand times — and
 * says nothing a consumer could not learn from one request.
 *
 * Alongside availability this records how many layers the source yields right
 * now. A service admin can add, rename or withdraw layers at any time, and a
 * changed count is the signal that the harvest is stale and should be re-run.
 *
 * Writes status/sources/<source-id>.json, in the same append-only shape as the
 * layer history: it accrues by observing and no rerun recreates it.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { recordCheck, HISTORY_LIMIT } from '../lib/uptime.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const SOURCES = join(ROOT, 'sources');
const STATUS_DIR = join(ROOT, 'status', 'sources');
// RIVM's full catalogue answers with a 75 MB capabilities document, which takes
// about half a minute on a good line. A probe that times out on size would
// record a healthy service as unreachable.
const TIMEOUT_MS = 180000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;

const apiKeys = existsSync(join(ROOT, 'apikeys.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'apikeys.json'), 'utf8'))
    : {};
for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('APIKEY_')) {
        const name = k.slice(7).toLowerCase();
        if (!apiKeys[name]) apiKeys[name] = v;
    }
}
const REFERER = process.env.PROBE_REFERER ?? apiKeys.referer ?? null;
delete apiKeys.referer;

const substituteKeys = url => url.replace(/\{key-([^}]+)\}/g, (m, n) => apiKeys[n] ?? m);

const XML = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const arr = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);

/** Layers a WMS capabilities document offers. Only those with a Name are requestable. */
function countWmsLayers(body) {
    const cap = XML.parse(body);
    const root = cap.WMS_Capabilities ?? cap.WMT_MS_Capabilities;
    let n = 0;
    (function walk(node) {
        for (const l of arr(node?.Layer)) {
            if (l.Name !== undefined) n++;
            walk(l);
        }
    })(root?.Capability);
    return n;
}

/** Entries a harvested catalogue lists. */
function countPdokPluginRows(body) {
    const rows = JSON.parse(body);
    return Array.isArray(rows) ? rows.length : 0;
}

const COUNTERS = {
    'wms-capabilities': countWmsLayers,
    'pdok-plugin-list': countPdokPluginRows,
};

/** One probe of a source's endpoint. Returns a check record. */
async function probeSource(source) {
    const url = substituteKeys(source.url);
    const started = Date.now();
    try {
        const res = await fetch(url, {
            headers: REFERER ? { Referer: REFERER } : {},
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const ms = Date.now() - started;
        if (res.status === 401 || res.status === 403) {
            return {
                availability: 'auth-required', httpStatus: res.status, ms,
                reason: `HTTP ${res.status} (endpoint answered but rejected our credentials)`,
            };
        }
        if (!res.ok) return { availability: 'down', httpStatus: res.status, ms, reason: `HTTP ${res.status}` };

        // The body is what harvesting reads, so counting it here measures the
        // same thing a re-harvest would find.
        const body = await res.text();
        const check = { availability: 'up', httpStatus: res.status, ms: Date.now() - started };
        const counter = COUNTERS[source.type];
        if (counter) {
            try { check.layersOffered = counter(body); }
            catch { check.reason = 'endpoint answered but its document could not be parsed'; }
        }
        return check;
    } catch (e) {
        return { availability: 'unreachable', ms: Date.now() - started, reason: String(e.message ?? e) };
    }
}

function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

const sources = readdirSync(SOURCES).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(SOURCES, f), 'utf8')))
    .filter(s => s.enabled !== false)
    .filter(s => !only || s.id === only);

const today = new Date().toISOString().slice(0, 10);
const ICON = { up: '✅', down: '❌', unreachable: '🚫', 'auth-required': '🔒', unknown: '⚠️ ' };
const tally = { up: 0, down: 0, unreachable: 0, 'auth-required': 0, unknown: 0 };

for (const source of sources) {
    const path = join(STATUS_DIR, `${source.id}.json`);
    const history = existsSync(path)
        ? JSON.parse(readFileSync(path, 'utf8'))
        : { source: source.id, provider: source.provider?.id ?? '', url: source.url, endpoints: {} };
    history.url = source.url;

    const check = await probeSource(source);
    tally[check.availability]++;
    const summary = recordCheck(history.endpoints, source.id, check, today, HISTORY_LIMIT);

    // A count that moved means the admin changed what the service offers, which
    // no amount of uptime tells you.
    const previous = history.endpoints[source.id].checks
        .slice(0, -1).reverse().find(c => typeof c.layersOffered === 'number')?.layersOffered;
    const drift = (typeof check.layersOffered === 'number' && typeof previous === 'number'
                   && check.layersOffered !== previous)
        ? ` ⚠️  offers ${check.layersOffered}, was ${previous} — re-harvest`
        : '';

    const rate = summary.uptime === null ? 'no verdicts yet'
        : `${(summary.uptime * 100).toFixed(0)}% of ${summary.checks - summary.untested}`;
    const offered = typeof check.layersOffered === 'number' ? `  ${check.layersOffered} layers` : '';
    console.log(`${ICON[check.availability]} ${source.id}${offered}  [${rate}]` +
                `${check.reason ? ` — ${check.reason}` : ''}${drift}`);

    if (!dryRun) {
        writeJson(path, history);
        console.log(`   📈 ${relative(ROOT, path)}`);
    }
}

console.log(`\n─────────────────────────────────`);
console.log(`Probed ${sources.length} sources — ✅ ${tally.up} up  ❌ ${tally.down} down  ` +
            `🚫 ${tally.unreachable} unreachable  🔒 ${tally['auth-required']} auth`);
if (dryRun) console.log('(dry-run: no files written)');
