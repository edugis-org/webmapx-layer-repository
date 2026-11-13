/** Stream the daily Allmaps GeoJSONL export, keeping each map ID only once. */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

export async function* snapshotPages(location, { pageSize = 200 } = {}) {
    let input;
    if (/^https?:/.test(location)) {
        const response = await fetch(location, { signal: AbortSignal.timeout(600000) });
        if (!response.ok) throw new Error(`Allmaps snapshot: HTTP ${response.status}`);
        input = Readable.fromWeb(response.body);
    } else {
        input = createReadStream(location);
    }
    const lines = createInterface({ input, crlfDelay: Infinity });
    const seen = new Set();
    let page = [];
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            const feature = JSON.parse(line);
            const id = feature?.properties?.id;
            if (feature.type !== 'Feature' || !id) throw new Error('Invalid Allmaps snapshot feature');
            if (seen.has(id)) continue;
            seen.add(id);
            page.push(feature);
            if (page.length >= pageSize) { yield page; page = []; }
        }
        if (page.length) yield page;
        if (!seen.size) throw new Error('Empty Allmaps snapshot');
    } finally {
        lines.close();
        input.destroy();
    }
}
