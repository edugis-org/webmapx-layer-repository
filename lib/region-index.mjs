/**
 * Which region a map's footprint belongs to, measured rather than assumed.
 *
 * A footprint is a rectangle; the place it depicts is not. Asking whether the
 * rectangle sits inside a region answers "no" for almost every city map, and
 * asking which region's extent encloses it answers by an accident of rectangle
 * size — the Dutch extent holds half of Flanders, and the Belgian one holds
 * part of Zeeland. So neither test decides here. The footprint is sampled on a
 * grid, each sample is placed in the sub-country polygon that contains it, and
 * the map is filed in the deepest region holding a clear majority of the
 * samples that landed on any region at all.
 *
 * Samples landing on no region are ignored rather than counted against a
 * candidate, which is what keeps a harbour or coastal map in its province
 * instead of pushing it up to the continent because half its rectangle is sea.
 *
 * Extents survive only as a prefilter: they turn 4,500 polygons into the two or
 * three worth testing a point against. That is why they are padded — widening
 * the candidate set costs nothing once coverage does the deciding.
 */
import { inBox, inPolygon, samplePoints, boxesOverlap } from './geo.mjs';

/** Degrees per cell of the lookup grid laid over the leaf extents. */
const CELL = 2;

const cellsFor = ([minx, miny, maxx, maxy]) => {
    const keys = [];
    for (let x = Math.floor(minx / CELL); x <= Math.floor(maxx / CELL); x++) {
        for (let y = Math.floor(miny / CELL); y <= Math.floor(maxy / CELL); y++) {
            keys.push(`${x},${y}`);
        }
    }
    return keys;
};

/**
 * Index `regions` (data/regions.json) and `shapes` (.cache/region-shapes.json)
 * for repeated lookups. Shapes are the sub-country polygons only: a point
 * inside a province is inside its country and its continent, so the ancestors
 * are reached by walking the path rather than by testing more geometry.
 */
export function buildRegionIndex(regions, shapes) {
    const known = new Set(regions.map(r => r.path));
    const grid = new Map();
    shapes.forEach((shape, i) => {
        for (const box of shape.boxes) {
            for (const key of cellsFor(box)) {
                if (!grid.has(key)) grid.set(key, []);
                grid.get(key).push(i);
            }
        }
    });
    return { known, grid, shapes };
}

/** The leaf polygon containing `point`, or null. */
function leafAt(point, { grid, shapes }) {
    const key = `${Math.floor(point[0] / CELL)},${Math.floor(point[1] / CELL)}`;
    for (const i of grid.get(key) ?? []) {
        const shape = shapes[i];
        if (!shape.boxes.some(b => inBox(point, b))) continue;
        if (inPolygon(point, shape.rings)) return shape;
    }
    return null;
}

/**
 * Where a footprint belongs.
 *
 * The default threshold is 0.6 because a country's own map is not 90% that
 * country: the rectangle around the Netherlands is 73% Dutch land, around
 * France 76% French. Asking for more files those maps under Europe, which is
 * true but useless. Below 0.6 lies genuine ambiguity — a rectangle around
 * Belgium is only 52% Belgian — and the rung above is the honest answer.
 *
 * Returns `{ region, share, samples }`, or null when the footprint touches no
 * land in the tree at all — an ocean chart, or a warp gone wrong.
 */
export function assignRegion(bounds, index,
                             { grid = 16, threshold = 0.6, landPreference = 0.25 } = {}) {
    const points = samplePoints(bounds, grid);
    const tally = { land: { counts: new Map(), placed: 0 }, marine: { counts: new Map(), placed: 0 } };
    for (const point of points) {
        const leaf = leafAt(point, index);
        if (!leaf) continue;
        const side = tally[leaf.kind === 'marine' ? 'marine' : 'land'];
        side.placed++;
        // One sample counts for its province, its country and its continent:
        // the tree is nested, so a hit on a leaf is a hit on every ancestor.
        const parts = leaf.path.split('/');
        for (let n = parts.length; n >= 1; n--) {
            const path = parts.slice(0, n).join('/');
            side.counts.set(path, (side.counts.get(path) ?? 0) + 1);
        }
    }
    const total = tally.land.placed + tally.marine.placed;
    if (!total) return null;

    // Land wins unless there is hardly any: a coastal town's rectangle is half
    // water and still a map of the town, while a chart of the North Sea with a
    // sliver of Holland along one edge is a map of the sea. A quarter of the
    // samples is where one stops being the other.
    const side = tally.land.placed / total >= landPreference ? tally.land : tally.marine;
    const { counts, placed } = side;

    let best = null;
    for (const [path, count] of counts) {
        if (!index.known.has(path)) continue;   // a rung dropped as redundant
        const share = count / placed;
        if (share < threshold) continue;
        const depth = path.split('/').length;
        if (!best || depth > best.depth) best = { region: path, share, depth };
    }
    // Every sample landed somewhere, but no single region holds enough of them:
    // a map straddling a border belongs to the rung above, not to either side.
    return best
        ? { region: best.region, share: best.share, samples: placed, kind: side === tally.land ? 'land' : 'marine' }
        : { region: 'world', share: 1, samples: placed, kind: side === tally.land ? 'land' : 'marine' };
}

/** Extents of every region, for callers that still want a box (preview framing). */
export function boundsByPath(regions) {
    const out = {};
    for (const r of regions) {
        const boxes = r.boxes;
        out[r.path] = boxes.reduce(
            (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
                       Math.max(a[2], b[2]), Math.max(a[3], b[3])],
            [Infinity, Infinity, -Infinity, -Infinity]);
    }
    return out;
}
