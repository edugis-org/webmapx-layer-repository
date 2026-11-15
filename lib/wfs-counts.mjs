/**
 * How many features a WFS layer holds, asked of the service itself.
 *
 * A WFS publishes no total anywhere in its capabilities. The only way to know
 * is to ask: GetFeature with RESULTTYPE=hits and no filter answers with
 * numberMatched (2.0) or numberOfFeatures (1.1) and no features. webmapx uses
 * the number with the service's page size (CountDefault) to choose between
 * loading a layer whole and loading it per map view, so the client does not
 * have to ask on every page load.
 *
 * Counting is not free for the server: BAG pand (11.4 million buildings) takes
 * PDOK half a minute. So answers are kept between runs and only re-asked after
 * a while, each run spends at most a budget of time on it, and a layer whose
 * count is not known yet is simply written without one — webmapx then counts
 * for itself, and treats a slow answer as "a great many".
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const DAY = 24 * 3600 * 1000;

/** The parameters a count must not carry: paging, output format, filters on extent. */
const DROP = new Set(['count', 'maxfeatures', 'startindex', 'resulttype', 'outputformat', 'bbox']);

/** The hits request for a GetFeature URL. */
export function hitsUrl(getFeatureUrl) {
    const url = new URL(getFeatureUrl);
    for (const key of [...url.searchParams.keys()]) {
        if (DROP.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.set('RESULTTYPE', 'hits');
    return url.toString();
}

/** The count in a hits answer; undefined for "unknown", an exception, or anything else. */
export function parseHits(xml) {
    const m = /\bnumber(?:Matched|OfFeatures)\s*=\s*"(\d+)"/.exec(String(xml));
    return m ? Number(m[1]) : undefined;
}

function readCache(file) {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}

/**
 * Feature counts for GetFeature URLs.
 *
 * Returns a Map url → count for every url with a count, fresh or kept. A url
 * asked before and answered without a number is not asked again until it is
 * stale either: a server that says "unknown" will say it again.
 *
 * options: cacheFile, budgetMs (per run), maxAgeDays, timeoutMs (per count),
 * perHost (counts running at once against one host), fetchImpl, now.
 */
export async function featureCounts(urls, {
    cacheFile, budgetMs = 10 * 60 * 1000, maxAgeDays = 30, timeoutMs = 45000,
    perHost = 3, fetchImpl = fetch, now = Date.now(), log = () => {},
} = {}) {
    const cache = cacheFile ? readCache(cacheFile) : {};
    const fresh = (e) => e && now - e.at < maxAgeDays * DAY;
    const todo = [...new Set(urls)].filter(u => !fresh(cache[u]));
    const deadline = Date.now() + budgetMs;
    let asked = 0, answered = 0, deferred = 0;

    const byHost = new Map();
    for (const u of todo) {
        const host = new URL(u).host;
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(u);
    }
    await Promise.all([...byHost.values()].map(async (queue) => {
        await Promise.all(Array.from({ length: perHost }, async () => {
            for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
                if (Date.now() >= deadline) { deferred++; continue; }
                asked++;
                let count;
                try {
                    const res = await fetchImpl(hitsUrl(u), { signal: AbortSignal.timeout(timeoutMs) });
                    if (res.ok) count = parseHits(await res.text());
                } catch { /* timed out or refused: no count, asked again when stale */ }
                if (count !== undefined) answered++;
                cache[u] = { at: now, ...(count !== undefined ? { count } : {}) };
            }
        }));
    }));

    if (cacheFile) {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(cache));
    }
    log(`${asked} counted (${answered} answered), ${deferred} left for a later run, ${urls.length - todo.length} kept`);
    const out = new Map();
    for (const u of urls) if (Number.isFinite(cache[u]?.count)) out.set(u, cache[u].count);
    return out;
}
