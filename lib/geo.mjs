/**
 * Point-in-polygon and extent helpers, shared by the region build and harvest.
 *
 * Deliberately small and dependency-free: this runs in Node during a build and
 * is plain ESM, like every other module here, so nothing needs compiling.
 */

/** [minx, miny, maxx, maxy] of a GeoJSON geometry, or null when it has none. */
export function bboxOf(geometry) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const walk = coords => {
        if (typeof coords[0] === 'number') {
            const [x, y] = coords;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            minx = Math.min(minx, x); maxx = Math.max(maxx, x);
            miny = Math.min(miny, y); maxy = Math.max(maxy, y);
            return;
        }
        for (const c of coords) walk(c);
    };
    if (!geometry?.coordinates) return null;
    walk(geometry.coordinates);
    return Number.isFinite(minx) && Number.isFinite(miny) ? [minx, miny, maxx, maxy] : null;
}

/** Grow an extent by `fraction` of its own size on every side. */
export function padBox([minx, miny, maxx, maxy], fraction) {
    const dx = (maxx - minx) * fraction;
    const dy = (maxy - miny) * fraction;
    return [minx - dx, miny - dy, maxx + dx, maxy + dy];
}

/** True when the point lies in the extent. */
export function inBox([x, y], [minx, miny, maxx, maxy]) {
    return x >= minx && x <= maxx && y >= miny && y <= maxy;
}

/** True when the extents share any area. */
export function boxesOverlap(a, b) {
    return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Ray casting against one ring. Holes are handled by the caller: a point in an
 * odd number of a polygon's rings is inside it, which is the even-odd rule
 * GeoJSON's winding-agnostic polygons want.
 */
export function inRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/** True when the point is inside a polygon given as an array of rings. */
export function inPolygon(point, rings) {
    let inside = false;
    for (const ring of rings) if (inRing(point, ring)) inside = !inside;
    return inside;
}

/**
 * A grid of sample points across an extent.
 *
 * A map's footprint is a rectangle and the thing it depicts is not, so asking
 * "is the rectangle inside this region" answers almost always no. Asking "what
 * share of the rectangle falls in this region" answers the question actually
 * being asked, and a grid is the cheapest honest way to measure that share.
 */
export function samplePoints([minx, miny, maxx, maxy], n) {
    const points = [];
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            points.push([
                minx + ((i + 0.5) / n) * (maxx - minx),
                miny + ((j + 0.5) / n) * (maxy - miny),
            ]);
        }
    }
    return points;
}
