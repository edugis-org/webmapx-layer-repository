/**
 * What the holding institution says about a map: who made it, when, and what
 * it is about.
 *
 * The Allmaps snapshot carries a title and an outline but no maker, no date
 * field and no subject — those live only in the institution's own IIIF
 * manifest, which the snapshot links to. That manifest is a catalogue record
 * in whatever shape the institution's cataloguing system emits: 249 hosts, IIIF
 * Presentation 2 and 3, labels in English, Dutch, German and French, and no
 * agreement on what to call anything ("Creator", "Author/Creator", "Names",
 * "Cartographer"; "Date Issued", "Publication year", "Erscheinungsjahr").
 *
 * So this reads only what a person looking for a map asks for — maker,
 * date, scale, subject — by matching label names, and leaves everything else
 * (rights, shelfmarks, contact details) in the manifest, one link away.
 */

/** Label patterns, tried in order: a cartographer outranks a generic name list. */
const CREATOR = [
    /^(creator|author|cartographer|maker|auteur|vervaardiger|kartograph|cartographe)\b/,
    /^(creator\/contributor|author\/creator|author\/ creator|names?|contributor|md_author_creator)$/,
];
/**
 * Every label that may hold a date. None is trusted on its own: Leiden fills
 * both "Date issued" and "Publication date" with the year the *scan* was
 * published (2016) and keeps 1850 under "Published". A digital copy is never
 * older than its map, so the earliest year across these fields is the map's.
 */
const DATE = /^(date|dates?( \/ origin)?|datum|jaar|year|published|publication( date| year)?|date of publication|year of publication|erscheinungsjahr|jaar van uitgave|datum uitgave|time period|periode|date statement|date created|date issued)\b/;
const SCALE = [
    /^(scale|schaal|maßstab|massstab|échelle|echelle|map scale)\b/,
    /^(cartographic information|cartographic data|mathematical data)\b/,
];
const SUBJECT = /^(subjects?|topic|keywords?|genres?|onderwerp|trefwoord(en)?|schlagwort|sujet|subject \(topical\))\b/;

/** Plain text of an IIIF value: a string, a language map, a v2 @value or a list of those. */
export function textOf(value) {
    if (value == null) return [];
    if (typeof value === 'string' || typeof value === 'number') return [String(value)];
    if (Array.isArray(value)) return value.flatMap(textOf);
    if (typeof value === 'object') {
        if ('@value' in value) return textOf(value['@value']);
        return Object.values(value).flatMap(textOf);
    }
    return [];
}

/** A catalogue value as one display line: tags stripped, entities decoded, spaces folded. */
function clean(text) {
    return text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, m => ({
            '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
        }[m]))
        .replace(/\s+/g, ' ')
        .trim();
}

/** The manifest's metadata pairs as [lowercased label variants, values]. */
function entries(manifest) {
    return (Array.isArray(manifest?.metadata) ? manifest.metadata : []).map(entry => [
        textOf(entry?.label).map(l => clean(l).toLowerCase()),
        textOf(entry?.value).map(clean).filter(Boolean),
    ]);
}

function firstMatch(pairs, patterns) {
    for (const pattern of patterns) {
        for (const [labels, values] of pairs) {
            if (values.length && labels.some(l => pattern.test(l))) return values;
        }
    }
    return null;
}

/** The first plausible year in a date statement: "1912-01-01", "[ca. 1860]", "1858-1862". */
export function yearOf(text) {
    for (const match of String(text ?? '').matchAll(/(?<!\d)(1[4-9]\d{2}|20[0-3]\d)(?!\d)/g)) {
        return Number(match[1]);
    }
    return null;
}

/**
 * The denominator of a stated scale: "1:600", "1 : 25 000", "Scale 1:63,360".
 * Verbal scales ("50 feet to an inch") are left as text; converting units is
 * guesswork the catalogue did not ask for.
 */
export function scaleDenominator(text) {
    const match = String(text ?? '').match(/\b1\s*:\s*(\d{1,3}(?:[ .,\u00a0]\d{3})+|\d+)/);
    if (!match) return null;
    const n = Number(match[1].replace(/[ .,\u00a0]/g, ''));
    return Number.isFinite(n) && n >= 10 ? n : null;
}

