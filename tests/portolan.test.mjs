import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionKind, layerFromCollection, listCollections, resolveHref } from '../lib/portolan.mjs';

/** A fetchJson answering from a map of URL → document, recording what was asked. */
function fakeFetch(docs) {
    const asked = [];
    const fetchJson = async (url) => {
        asked.push(url);
        if (!(url in docs)) throw new Error(`HTTP 404 fetching ${url}`);
        return structuredClone(docs[url]);
    };
    return { fetchJson, asked };
}

const BASE = 'https://lib.example.org';
const vectorCollection = (id, extra = {}) => ({
    type: 'Collection',
    id,
    title: `Title of ${id}`,
    description: `About ${id}.`,
    license: 'CC-BY-4.0',
    providers: [{ name: 'Kadaster', roles: ['producer', 'licensor'] }, { name: 'Host', roles: ['host'] }],
    extent: { spatial: { bbox: [[4, 52, 5, 53]] }, temporal: { interval: [[null, null]] } },
    'table:columns': [{ name: 'naam', type: 'string', description: 'Name' }, { name: 'geom', type: 'binary' }],
    assets: {
        data: { href: './data.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] },
        visual: { href: './tiles.pmtiles', type: 'application/vnd.pmtiles', roles: ['visual'] },
        'style-default': { href: './styles/default.json', type: 'application/vnd.mapbox.style+json', roles: ['style', 'default'], title: 'Default' },
        'style-labels': { href: './styles/labels.json', type: 'application/vnd.mapbox.style+json', roles: ['style'], title: 'With labels' },
        thumbnail: { href: './thumbnail.png', type: 'image/png', roles: ['thumbnail'] },
    },
    links: [],
    ...extra,
});

test('a PolderGIS flat index lists the whole library in two requests', async () => {
    const { fetchJson, asked } = fakeFetch({
        [`${BASE}/catalog.json`]: { type: 'Catalog', title: 'Library', links: [{ rel: 'pg:index', href: './index.json' }] },
        [`${BASE}/index.json`]: {
            type: 'pg:index', title: 'Library', layers: [
                { href: './a/collection.json', title: 'A', path: ['Group'], format: 'collection', kind: 'vector', bbox: [1, 2, 3, 4] },
                { href: './b/collection.json', title: 'B', path: [], format: 'collection', kind: 'raster' },
                { href: './c/items/c1/item.json', title: 'Sheet', format: 'item' },
            ],
        },
    });
    const { title, collections } = await listCollections(`${BASE}/catalog.json`, { fetchJson });

    assert.equal(title, 'Library');
    assert.deepEqual(asked, [`${BASE}/catalog.json`, `${BASE}/index.json`]);
    assert.deepEqual(collections, [
        { url: `${BASE}/a/collection.json`, title: 'A', group: ['Group'], kind: 'vector', bbox: [1, 2, 3, 4] },
        { url: `${BASE}/b/collection.json`, title: 'B', group: [], kind: 'raster', bbox: null },
    ]);
});

test('without an index the tree is walked, groups labelled by their catalog titles', async () => {
    const { fetchJson } = fakeFetch({
        [`${BASE}/catalog.json`]: {
            type: 'Catalog', title: 'Root', links: [
                { rel: 'child', href: './boundaries/catalog.json', title: 'Boundaries' },
                { rel: 'alternate', href: './ar/catalog.json' },
            ],
        },
        [`${BASE}/boundaries/catalog.json`]: {
            type: 'Catalog', title: 'Boundaries', links: [
                { rel: 'parent', href: '../catalog.json' },
                { rel: 'child', href: './provinces/collection.json', title: 'Provinces' },
            ],
        },
    });
    const { collections } = await listCollections(`${BASE}/catalog.json`, { fetchJson });

    assert.deepEqual(collections, [
        { url: `${BASE}/boundaries/provinces/collection.json`, title: 'Provinces', group: ['Boundaries'], kind: null, bbox: null },
    ]);
});

test('an unreadable index falls back to the walk; a cycle is read once', async () => {
    const { fetchJson, asked } = fakeFetch({
        [`${BASE}/catalog.json`]: {
            type: 'Catalog', title: 'Root', links: [
                { rel: 'pg:index', href: './missing.json' },
                { rel: 'child', href: './g/catalog.json' },
            ],
        },
        [`${BASE}/g/catalog.json`]: {
            type: 'Catalog', title: 'G', links: [
                { rel: 'child', href: '../catalog.json' },
                { rel: 'child', href: './x/collection.json', 'pg:kind': 'vector', 'pg:bbox': [0, 0, 1, 1] },
            ],
        },
    });
    const { collections } = await listCollections(`${BASE}/catalog.json`, { fetchJson });

    assert.equal(asked.filter((u) => u === `${BASE}/catalog.json`).length, 1);
    assert.deepEqual(collections.map((c) => [c.url, c.kind, c.bbox]), [[`${BASE}/g/x/collection.json`, 'vector', [0, 0, 1, 1]]]);
});

test('a URL pointing at one collection lists just that collection', async () => {
    const url = `${BASE}/a/collection.json`;
    const { fetchJson } = fakeFetch({ [url]: vectorCollection('a') });
    const { collections } = await listCollections(url, { fetchJson });
    assert.deepEqual(collections, [{ url, title: 'Title of a', group: [], kind: 'vector', bbox: [4, 52, 5, 53] }]);
});

test('kind: PMTiles or GeoParquet with geometry is vector, a COG raster, plain Parquet a table', () => {
    assert.equal(collectionKind(vectorCollection('a')), 'vector');
    const cog = { assets: { data: { href: './x.tif', type: 'image/tiff; application=geotiff; profile=cloud-optimized', roles: ['data'] } } };
    assert.equal(collectionKind(cog), 'raster');
    const table = { 'table:columns': [{ name: 'price', type: 'double' }], assets: { data: { href: './t.parquet', type: 'application/vnd.apache.parquet', roles: ['data'] } } };
    assert.equal(collectionKind(table), 'table');
    const fromSource = { ...table, 'table:primary_geometry': 'geom' };
    assert.equal(collectionKind(fromSource), 'vector');
    assert.equal(collectionKind({ assets: {} }), null);
});

test('a collection becomes a layer whose config references the collection, not its files', () => {
    const url = `${BASE}/provinces/collection.json`;
    const layer = layerFromCollection(vectorCollection('provinces-1a2b'), url, { idPrefix: 'my-lib', group: ['Boundaries'] });

    assert.equal(layer.id, 'my-lib-provinces-1a2b');
    assert.equal(layer.type, 'vector');
    assert.equal(layer.abstract, 'About provinces-1a2b. In Boundaries.');
    assert.deepEqual(layer.webmapxConfig.url, url);
    assert.equal(layer.webmapxConfig.type, 'style');
    assert.equal(layer.webmapxConfig.id, layer.id);
    assert.equal(layer.webmapxConfig.attribution, '© Kadaster, CC-BY-4.0');
    assert.deepEqual(layer.webmapxConfig.metadata.bounds, [4, 52, 5, 53]);
    assert.equal(JSON.stringify(layer).includes('.pmtiles'), false, 'no file of the collection is named');
    assert.deepEqual(layer.webmapxConfig.metadata.portolan.styles, [
        { key: 'style-default', title: 'Default', default: true },
        { key: 'style-labels', title: 'With labels', default: false },
    ]);
    assert.equal(layer.webmapxConfig.metadata.portolan.thumbnail, `${BASE}/provinces/thumbnail.png`);
    assert.deepEqual(layer.attributes, [
        { name: 'naam', type: 'string', title: 'Name' },
        { name: 'geom', type: 'binary', geometry: true },
    ]);
});

test('only http(s) hrefs are resolved', () => {
    assert.equal(resolveHref('./x.json', `${BASE}/a/catalog.json`), `${BASE}/a/x.json`);
    assert.equal(resolveHref('javascript:alert(1)', BASE), null);
    assert.equal(resolveHref('file:///etc/passwd', BASE), null);
});
