#!/usr/bin/env node
/**
 * Build the region tree from Natural Earth, once, into two artifacts.
 *
 * The tree a harvest files layers into used to be nine hand-written extents in
 * lib/regions.mjs, which is why a 350-metre plan of the Zócalo landed under
 * "world": no rung between the two existed. This derives the whole ladder —
 * world → continent → country → sub-country region — from the same dataset, so
 * the names are spelled one way and every place on earth has a rung.
 *
 * Sub-country regions come from ne_10m_admin_1, and everything above them is
 * aggregated from those: a country's extents are its provinces' extents, a
 * continent's are its countries'. No geometric dissolve is needed for that, and
 * using one source for the whole tree keeps the names consistent — the reason
 * not to mix in the coarser admin-1 file, which covers nine countries.
 *
 * Two outputs, because they are used at different times:
 *
 *   data/regions.json         committed. Path, name, level and extents per
 *                             region. Extents are per polygon part, not one box
 *                             per country: France's single box spans the
 *                             Atlantic because French Guiana is in it.
 *   .cache/region-shapes.json gitignored, regenerated. The sub-country polygons
 *                             themselves, for the coverage test at harvest
 *                             time. Only the leaves are stored: a point inside
 *                             a province is inside its country and continent,
 *                             so the ancestors need no geometry of their own.
 *
 * Usage:  node scripts/build-regions.mjs [--refresh]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { bboxOf, padBox } from '../lib/geo.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const CACHE = join(ROOT, '.cache');
const DATA = join(ROOT, 'data');

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const SOURCES = {
    admin1: `${NE}/ne_10m_admin_1_states_provinces.geojson`,
    admin0: `${NE}/ne_50m_admin_0_countries.geojson`,
    marine: `${NE}/ne_10m_geography_marine_polys.geojson`,
};

/** How far an extent is grown. It only widens the candidate set — the coverage
 *  test decides — so this buys tolerance for coastlines at no cost in accuracy. */
const PAD = 0.1;
/** Coordinates kept to ~10 m. Full 10m precision triples the shapes file for
 *  detail no point-in-polygon test at this scale can use. */
const PRECISION = 4;

const refresh = process.argv.includes('--refresh');

