/**
 * Portolan catalogs as a layer source.
 *
 * Portolan (https://github.com/portolan-sdi/portolan-spec) is static STAC for
 * cloud-native geodata: a tree of `catalog.json` files whose leaves are
 * collections, one dataset each (`collection.json`, with its GeoParquet,
 * PMTiles and MapLibre styles as assets). PolderGIS publishes its libraries
 * this way. For this repository a catalog is a service offering many layers,
 * like a WMS capabilities document: the harvest lists every collection, and
 * an author picks the ones a map shows.
 *
 * A layer's webmapxConfig names the collection, never its files:
 * `{ type: 'style', url: '<collection.json>' }`. webmapx reads the collection
 * when the map loads and draws it in the publisher's default style (webmapx
 * docs/adr/0001-portolan-catalogs.md). Publishers such as PolderGIS put a
 * content hash in every data file name and serve collection.json uncached, so
 * the collection always points at the current files; a config naming the
 * PMTiles directly would break at the next republication.
 *
 * Imports nothing and uses only `fetch`, like geonetwork.mjs, so the same file
 * is the harvest reader and the previewer's live client.
 */

const MAX_CATALOGS = 200;

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : undefined);
const roles = (o) => (Array.isArray(o?.roles) ? o.roles.filter((r) => typeof r === 'string') : []);
const links = (doc) => (Array.isArray(doc?.links) ? doc.links.filter(isRecord) : []);

