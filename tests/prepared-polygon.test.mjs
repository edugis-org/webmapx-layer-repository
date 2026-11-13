import test from 'node:test';
import assert from 'node:assert/strict';
import { inPolygon, preparePolygon, inPreparedPolygon } from '../lib/geo.mjs';

test('indexed crossings equal original crossings, including holes and boundaries', () => {
    const rings = [ [[0,0],[10,0],[10,10],[0,10],[0,0]],
        [[3,3],[7,3],[7,7],[3,7],[3,3]], [[12,0],[17,2],[13,8],[12,0]] ];
    const prepared = preparePolygon(rings);
    for (let x = -1; x <= 18; x += 0.125) for (let y = -1; y <= 11; y += 0.125) {
        assert.equal(inPreparedPolygon([x,y], prepared), inPolygon([x,y], rings), `${x},${y}`);
    }
});

test('empty and horizontal-only polygons contain no points', () => {
    for (const rings of [[], [[]], [[[0,1],[3,1],[0,1]]]]) {
        assert.equal(inPreparedPolygon([1,1], preparePolygon(rings)), false);
    }
});
