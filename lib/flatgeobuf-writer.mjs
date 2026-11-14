/**
 * FlatGeobuf with a spatial index, written without GDAL.
 *
 * A footprint file is only worth having if a browser can read one polygon out
 * of it without downloading the rest, and that is what FlatGeobuf's packed
 * Hilbert R-tree is for: a bbox query reads the tree's top nodes, then the few
 * features under them, with HTTP range requests. The `flatgeobuf` package can
 * read such a tree but its writer never builds one (`indexNodeSize: 0`), and
 * requiring GDAL just to run a harvest would be a native dependency in CI and
 * on every machine that harvests.
 *
 * So the package serialises the header and the features — already sorted into
 * Hilbert order — and this file inserts the tree between them and flips the
 * header's `index_node_size` from 0 to the node size. The layout is the one in
 * the FlatGeobuf spec, and the package's own bbox reader is what the tests
 * check it against.
 */
import { serialize } from 'flatgeobuf/geojson';

/** One tree node: four float64 bounds and a uint64 pointer. */
const NODE_ITEM_BYTE_LEN = 40;

/**
 * [start, end) node indices per level, leaves first — the root sits at index
 * 0, so the leaf level is last in the file. Same arithmetic as the package's
 * own (unexported) `generateLevelBounds`, which its reader walks by.
 */
function generateLevelBounds(numItems, nodeSize) {
    let n = numItems;
    let numNodes = n;
    const levelNumNodes = [n];
    do {
        n = Math.ceil(n / nodeSize);
        numNodes += n;
        levelNumNodes.push(n);
    } while (n !== 1);
    const bounds = [];
    let end = numNodes;
    for (const size of levelNumNodes) {
        bounds.push([end - size, end]);
        end -= size;
    }
    return bounds;
}

const MAGIC_LEN = 8;
const NODE_SIZE = 16;
/** Slot of `index_node_size` in the FlatGeobuf header table (header.fbs). */
const HEADER_INDEX_NODE_SIZE_FIELD = 9;

/** [minX, minY, maxX, maxY] of any GeoJSON geometry. */
function boundsOf(geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = c => {
        if (typeof c[0] === 'number') {
            if (c[0] < minX) minX = c[0];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[1] > maxY) maxY = c[1];
            return;
        }
        for (const x of c) walk(x);
    };
    walk(geometry.coordinates);
    return [minX, minY, maxX, maxY];
}

/** Position of (x, y) on a 16-bit Hilbert curve — the same curve FlatGeobuf's reference writers sort by. */
export function hilbert(x, y) {
    let a = x ^ y;
    let b = 0xFFFF ^ a;
    let c = 0xFFFF ^ (x | y);
    let d = x & (y ^ 0xFFFF);
    let A = a | (b >>> 1);
    let B = (a >>> 1) ^ a;
    let C = ((c >>> 1) ^ (b & (d >>> 1))) ^ c;
    let D = ((a & (c >>> 1)) ^ (d >>> 1)) ^ d;
    a = A; b = B; c = C; d = D;
    A = (a & (a >>> 2)) ^ (b & (b >>> 2));
    B = (a & (b >>> 2)) ^ (b & ((a ^ b) >>> 2));
    C ^= (a & (c >>> 2)) ^ (b & (d >>> 2));
    D ^= (b & (c >>> 2)) ^ ((a ^ b) & (d >>> 2));
    a = A; b = B; c = C; d = D;
    A = (a & (a >>> 4)) ^ (b & (b >>> 4));
    B = (a & (b >>> 4)) ^ (b & ((a ^ b) >>> 4));
    C ^= (a & (c >>> 4)) ^ (b & (d >>> 4));
    D ^= (b & (c >>> 4)) ^ ((a ^ b) & (d >>> 4));
    a = A; b = B; c = C; d = D;
    C ^= (a & (c >>> 8)) ^ (b & (d >>> 8));
    D ^= (b & (c >>> 8)) ^ ((a ^ b) & (d >>> 8));
    a = C ^ (C >>> 1);
    b = D ^ (D >>> 1);
    let i0 = x ^ y;
    let i1 = b | (0xFFFF ^ (i0 | a));
    i0 = (i0 | (i0 << 8)) & 0x00FF00FF;
    i0 = (i0 | (i0 << 4)) & 0x0F0F0F0F;
    i0 = (i0 | (i0 << 2)) & 0x33333333;
    i0 = (i0 | (i0 << 1)) & 0x55555555;
    i1 = (i1 | (i1 << 8)) & 0x00FF00FF;
    i1 = (i1 | (i1 << 4)) & 0x0F0F0F0F;
    i1 = (i1 | (i1 << 2)) & 0x33333333;
    i1 = (i1 | (i1 << 1)) & 0x55555555;
    return ((i1 << 1) | i0) >>> 0;
}

