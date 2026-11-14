import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPages } from '../lib/allmaps-snapshot.mjs';
import { manifestTitle, layerFor } from '../lib/allmaps.mjs';

const feature = id => ({ type: 'Feature', properties: { id, modified: '2026-01-01' },
    geometry: { type: 'Point', coordinates: [6.57, 53.22] } });
async function collect(generator) {
    const result = [];
    for await (const page of generator) result.push(...page);
    return result;
}

test('reads all records across batches and identical timestamps, deduplicating IDs', async t => {
    const records = Array.from({ length: 503 }, (_, i) => feature(String(i)));
    t.mock.method(globalThis, 'fetch', async () => new Response(
        [...records, records[0]].map(x => JSON.stringify(x)).join('\r\n')));
    assert.deepEqual(await collect(snapshotPages('https://example.org/maps.geojsonl')), records);
});

test('rejects failed, empty and truncated snapshots', async t => {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', {status: 503}));
    await assert.rejects(collect(snapshotPages('https://example.org/maps.geojsonl')), /503/);
    mock.mock.mockImplementation(async () => new Response(''));
    await assert.rejects(collect(snapshotPages('https://example.org/maps.geojsonl')), /Empty/);
    mock.mock.mockImplementation(async () => new Response(JSON.stringify(feature('1')) + '\n{"type":'));
    await assert.rejects(collect(snapshotPages('https://example.org/maps.geojsonl')), SyntaxError);
});

test('uses embedded manifest titles before requesting cached API titles', () => {
    const f = feature('https://annotations.allmaps.org/maps/test');
    f.properties.resource = {partOf: [{type: 'Canvas', partOf: [
        {type: 'Manifest', label: {en: ['Groningen &amp; omgeving, 1900']}},
    ]}]};
    assert.equal(manifestTitle(f.properties), 'Groningen & omgeving, 1900');
    assert.equal(layerFor(f).title, 'Groningen & omgeving, 1900');
    assert.equal(manifestTitle({}), null);
});

test('carries the footprint polygon and the institution manifest URL', () => {
    const f = feature('https://annotations.allmaps.org/maps/test');
    f.geometry = {type: 'Polygon', coordinates: [[[6.123456789, 53.1], [6.2, 53.1], [6.2, 53.2], [6.123456789, 53.1]]]};
    f.properties.resource = {id: 'https://iiif.example.org/image/1', partOf: [{type: 'Canvas', partOf: [
        {type: 'Manifest', id: 'https://library.example.org/manifest.json', label: {en: ['Groningen, 1900']}},
    ]}]};
    const layer = layerFor(f);
    const metadata = layer.webmapxConfig.layer.metadata;
    assert.equal(metadata.iiifManifest, 'https://library.example.org/manifest.json');
    assert.equal(metadata.footprint, undefined);
    assert.deepEqual(layer.footprint, {type: 'Polygon',
        coordinates: [[[6.12346, 53.1], [6.2, 53.1], [6.2, 53.2], [6.12346, 53.1]]]});
    assert.equal(metadata.year, 1900);
});
