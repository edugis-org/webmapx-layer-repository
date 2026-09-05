/**
 * Reading a provider file, whichever shape it is in.
 *
 * Layers hang off services. Files written before that migration keep a
 * top-level layers[]; both are read here so callers never branch on it, and a
 * legacy file yields one synthetic service rather than a special case.
 *
 * Shared by the build, the validator, the prober and the UI — import it rather
 * than walking provider files by hand.
 */

/** Every service in a provider document, oldest shape included. */
export function services(doc) {
    if (Array.isArray(doc?.services)) return doc.services;
    if (Array.isArray(doc?.layers)) {
        return [{ id: 'legacy', type: 'xyz', legacy: true, layers: doc.layers }];
    }
    return [];
}

/** Every layer, paired with the service that serves it. */
export function layerEntries(doc) {
    return services(doc).flatMap(s => (s.layers ?? []).map(layer => ({ layer, service: s })));
}

/** Every layer, flat. */
export function allLayers(doc) {
    return layerEntries(doc).map(e => e.layer);
}

/** Count layers without materialising them. */
export function layerCount(doc) {
    return services(doc).reduce((n, s) => n + (s.layers?.length ?? 0), 0);
}