/** Overwrite `index_node_size` in a size-prefixed FlatGeobuf header, in place. */
function setIndexNodeSize(bytes, headerStart, nodeSize) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buf = headerStart + 4; // past the size prefix
    const table = buf + view.getUint32(buf, true);
    const vtable = table - view.getInt32(table, true);
    const vtableSize = view.getUint16(vtable, true);
    const slot = 4 + HEADER_INDEX_NODE_SIZE_FIELD * 2;
    const fieldOffset = slot < vtableSize ? view.getUint16(vtable + slot, true) : 0;
    // The package always writes the field (as 0); if a future version leaves
    // it out, the schema default is already 16 and there is nothing to patch.
    if (fieldOffset) view.setUint16(table + fieldOffset, nodeSize, true);
    else if (nodeSize !== 16) throw new Error('FlatGeobuf header has no index_node_size field to set');
}

/**
 * A GeoJSON FeatureCollection as FlatGeobuf bytes with a packed Hilbert R-tree.
 * Every feature must carry the same property keys (the header's column list
 * is taken from the first).
 */
export function writeFlatGeobuf(collection) {
    const input = collection.features.filter(f => f?.geometry?.coordinates);
    if (!input.length) throw new Error('FlatGeobuf needs at least one feature');

    const boxes = input.map(f => boundsOf(f.geometry));
    const extent = boxes.reduce((e, b) => [Math.min(e[0], b[0]), Math.min(e[1], b[1]),
        Math.max(e[2], b[2]), Math.max(e[3], b[3])], [Infinity, Infinity, -Infinity, -Infinity]);
    const width = extent[2] - extent[0] || 1;
    const height = extent[3] - extent[1] || 1;
    const order = input.map((_, i) => {
        const b = boxes[i];
        const x = Math.floor(0xFFFF * (((b[0] + b[2]) / 2 - extent[0]) / width));
        const y = Math.floor(0xFFFF * (((b[1] + b[3]) / 2 - extent[1]) / height));
        return { i, h: hilbert(x, y) };
    }).sort((p, q) => p.h - q.h).map(p => p.i);

    const sorted = order.map(i => input[i]);
    const plain = serialize({ type: 'FeatureCollection', features: sorted });

    // Features follow the size-prefixed header; each is itself size-prefixed,
    // and a leaf node points at its feature's offset within that section.
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const headerLen = 4 + view.getUint32(MAGIC_LEN, true);
    const featuresStart = MAGIC_LEN + headerLen;
    const offsets = [];
    for (let at = featuresStart; at < plain.length; at += 4 + view.getUint32(at, true)) {
        offsets.push(at - featuresStart);
    }
    if (offsets.length !== sorted.length) throw new Error('FlatGeobuf feature count mismatch');

    const levels = generateLevelBounds(sorted.length, NODE_SIZE);
    const numNodes = levels[0][1]; // the leaf level ends the node array
    const nodes = new Float64Array(numNodes * 4);
    const pointers = new BigUint64Array(numNodes);
    const leafStart = levels[0][0];
    for (let k = 0; k < sorted.length; k++) {
        const b = boxes[order[k]];
        nodes.set(b, (leafStart + k) * 4);
        pointers[leafStart + k] = BigInt(offsets[k]);
    }
    // Each parent covers NODE_SIZE consecutive children and points at the first.
    for (let level = 1; level < levels.length; level++) {
        const [childStart, childEnd] = levels[level - 1];
        const [start] = levels[level];
        for (let p = 0, c = childStart; c < childEnd; p++, c += NODE_SIZE) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let j = c; j < Math.min(c + NODE_SIZE, childEnd); j++) {
                minX = Math.min(minX, nodes[j * 4]); minY = Math.min(minY, nodes[j * 4 + 1]);
                maxX = Math.max(maxX, nodes[j * 4 + 2]); maxY = Math.max(maxY, nodes[j * 4 + 3]);
            }
            nodes.set([minX, minY, maxX, maxY], (start + p) * 4);
            pointers[start + p] = BigInt(c);
        }
    }

    const tree = new Uint8Array(numNodes * NODE_ITEM_BYTE_LEN);
    const treeView = new DataView(tree.buffer);
    for (let n = 0; n < numNodes; n++) {
        for (let k = 0; k < 4; k++) treeView.setFloat64(n * NODE_ITEM_BYTE_LEN + k * 8, nodes[n * 4 + k], true);
        treeView.setBigUint64(n * NODE_ITEM_BYTE_LEN + 32, pointers[n], true);
    }

    const out = new Uint8Array(plain.length + tree.length);
    out.set(plain.subarray(0, featuresStart), 0);
    out.set(tree, featuresStart);
    out.set(plain.subarray(featuresStart), featuresStart + tree.length);
    setIndexNodeSize(out, MAGIC_LEN, NODE_SIZE);
    return out;
}