/**
 * Maker, date, scale and subjects from one IIIF manifest, or null when it names none.
 *
 * The date is the catalogue's own wording ("[ca. 1860]"), kept as text because
 * that is what it is, with `year` derived from it for sorting and filtering;
 * IIIF's `navDate` takes part as one more candidate.
 */
export function catalogueRecord(manifest) {
    const pairs = entries(manifest);
    const creators = firstMatch(pairs, CREATOR);
    const navDate = typeof manifest?.navDate === 'string' ? manifest.navDate : null;
    const dated = pairs.filter(([labels]) => labels.some(l => DATE.test(l)))
        .flatMap(([, values]) => values)
        .concat(navDate ? [navDate.slice(0, 10)] : [])
        .filter(d => yearOf(d) && d.length <= 120)
        .sort((a, b) => yearOf(a) - yearOf(b));
    // A long "Published" statement ("'s-Gravenhage ; Gebroeders van Cleef,
    // 1850 (...)") is a sentence, not a date: the year stands in for it.
    const date = dated[0] ? (dated[0].length <= 40 ? dated[0] : String(yearOf(dated[0]))) : null;
    const year = yearOf(date);
    const scales = firstMatch(pairs, SCALE);
    // "Cartographic Information" also holds coordinates, so from that field only
    // the part that states a scale is kept.
    const scaleText = scales?.map(v => v.split(/\s*\|\s*/).find(p => /\d/.test(p) && /scale|schaal|ma(ß|ss)stab|échelle|1\s*:/i.test(p)))
        .find(Boolean) ?? null;
    const scale = scaleText ? scaleText.replace(/^(scale|schaal)\s*/i, '').replace(/^[:\s]+/, '').trim() : null;
    const denominator = scaleDenominator(scaleText);

    const subjects = [];
    for (const [labels, values] of pairs) {
        if (!labels.some(l => SUBJECT.test(l))) continue;
        for (const value of values) {
            // One field often holds a whole list: "Fire insurance maps| Digital maps",
            // "Netherlands -- Maps", "Kaarten; Steden".
            for (const part of value.split(/\s*(?:\||;|--|\n)\s*/)) {
                const subject = part.replace(/[.,]$/, '').trim();
                if (subject && subject.length <= 80 && !/^(unspecified|unknown|onbekend|n\/a)$/i.test(subject) && !subjects.some(s => s.toLowerCase() === subject.toLowerCase())) {
                    subjects.push(subject);
                }
            }
        }
    }

    const record = {
        ...(creators ? { creator: creators.slice(0, 3).join('; ') } : {}),
        ...(date ? { date } : {}),
        ...(year ? { year } : {}),
        ...(scale ? { scale } : {}),
        ...(denominator ? { scaleDenominator: denominator } : {}),
        ...(subjects.length ? { subjects: subjects.slice(0, 10) } : {}),
    };
    return Object.keys(record).length ? record : null;
}

/**
 * The urls reordered so hosts take turns: one from each host, then the next
 * from each, and so on, each host keeping its own order.
 *
 * A run reads a fixed number of manifests. Taken in snapshot order, the first
 * 5000 went to UChicago (2757, all without metadata) and UT Austin (1748,
 * resetting connections), and NYPL — 11,000 manifests that all answer — got
 * 264. Taking turns gives every library a share and keeps any one host's
 * queue, and so the run's length, short.
 */
export function interleaveByHost(urls) {
    const byHost = new Map();
    for (const url of urls) {
        let host;
        try { host = new URL(url).host; } catch { host = ''; }
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(url);
    }
    const queues = [...byHost.values()];
    const out = [];
    for (let i = 0; out.length < urls.length; i++) {
        for (const queue of queues) if (i < queue.length) out.push(queue[i]);
    }
    return out;
}

/**
 * Fetch and read manifests, gently: a few at a time per host, because these are
 * library servers answering a harvest, not a CDN.
 *
 * Resolves to a Map of url -> record (null when the manifest answered but
 * names nothing usable, or answered with something that is not a manifest).
 * A url missing from the result failed transiently — a timeout or a 5xx — and
 * is worth asking again on the next run, or was never asked because its host
 * had stopped answering or the run's `budget` (ms) ran out; those are added to
 * `skipped` when given.
 */