async function neFile(name) {
    mkdirSync(CACHE, { recursive: true });
    const file = join(CACHE, `${name}.geojson`);
    if (existsSync(file) && !refresh) return JSON.parse(readFileSync(file, 'utf8'));
    process.stdout.write(`↓ ${SOURCES[name]} … `);
    const res = await fetch(SOURCES[name], { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    writeFileSync(file, text);
    console.log(`${(text.length / 1048576).toFixed(1)} MB`);
    return JSON.parse(text);
}

/**
 * Where Natural Earth's name and the tree's existing path disagree, the tree
 * wins: layers/ already files the US Census under world/north-america/
 * united-states, and a second spelling would split one country in two.
 */
const PATH_ALIASES = {
    'united-states-of-america': 'united-states',
    'united-kingdom-of-great-britain-and-northern-ireland': 'united-kingdom',
    'russian-federation': 'russia',
    'republic-of-korea': 'south-korea',
    'czech-republic': 'czechia',
    'macedonia': 'north-macedonia',
    'swaziland': 'eswatini',
};

/** "Ciudad de México" -> "ciudad-de-mexico". Paths are ASCII and lowercase. */
function slug(name) {
    return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** A slug with the tree's own spelling applied. */
function pathSlug(name) {
    const s = slug(name);
    return PATH_ALIASES[s] ?? s;
}

/**
 * Natural Earth spells a handful of countries differently in its two files —
 * admin-0 says Czechia where admin-1 says Czech Republic — and leaves ISO_A2 as
 * "-99" for others, France and Norway among them, so neither join alone
 * suffices. This is the whole of the hand-maintained part of the pipeline.
 */
const ALIASES = {
    'Czechia': 'Czech Republic',
    'eSwatini': 'Swaziland',
    'North Macedonia': 'Macedonia',
    'Cabo Verde': 'Cape Verde',
    'Guinea-Bissau': 'Guinea Bissau',
    'São Tomé and Principe': 'Sao Tome and Principe',
    'Macao S.A.R': 'Macao S.A.R',
    'Palestine': 'Palestine',
    'South Sudan': 'South Sudan',
};

/** Split an extent that wraps the antimeridian into the two it really covers.
 *
 *  Russia's naive extent is the entire planet, -180 to 180, because it has
 *  land on both sides of the line. Left whole it would enclose — and so claim —
 *  every map on earth. A part wider than half the world is treated as wrapped.
 */
function unwrap(box) {
    const [minx, miny, maxx, maxy] = box;
    if (maxx - minx <= 180) return [box];
    return [[minx, miny, -180 + 1e-9, maxy], [180 - 1e-9, miny, maxx, maxy]]
        .map(([a, b, c, d]) => [Math.min(a, c), b, Math.max(a, c), d]);
}

/** Every polygon part of a geometry, as its own padded extent. */
function partBoxes(geometry) {
    const parts = geometry.type === 'MultiPolygon'
        ? geometry.coordinates.map(c => ({ type: 'Polygon', coordinates: c }))
        : [geometry];
    return parts.flatMap(p => {
        const box = bboxOf(p);
        return box ? unwrap(padBox(box, PAD)) : [];
    });
}

const round = n => Number(n.toFixed(PRECISION));
/** Every ring of a polygon or multipolygon, flattened. Holes included: the
 *  even-odd test in lib/geo.mjs wants them in the same list. */
const ringsOf = geometry =>
    (geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]).flat();
const quantise = rings => rings.map(ring => ring.map(([x, y]) => [round(x), round(y)]));

/** Natural Earth shouts some names — "INDIAN OCEAN" — and title-cases others. */
function titleCase(name) {
    if (!name || name !== name.toUpperCase()) return name;
    return name.toLowerCase().replace(/(^|[\s-])(\w)/g, (_, sep, c) => sep + c.toUpperCase());
}

const admin1 = await neFile('admin1');
const admin0 = await neFile('admin0');
const marine = await neFile('marine');

/**
 * Natural Earth files island states under the open ocean rather than a
 * continent — Maldives, Seychelles and Mauritius all have CONTINENT "Seven
 * seas (open ocean)" — so their UN subregion is read instead, which every
 * feature carries and which maps onto continents unambiguously.
 */
const SUBREGION_CONTINENT = {
    'Eastern Africa': 'Africa', 'Western Africa': 'Africa', 'Northern Africa': 'Africa',
    'Southern Africa': 'Africa', 'Middle Africa': 'Africa',
    'Western Asia': 'Asia', 'Southern Asia': 'Asia', 'Eastern Asia': 'Asia',
    'South-Eastern Asia': 'Asia', 'Central Asia': 'Asia',
    'Northern Europe': 'Europe', 'Western Europe': 'Europe',
    'Eastern Europe': 'Europe', 'Southern Europe': 'Europe',
    'Northern America': 'North America', 'Central America': 'North America',
    'Caribbean': 'North America', 'South America': 'South America',
    'Melanesia': 'Oceania', 'Micronesia': 'Oceania', 'Polynesia': 'Oceania',
    'Australia and New Zealand': 'Oceania', 'Antarctica': 'Antarctica',
};

/**
 * Territories that admin-1 knows and the 50m admin-0 file does not, so no join
 * can reach them. Small, explicit, and the second half of what this pipeline
 * maintains by hand.
 */
const TERRITORY_CONTINENT = {
    'Gibraltar': 'Europe',
    'Caribbean Netherlands': 'North America',
    'Macau S.A.R': 'Asia',
    'British Indian Ocean Territory': 'Africa',
    'French Southern and Antarctic Lands': 'Antarctica',
    'Heard Island and McDonald Islands': 'Antarctica',
    'South Georgia and the Islands': 'Antarctica',
    'United States Minor Outlying Islands': 'Oceania',
    'Coral Sea Islands': 'Oceania',
    'Clipperton Island': 'North America',
    'Spratly Is.': 'Asia',
    'Saint Helena': 'Africa',
    'Maldives': 'Asia',
    'Mauritius': 'Africa',
    'Seychelles': 'Africa',
    'Akrotiri Sovereign Base Area': 'Europe',
    'Dhekelia Sovereign Base Area': 'Europe',
    'Baykonur Cosmodrome': 'Asia',
    'US Naval Base Guantanamo Bay': 'North America',
    'Gaza Strip': 'Asia',
    'West Bank': 'Asia',
};

// Continent comes from admin-0, the only file carrying it. Geometry does not:
// names and boxes both come from admin-1, so the tree stays in one vocabulary.
const continentOf = new Map();
for (const f of admin0.features) {
    const p = f.properties;
    const continent = p.CONTINENT === 'Seven seas (open ocean)' || !p.CONTINENT
        ? SUBREGION_CONTINENT[p.SUBREGION]
        : p.CONTINENT;
    if (!continent) continue;
    for (const name of [p.ADMIN, p.NAME, p.NAME_LONG, ALIASES[p.ADMIN]]) {
        if (name) continentOf.set(name, continent);
    }
}
for (const [name, continent] of Object.entries(TERRITORY_CONTINENT)) {
    if (!continentOf.has(name)) continentOf.set(name, continent);
}

const regions = new Map();   // path -> { path, name, level, boxes }
const shapes = [];           // leaves only, for the coverage test
const orphans = new Set();

function record(path, name, level) {
    if (!regions.has(path)) regions.set(path, { path, name, level, boxes: [] });
    return regions.get(path);
}

for (const f of admin1.features) {
    const p = f.properties;
    const country = p.admin;
    const continent = continentOf.get(country) ?? continentOf.get(ALIASES[country]);
    if (!continent) { orphans.add(country); continue; }

    const name = p.name ?? p.name_alt ?? p.gn_name;
    if (!name) continue;

    const continentPath = `world/${pathSlug(continent)}`;
    const countryPath = `${continentPath}/${pathSlug(country)}`;
    const regionPath = `${countryPath}/${pathSlug(name)}`;

    const boxes = partBoxes(f.geometry);
    if (!boxes.length) continue;

    for (const [path, label, level] of [
        [continentPath, continent, 'continent'],
        [countryPath, country, 'country'],
        [regionPath, name, 'region'],
    ]) record(path, label, level).boxes.push(...boxes);

    shapes.push({ path: regionPath, kind: 'land', boxes, rings: quantise(ringsOf(f.geometry)) });
}

/**
 * The sea, which a great many historical maps are about.
 *
 * ne_10m_geography_marine_polys names 306 bodies of water — 7 oceans, 71 seas,
 * and bays, gulfs, straits and sounds besides. They do not nest: the North Sea
 * is not inside the North Atlantic polygon, the set is a partition rather than
 * a hierarchy, so the ocean a sea belongs to is derived here by proximity —
 * the ocean whose polygon comes nearest the sea's own vertices.
 *
 * The Caspian is in this file as a "sea" and belongs to no ocean at all; any
 * body further than FAR from every ocean is treated the same way and hangs
 * directly under world, rather than being filed in whichever ocean happens to
 * be least distant.
 */
const FAR = 12;   // degrees; roughly the Black Sea's distance to open ocean

/** Least distance between two extents, 0 when they overlap. */
function boxDistance(a, b) {
    const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
    const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
    return Math.hypot(dx, dy);
}

const boxArea = ([minx, miny, maxx, maxy]) => (maxx - minx) * (maxy - miny);
/** Share of `inner`'s extent that lies inside `outer`'s. */
function overlapShare(outer, inner) {
    const w = Math.max(0, Math.min(outer[2], inner[2]) - Math.max(outer[0], inner[0]));
    const h = Math.max(0, Math.min(outer[3], inner[3]) - Math.max(outer[1], inner[1]));
    const area = boxArea(inner);
    return area > 0 ? (w * h) / area : 0;
}

/** How much of a body must lie within another to be called part of it. The
 *  Adriatic reaches 2° north of the Mediterranean's extent and is still in it. */
const NESTED = 0.5;

/** Least distance between two rings' vertices, on sampled vertices: it ranks
 *  seven oceans against one sea, and that ranking is never close. */
function ringDistance(a, b) {
    let best = Infinity;
    const thin = (ring, n) => ring.filter((_, i) => i % n === 0);
    for (const p of thin(a, Math.max(1, Math.ceil(a.length / 150)))) {
        for (const q of thin(b, Math.max(1, Math.ceil(b.length / 150)))) {
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (d < best) best = d;
        }
    }
    return best;
}

/**
 * Nest the waters by containment, and fall back to the nearest ocean.
 *
 * The marine polygons are a partition, not a hierarchy: the North Sea is not
 * inside the North Atlantic polygon, and nothing in the file says which ocean
 * it belongs to. Containment of extents recovers most of the tree by itself —
 * the Mediterranean's extent holds the Adriatic, the Aegean and the Ionian,
 * the Aegean's holds the Sea of Marmara — and what it cannot place is hung
 * under the ocean whose coastline comes nearest.
 *
 * Nearness is measured between polygons, not extents: every ocean's extent is
 * so large that extent distance would make each of them equally near to
 * everything, which is how the Caspian ends up in the Pacific. Beyond FAR
 * nothing is near enough, and the body hangs under world — the Caspian reaches
 * no ocean, and saying so is better than inventing one.
 */
const marineBodies = marine.features.map(f => ({
    name: titleCase(f.properties.name),
    isOcean: f.properties.featurecla === 'ocean',
    geometry: f.geometry,
    box: bboxOf(f.geometry),
})).filter(b => b.name && b.box);

const oceanBodies = marineBodies.filter(b => b.isOcean);
// Largest first, so a body's parent already has its own path when it is reached.
marineBodies.sort((a, b) => boxArea(b.box) - boxArea(a.box));

/** A body whose extent wraps the antimeridian — the Bering Sea — has an extent
 *  spanning the planet, which would make it everything's parent. */
const wraps = body => body.box[2] - body.box[0] > 180;

for (const body of marineBodies) {
    if (body.isOcean) {
        body.path = `world/${pathSlug(body.name)}`;
    } else {
        let parent = null;
        for (const other of marineBodies) {
            if (other === body || other.isOcean || !other.path || wraps(other)) continue;
            if (overlapShare(other.box, body.box) < NESTED) continue;
            if (!parent || boxArea(other.box) < boxArea(parent.box)) parent = other;
        }
        if (!parent) {
            // Only an ocean can adopt an unnested body. Allowing any larger sea
            // to do it chains them — North Sea under the Norwegian under the
            // Greenland under the Arctic — inventing a hierarchy the data does
            // not have. An enclosed sea that reaches no ocean within FAR, the
            // Black Sea and the Caspian, sits at the top instead.
            let nearest = Infinity;
            const own = ringsOf(body.geometry)[0];
            for (const ocean of oceanBodies) {
                const d = Math.min(...ringsOf(ocean.geometry).map(r => ringDistance(own, r)));
                if (d < nearest) { nearest = d; parent = d <= FAR ? ocean : null; }
            }
        }
        body.path = parent ? `${parent.path}/${pathSlug(body.name)}` : `world/${pathSlug(body.name)}`;
    }
    const boxes = partBoxes(body.geometry);
    if (!boxes.length) continue;
    record(body.path, body.name, body.isOcean ? 'ocean' : 'water').boxes.push(...boxes);
    shapes.push({ path: body.path, kind: 'marine', boxes, rings: quantise(ringsOf(body.geometry)) });
}


// A country with one sub-region gains nothing from the extra rung: the two
// would carry the same extent under two names.
for (const region of [...regions.values()]) {
    if (region.level !== 'country') continue;
    const children = [...regions.values()].filter(r =>
        r.level === 'region' && r.path.startsWith(region.path + '/'));
    if (children.length === 1) regions.delete(children[0].path);
}

const out = [...regions.values()].sort((a, b) => a.path.localeCompare(b.path))
    .map(r => ({ ...r, boxes: r.boxes.map(b => b.map(round)) }));

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'regions.json'), JSON.stringify(out) + '\n');
mkdirSync(CACHE, { recursive: true });
writeFileSync(join(CACHE, 'region-shapes.json'), JSON.stringify(shapes) + '\n');

const byLevel = out.reduce((n, r) => ({ ...n, [r.level]: (n[r.level] ?? 0) + 1 }), {});
const marineLevels = out.filter(r => r.level !== 'continent' && r.level !== 'country' && r.level !== 'region');
const kb = f => Math.round(Buffer.byteLength(readFileSync(f)) / 1024);
console.log(`✅ data/regions.json — ${out.length} regions ` +
            `(${byLevel.continent} continents, ${byLevel.country} countries, ${byLevel.region} sub-country), ` +
            `${kb(join(DATA, 'regions.json'))} KB`);
console.log(`🌊 ${byLevel.ocean} oceans, ${byLevel.water ?? 0} named seas, gulfs and bays under them`);
console.log(`🗺  .cache/region-shapes.json — ${shapes.length} polygons, ${kb(join(CACHE, 'region-shapes.json'))} KB`);
if (orphans.size) console.log(`⚠️  no continent for: ${[...orphans].sort().join(', ')}`);
