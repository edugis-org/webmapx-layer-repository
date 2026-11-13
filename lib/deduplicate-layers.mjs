/** Remove exact duplicate layers within each service, retaining the first ID.
 * Only generated IDs are ignored. Titles, attribution, bounds, styles, time,
 * and all other metadata remain significant: equal URLs alone are not enough.
 */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

export function deduplicateLayers(services) {
    let removed = 0;
    for (const service of services) {
        const seen = new Set();
        service.layers = (service.layers ?? []).filter(layer => {
            const config = layer.webmapxConfig;
            if (!config?.source || !config?.layer) return true;
            const { id: _id, ...rest } = layer;
            const { id: _renderId, ...renderLayer } = config.layer;
            const key = JSON.stringify(canonical({
                ...rest, webmapxConfig: { ...config, layer: renderLayer },
            }));
            if (seen.has(key)) { removed++; return false; }
            seen.add(key);
            return true;
        });
    }
    return removed;
}