/** Resolves `href` against `base`; null for anything that is not http(s) — catalog JSON is not ours. */
export function resolveHref(href, base) {
    if (!str(href)) return null;
    try {
        const url = new URL(href, base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

const isBBox = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n));

/** A collection's WGS84 extent as [west, south, east, north], or null. */
export function collectionBounds(collection) {
    const first = collection?.extent?.spatial?.bbox?.[0];
    if (!Array.isArray(first) || !first.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    if (first.length === 4) return first;
    if (first.length === 6) return [first[0], first[1], first[3], first[4]];
    return null;
}

/**
 * What a collection holds, as far as drawing it goes:
 * `vector` (PMTiles, or GeoParquet with a geometry column), `raster` (a COG),
 * `table` (Parquet without geometry) or null when there is nothing to show.
 */
export function collectionKind(collection) {
    const assets = isRecord(collection?.assets) ? Object.values(collection.assets).filter(isRecord) : [];
    const typeOf = (a) => String(a.type ?? '').toLowerCase();
    if (assets.some((a) => roles(a).includes('visual') && typeOf(a).startsWith('application/vnd.pmtiles'))) return 'vector';
    const data = assets.find((a) => roles(a).includes('data'));
    if (!data) return null;
    if (typeOf(data).startsWith('image/tiff')) return 'raster';
    if (typeOf(data).startsWith('application/vnd.apache.parquet')) {
        const columns = Array.isArray(collection['table:columns']) ? collection['table:columns'] : [];
        const geometry = str(collection['table:primary_geometry'])
            || columns.some((c) => /^geometry\b/i.test(String(c?.type ?? '')));
        return geometry ? 'vector' : 'table';
    }
    return null;
}

/** One line of credit: the collection's own `attribution`, else its producers and licensors, plus the licence. */
export function collectionAttribution(collection) {
    const providers = Array.isArray(collection?.providers) ? collection.providers.filter(isRecord) : [];
    const makers = providers
        .filter((p) => roles(p).some((r) => r === 'producer' || r === 'licensor'))
        .map((p) => str(p.name)).filter(Boolean);
    const who = str(collection?.attribution) ?? (makers.length ? [...new Set(makers)].join(' / ') : undefined);
    const licence = str(collection?.license);
    const licenceText = licence && licence !== 'other' && licence !== 'proprietary' ? licence : undefined;
    if (!who) return licenceText ?? null;
    return licenceText ? `© ${who}, ${licenceText}` : `© ${who}`;
}

/** Slug for ids: lower case, runs of anything else become one dash. */
export function slug(value) {
    return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

/**
 * Every collection a catalog offers, as `{ url, title, group, kind, bbox }` — what a
 * listing needs, read as cheaply as the catalog allows:
 *
 * - A PolderGIS library links a flat index (`rel: "pg:index"`) naming every layer
 *   with its title, group path, kind and bbox: one request, however deep the tree.
 * - Otherwise the tree is walked: `child` links to catalogs are followed, `child`
 *   (and `item`) links to collections are listed. Bounded by `maxCatalogs`, and a
 *   catalog reached twice is read once. A link's own `title` and PolderGIS's
 *   `pg:bbox`/`pg:kind` on it are used when present, so a listing needs no
 *   request per collection; `kind`/`bbox` are otherwise null until the
 *   collection itself is read.
 *
 * `fetchJson(url)` is injected so the harvest can retry and the browser can use
 * plain fetch. Groups are the titles of the catalogs on the way down, a label for
 * the layer rather than something to choose (PolderGIS ADR 0006 point 9).
 */
export async function listCollections(rootUrl, { fetchJson = defaultFetchJson, maxCatalogs = MAX_CATALOGS } = {}) {
    const root = await fetchJson(rootUrl);
    if (!isRecord(root)) throw new Error(`${rootUrl} is not a STAC catalog`);
    if (root.type === 'Collection') {
        return { title: str(root.title) ?? rootUrl, collections: [{ url: rootUrl, title: str(root.title) ?? rootUrl, group: [], kind: collectionKind(root), bbox: collectionBounds(root) }] };
    }

    const indexLink = links(root).find((l) => l.rel === 'pg:index');
    const indexUrl = indexLink ? resolveHref(indexLink.href, rootUrl) : null;
    if (indexUrl) {
        try {
            const index = await fetchJson(indexUrl);
            if (index?.type === 'pg:index' && Array.isArray(index.layers)) {
                const collections = index.layers.filter(isRecord).flatMap((entry) => {
                    const url = resolveHref(entry.href, indexUrl);
                    if (!url || (entry.format && entry.format !== 'collection')) return [];
                    return [{
                        url,
                        title: str(entry.title) ?? url,
                        group: Array.isArray(entry.path) ? entry.path.filter((p) => typeof p === 'string') : [],
                        kind: str(entry.kind) ?? null,
                        bbox: isBBox(entry.bbox) ? entry.bbox : null,
                    }];
                });
                return { title: str(root.title) ?? rootUrl, collections };
            }
        } catch {
            // An unreadable index is a missing shortcut, not a missing catalog: walk the tree.
        }
    }

    const collections = [];
    const seen = new Set([rootUrl]);
    const queue = [{ url: rootUrl, doc: root, group: [] }];
    let read = 1;
    while (queue.length) {
        const { url, doc, group } = queue.shift();
        for (const link of links(doc)) {
            if (link.rel !== 'child' && link.rel !== 'item') continue;
            const href = resolveHref(link.href, url);
            if (!href || seen.has(href)) continue;
            seen.add(href);
            // A link names what it points at only by convention: collection.json
            // for a collection, catalog.json for a catalog. Anything else is read.
            const looksLikeCollection = /(^|\/)collection\.json$/i.test(new URL(href).pathname);
            const looksLikeCatalog = /(^|\/)catalog\.json$/i.test(new URL(href).pathname);
            if (looksLikeCollection || (!looksLikeCatalog && link.rel === 'item')) {
                collections.push({
                    url: href,
                    title: str(link.title) ?? href,
                    group,
                    kind: str(link['pg:kind']) ?? null,
                    bbox: isBBox(link['pg:bbox']) ? link['pg:bbox'] : null,
                });
                continue;
            }
            if (read >= maxCatalogs) continue;
            read++;
            let child;
            try { child = await fetchJson(href); } catch { continue; } // one unreadable group hides only its own layers
            if (child?.type === 'Collection') {
                collections.push({ url: href, title: str(child.title) ?? str(link.title) ?? href, group, kind: collectionKind(child), bbox: collectionBounds(child) });
            } else if (child?.type === 'Catalog') {
                queue.push({ url: href, doc: child, group: [...group, str(child.title) ?? str(link.title) ?? ''] });
            }
        }
    }
    return { title: str(root.title) ?? rootUrl, collections };
}

/**
 * A collection as a layer record of this repository.
 *
 * `idPrefix` keeps ids unique across catalogs (several libraries can each hold a
 * "provinces"); the collection's own id makes them stable across harvests,
 * because a saved config refers to the layer id.
 */
export function layerFromCollection(collection, url, { idPrefix = 'portolan', group = [] } = {}) {
    const id = `${slug(idPrefix)}-${slug(str(collection.id) ?? url)}`;
    const title = str(collection.title) ?? str(collection.id) ?? url;
    const kind = collectionKind(collection);
    const bounds = collectionBounds(collection);
    const attribution = collectionAttribution(collection);
    const description = str(collection.description);
    const abstract = [
        description,
        group.length ? `In ${group.filter(Boolean).join(' › ')}.` : null,
    ].filter(Boolean).join(' ') || undefined;
    const columns = Array.isArray(collection['table:columns']) ? collection['table:columns'].filter(isRecord) : [];
    const attributes = columns.flatMap((c) => {
        const name = str(c.name);
        if (!name) return [];
        const type = str(c.type);
        // The table extension spells geometry as `geometry(...)`; PolderGIS writes the
        // Parquet physical type (`binary`) for the WKB column instead.
        const geometry = /^geometry\b/i.test(type ?? '') || name === str(collection['table:primary_geometry'])
            || (type === 'binary' && /^(geom|geometry|wkb_geometry|the_geom)$/i.test(name));
        return [{ name, ...(type ? { type } : {}), ...(str(c.description) ? { title: str(c.description) } : {}), ...(geometry ? { geometry: true } : {}) }];
    });
    const thumbnail = isRecord(collection.assets)
        ? Object.values(collection.assets).filter(isRecord).find((a) => roles(a).includes('thumbnail'))
        : undefined;
    const thumbnailUrl = thumbnail ? resolveHref(thumbnail.href, url) : null;
    const styles = isRecord(collection.assets)
        ? Object.entries(collection.assets).filter(([, a]) => isRecord(a) && roles(a).includes('style'))
            .map(([key, a]) => ({ key, title: str(a.title) ?? key, default: roles(a).includes('default') }))
        : [];

    return {
        id,
        name: str(collection.id) ?? url,
        title,
        ...(abstract ? { abstract } : {}),
        type: kind === 'raster' ? 'raster' : 'vector',
        requiresKey: false,
        ...(attributes.length ? { attributes, attributesFrom: url } : {}),
        webmapxConfig: {
            type: 'style',
            id,
            url,
            ...(attribution ? { attribution } : {}),
            metadata: {
                title,
                ...(abstract ? { abstract } : {}),
                ...(bounds ? { bounds } : {}),
                portolan: {
                    collection: url,
                    kind,
                    ...(str(collection.license) ? { license: str(collection.license) } : {}),
                    ...(styles.length ? { styles } : {}),
                    ...(thumbnailUrl ? { thumbnail: thumbnailUrl } : {}),
                },
            },
        },
    };
}

async function defaultFetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
}

/**
 * The catalogs a Portolan registry lists (https://registry.portolan-sdi.org/v0.1/catalogs.json):
 * a STAC Catalog whose `child` links are the registered catalogs, each annotated
 * with the registry's own summary under `portolan_registry:` — enough to choose
 * one without opening it.
 */
export async function registryCatalogs(url, { fetchJson = defaultFetchJson } = {}) {
    const registry = await fetchJson(url);
    if (!isRecord(registry)) throw new Error(`${url} is not a STAC catalog`);
    const p = (link, key) => link[`portolan_registry:${key}`];
    return links(registry).filter((l) => l.rel === 'child').flatMap((link) => {
        const href = resolveHref(link.href, url);
        if (!href) return [];
        const host = p(link, 'host');
        const producers = Array.isArray(p(link, 'producers')) ? p(link, 'producers').map((x) => str(x?.name)).filter(Boolean) : [];
        const licences = Array.isArray(p(link, 'licenses')) ? p(link, 'licenses').map((x) => str(x?.id)).filter(Boolean) : [];
        return [{
            id: str(p(link, 'id')) ?? slug(href),
            title: str(link.title) ?? href,
            url: href,
            bbox: isBBox(link.bbox) ? link.bbox : null,
            status: str(p(link, 'status')) ?? null,
            valid: typeof p(link, 'stac_valid') === 'boolean' ? p(link, 'stac_valid') : null,
            kind: str(p(link, 'kind')) ?? null,
            host: str(host?.name) ?? null,
            producers,
            licences,
            collections: typeof p(link, 'collection_count') === 'number' ? p(link, 'collection_count') : null,
            updated: str(p(link, 'updated')) ?? null,
        }];
    });
}
