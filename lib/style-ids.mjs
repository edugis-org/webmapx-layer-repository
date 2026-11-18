/**
 * Id suffixes for the style variants of one layer.
 *
 * A variant is named `${layer.id}-${slug(styleName)}`, and slug() cuts at 60
 * characters. Style names often repeat the layer's name before the part that
 * tells them apart (RCE: `…_haltes_metro_en_sneltram_style`, `…_2000_style`,
 * `…_2025_style`), so the cut can drop exactly that part and give every variant
 * the same id. Only colliding names change: a layer id is what a saved config
 * refers to, so a suffix that is unique today stays as it is. Colliding names
 * are named by what follows their common prefix, and a `-2`, `-3` covers what
 * is still left over, matching how harvest.mjs disambiguates layer names.
 */
export function styleIdSuffixes(names, slug) {
    const suffixes = names.map(slug);
    const groups = new Map();
    suffixes.forEach((s, i) => groups.set(s, [...(groups.get(s) ?? []), i]));
    for (const members of groups.values()) {
        if (members.length < 2) continue;
        const prefix = commonPrefix(members.map(i => names[i]));
        for (const i of members) suffixes[i] = slug(names[i].slice(prefix.length)) || suffixes[i];
    }
    const seen = new Set();
    return suffixes.map(s => {
        let id = s;
        while (seen.has(id)) id += '-2';
        seen.add(id);
        return id;
    });
}

function commonPrefix(strings) {
    let prefix = strings[0];
    for (const s of strings) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    return prefix;
}