export async function fetchCatalogue(urls, {
    fetchImpl = fetch, perHost = 1, concurrency = 64, timeout = 20000, onProgress, stats,
    pause = 250, giveUpAfter = 10, maxPause = 30000, skipped, budget = Infinity,
} = {}) {
    const result = new Map();
    // Hosts are read one request at a time, so a run lasts as long as its
    // biggest host's queue: 2494 NYPL manifests took 29 minutes on their own.
    // Past the budget no new request starts; the rest stay unread for next run.
    const deadline = Date.now() + budget;
    const tally = (url, outcome) => {
        if (!stats) return;
        let host = '?';
        try { host = new URL(url).host; } catch { /* counted under ? */ }
        stats[host] ??= {};
        stats[host][outcome] = (stats[host][outcome] ?? 0) + 1;
    };
    const byHost = new Map();
    for (const url of new Set(urls)) {
        let host;
        try { host = new URL(url).host; } catch { result.set(url, null); continue; }
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host).push(url);
    }
    // Hosts are worked in parallel, each by at most `perHost` workers, so one
    // slow library does not hold up the rest and no library sees a burst.
    const lanes = [];
    for (const queue of byHost.values()) {
        for (let i = 0; i < Math.min(perHost, queue.length); i++) lanes.push(queue);
    }
    let done = 0;
    // A host that fails `giveUpAfter` times in a row is left alone for the rest
    // of the run. UT Austin started resetting connections after a harvest asked
    // it for ~1000 manifests; carrying on would only have asked 1900 more times.
    const failures = new Map();
    const work = async queue => {
        for (;;) {
            const url = queue.pop();
            if (!url) return;
            const host = new URL(url).host;
            if (Date.now() >= deadline) {
                tally(url, 'deferred');
                skipped?.add(url);
                onProgress?.(++done);
                continue;
            }
            if ((failures.get(host) ?? 0) >= giveUpAfter) {
                tally(url, 'skipped');
                skipped?.add(url);
                onProgress?.(++done);
                continue;
            }
            let transient = false;
            try {
                const res = await fetchImpl(url, {
                    signal: AbortSignal.timeout(timeout),
                    // A bare JSON Accept gets a 404 from Digital Commonwealth;
                    // the wildcard keeps servers that ignore Accept working.
                    headers: { accept: 'application/ld+json, application/json;q=0.9, */*;q=0.8' },
                });
                if (res.status >= 500 || res.status === 429) { transient = true; tally(url, 'transient'); } // not cached
                else if (!res.ok) { result.set(url, null); tally(url, `http-${res.status}`); }
                else {
                    let manifest = null;
                    try { manifest = JSON.parse(await res.text()); } catch { /* an HTML challenge page */ }
                    const record = manifest ? catalogueRecord(manifest) : null;
                    result.set(url, record);
                    tally(url, !manifest ? 'not-json' : record ? 'record' : 'empty');
                }
            } catch { transient = true; tally(url, 'transient'); } // network error or timeout: not cached
            failures.set(host, transient ? (failures.get(host) ?? 0) + 1 : 0);
            onProgress?.(++done);
            // One request at a time per host, with a pause between: a library
            // server should see a slow reader, not a burst. Each failure in a
            // row doubles the pause, so a host that is rate-limiting us gets
            // minutes to recover before we give up on it for the run.
            const wait = Math.min(maxPause, pause * 2 ** (failures.get(host) ?? 0));
            if (wait && queue.length) await new Promise(r => setTimeout(r, wait));
        }
    };
    // Run `concurrency` lanes at a time, pulling the next lane as one empties.
    // A lane is one host, so this is how many libraries are read at once, not
    // how hard any one is asked. At 16, a batch spread over dozens of hosts
    // (264 each) queued them in waves and took 31 minutes.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, lanes.length) }, async () => {
        while (next < lanes.length) await work(lanes[next++]);
    }));
    return result;
}
