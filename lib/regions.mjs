/**
 * Fallback extents per region path.
 *
 * A layer that declares no bounds still lives somewhere in the tree, and that
 * says roughly where its data is. Used to frame a preview, and to probe a WMS
 * inside its own extent — asking a municipal service to render a quarter of the
 * planet is slow enough to time out and says nothing about whether it works.
 *
 * Shared by the UI and the prober; import it rather than copying the table.
 */
export const REGION_BOUNDS = {
    'world':                                             [-170, -60, 190, 78],
    'world/europe':                                      [-11, 35, 32, 60],
    'world/europe/netherlands':                          [3.2, 50.75, 7.22, 53.7],
    'world/europe/netherlands/flevoland':                [5.0, 52.2, 6.1, 52.8],
    'world/europe/netherlands/noord-holland':            [4.4, 52.1, 5.4, 53.2],
    'world/europe/netherlands/noord-holland/amsterdam':  [4.72, 52.28, 5.07, 52.44],
    'world/europe/belgium':                              [2.5, 49.4, 6.5, 51.55],
    'world/north-america/united-states':                 [-125.0, 24.4, -66.9, 49.4],
    'world/south-america/caribbean-netherlands':         [-68.5, 12.0, -62.9, 17.7],
};

/** Longest matching region path wins; null when nothing matches. */
export function regionBounds(region) {
    let best = null;
    for (const key of Object.keys(REGION_BOUNDS)) {
        if (region === key || region?.startsWith(key + '/')) {
            if (!best || key.length > best.length) best = key;
        }
    }
    return best ? REGION_BOUNDS[best] : null;
}
