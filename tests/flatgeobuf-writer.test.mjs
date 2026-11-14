import test from 'node:test';
import assert from 'node:assert/strict';
import { deserialize } from 'flatgeobuf/geojson';
import { writeFlatGeobuf } from '../lib/flatgeobuf-writer.mjs';

/** A small square footprint per grid cell, spread over the world. */
function grid(n) {
    const features = [];
    for (let i = 0; i < n; i++) {
        const x = -170 + (i * 37.3) % 340, y = -80 + (i * 13.7) % 160;
        features.push({ type: 'Feature', properties: { layerId: `l${i}`, title: `Map ${i}` },
            geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.5, y], [x + 0.5, y + 0.5], [x, y + 0.5], [x, y]]] } });
    }
    return features;
}

async function all(iter) {
    const out = [];
    for await (const f of iter) out.push(f);
    return out;
}

test('a bbox query through the written index finds exactly the overlapping features', async () => {
    // 1000 features: three tree levels, so parent pointers are exercised.
    const features = grid(1000);
    const bytes = writeFlatGeobuf({ type: 'FeatureCollection', features });
    let header;
    const everything = await all(deserialize(bytes, { headerMetaFn: h => { header = h; } }));
    assert.equal(everything.length, 1000);
    assert.equal(header.indexNodeSize, 16);

    for (const rect of [
        { minX: 0, minY: 0, maxX: 30, maxY: 30 },
        { minX: -180, minY: -90, maxX: 180, maxY: 90 },
        { minX: 179, minY: 89, maxX: 180, maxY: 90 },
    ]) {
        const expected = features.filter(f => {
            const [[[x0, y0], , [x1, y1]]] = f.geometry.coordinates;
            return x0 <= rect.maxX && x1 >= rect.minX && y0 <= rect.maxY && y1 >= rect.minY;
        }).map(f => f.properties.layerId).sort();
        const found = (await all(deserialize(bytes, { rect }))).map(f => f.properties.layerId).sort();
        assert.deepEqual(found, expected);
    }
});

test('one feature, found again by its own bounds, keeps its geometry and properties', async () => {
    const [feature] = grid(1);
    const bytes = writeFlatGeobuf({ type: 'FeatureCollection', features: [feature] });
    const [x0, y0] = feature.geometry.coordinates[0][0];
    const [hit] = await all(deserialize(bytes, { rect: { minX: x0, minY: y0, maxX: x0 + 0.5, maxY: y0 + 0.5 } }));
    assert.deepEqual(hit.properties, feature.properties);
    assert.deepEqual(hit.geometry.coordinates, feature.geometry.coordinates);
});
