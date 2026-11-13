import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateLayers } from '../lib/deduplicate-layers.mjs';

const layer = id => ({ id, title: 'Map', webmapxConfig: {
    source: { type: 'raster', tiles: ['https://example.org/{z}/{x}/{y}.png'] },
    layer: { id, type: 'raster', metadata: { title: 'Map' } },
} });

test('removes exact copies with generated IDs and keeps the first ID', () => {
    const services = [{ layers: [layer('original'), layer('copy')] }];
    assert.equal(deduplicateLayers(services), 1);
    assert.deepEqual(services[0].layers, [layer('original')]);
    assert.equal(deduplicateLayers(services), 0);
});

test('ignores object key order', () => {
    const copy = layer('copy');
    copy.webmapxConfig.source = { tiles: copy.webmapxConfig.source.tiles, type: 'raster' };
    assert.equal(deduplicateLayers([{ layers: [layer('original'), copy] }]), 1);
});

test('preserves differences in titles, metadata, attribution, bounds, styles and time', () => {
    const changes = [
        l => { l.title = 'Other municipality'; },
        l => { l.webmapxConfig.layer.metadata.title = 'Other description'; },
        l => { l.webmapxConfig.source.attribution = 'Other credit'; },
        l => { l.webmapxConfig.source.bounds = [1, 2, 3, 4]; },
        l => { l.webmapxConfig.layer.paint = { 'raster-opacity': 0.5 }; },
        l => { l.time = { default: '2026-01-01' }; },
    ];
    for (const change of changes) {
        const copy = layer('copy'); change(copy);
        assert.equal(deduplicateLayers([{ layers: [layer('original'), copy] }]), 0);
    }
});

test('keeps separate services and incomplete definitions', () => {
    const services = [{ layers: [layer('one')] }, { layers: [layer('two')] },
        { layers: [{ id: 'missing' }, { id: 'missing-too' }] }];
    assert.equal(deduplicateLayers(services), 0);
});
