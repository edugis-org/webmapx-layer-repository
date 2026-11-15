import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueRecord, scaleDenominator, fetchCatalogue, interleaveByHost } from '../lib/allmaps-catalogue.mjs';
import { layerFor } from '../lib/allmaps.mjs';

const v2 = metadata => ({ '@type': 'sc:Manifest', metadata: metadata.map(([label, value]) => ({
    label, value: { '@value': value, '@language': 'en' } })) });

test('reads maker, date, scale and subjects from an IIIF 2 manifest', () => {
    assert.deepEqual(catalogueRecord(v2([
        ['Creator/Contributor', 'Sanborn Map Company (cartographer)'],
        ['Date Created/Date Issued', '1912-01-01'],
        ['Genre', 'Fire insurance maps| Digital maps'],
        ['Topic', 'Fire risk assessment maps'],
        ['Cartographic Information', '29.3000, -94.7833 (WGS84)| Scale 1:600 ; drawn to a scale of 50 feet to an inch.'],
        ['License', 'CC BY'],
    ])), {
        creator: 'Sanborn Map Company (cartographer)',
        date: '1912-01-01',
        year: 1912,
        scale: '1:600 ; drawn to a scale of 50 feet to an inch.',
        scaleDenominator: 600,
        subjects: ['Fire insurance maps', 'Digital maps', 'Fire risk assessment maps'],
    });
});

test('takes the earliest date: a scan is never older than its map', () => {
    // Leiden files the scan's 2016 under both date labels and the map's 1850
    // inside a publication statement.
    const record = catalogueRecord({ metadata: [
        { label: 'Date issued', value: '2016 ' },
        { label: 'Publication date', value: '2016 ' },
        { label: 'Published', value: "'s-Gravenhage ; Gebroeders van Cleef, 1850 (['s-Gravenhage] : Topographisch Bureau van het Ministerie van Oorlog)" },
        { label: 'Subject (topical)', value: 'Unspecified' },
    ] });
    assert.equal(record.year, 1850);
    assert.equal(record.date, '1850');
    assert.equal(record.subjects, undefined);
});

test('reads IIIF 3 language maps and navDate, and returns null for a bare manifest', () => {
    const record = catalogueRecord({ navDate: '1883-01-01T00:00:00Z', metadata: [
        { label: { en: ['Names'] }, value: { en: ['Sanborn Map & Publishing Co. (Author)'] } },
        { label: { de: ['Maßstab'], en: ['Scale'] }, value: { none: ['[Ca. 1:7 700]'] } },
        { label: { en: ['Subjects'] }, value: { en: ['Oshkosh (Wis.) -- Maps', 'Fire insurance'] } },
    ] });
    assert.equal(record.creator, 'Sanborn Map & Publishing Co. (Author)');
    assert.equal(record.year, 1883);
    assert.equal(record.scaleDenominator, 7700);
    assert.deepEqual(record.subjects, ['Oshkosh (Wis.)', 'Maps', 'Fire insurance']);
    assert.equal(catalogueRecord({ metadata: [] }), null);
});

test('parses scale denominators in every thousands notation', () => {
    assert.equal(scaleDenominator('1:950,400 & 1:31,680.'), 950400);
    assert.equal(scaleDenominator('[ca. 1:100.000]'), 100000);
    assert.equal(scaleDenominator('1 : 25 000'), 25000);
    assert.equal(scaleDenominator('100 sazhens to the inch (about 1:8,400)'), 8400);
    assert.equal(scaleDenominator('not indicated'), null);
});

test('caches definite answers but leaves transient failures for the next run', async () => {
    const answers = {
        'https://a.example/ok': () => new Response(JSON.stringify({ metadata: [{ label: 'Date', value: '1700' }] })),
        'https://a.example/html': () => new Response('<!DOCTYPE html>'),
        'https://b.example/gone': () => new Response('', { status: 404 }),
        'https://b.example/busy': () => new Response('', { status: 503 }),
        'https://c.example/down': () => { throw new Error('timeout'); },
    };
    const stats = {};
    const result = await fetchCatalogue(Object.keys(answers), { fetchImpl: async url => answers[url](), stats, pause: 0 });
    assert.deepEqual(stats, {
        'a.example': { record: 1, 'not-json': 1 },
        'b.example': { 'http-404': 1, transient: 1 },
        'c.example': { transient: 1 },
    });
    assert.deepEqual(result.get('https://a.example/ok'), { date: '1700', year: 1700 });
    assert.equal(result.get('https://a.example/html'), null);
    assert.equal(result.get('https://b.example/gone'), null);
    assert.equal(result.has('https://b.example/busy'), false);
    assert.equal(result.has('https://c.example/down'), false);
});

test('a catalogue record reaches the layer, and its date beats the title', () => {
    const f = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[5, 52], [5.1, 52], [5.1, 52.1], [5, 52]]] },
        properties: { id: 'https://annotations.allmaps.org/maps/x', resource: { partOf: [{ type: 'Canvas', partOf: [
            { type: 'Manifest', id: 'https://lib.example/m.json', label: { en: ['Plan van Utrecht, 1900'] } }] }] } } };
    const catalogue = new Map([['https://lib.example/m.json',
        { creator: 'J. Smit', date: '[ca. 1895]', year: 1895, scale: '1:10.000', scaleDenominator: 10000, subjects: ['Stadsplattegronden'] }]]);
    const layer = layerFor(f, { catalogue });
    const m = layer.webmapxConfig.layer.metadata;
    assert.equal(m.year, 1895);
    assert.equal(m.creator, 'J. Smit');
    assert.equal(m.scaleDenominator, 10000);
    assert.deepEqual(m.subjects, ['Stadsplattegronden']);
    assert.match(layer.abstract, /Made by J\. Smit\. Dated \[ca\. 1895\]\. Scale 1:10\.000\. Subjects: Stadsplattegronden\./);
    assert.equal(layerFor(f).webmapxConfig.layer.metadata.year, 1900);
});

test('stops asking a host after repeated failures, and sends a wildcard Accept', async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://down.example/${i}`).concat('https://up.example/1');
    let asked = 0, accept;
    const result = await fetchCatalogue(urls, { pause: 0, giveUpAfter: 5, stats: {}, fetchImpl: async (url, init) => {
        if (url.startsWith('https://up')) { accept = init.headers.accept; return new Response('{}'); }
        asked++;
        throw new Error('ECONNRESET');
    } });
    assert.equal(asked, 5);
    assert.equal(result.size, 1);
    assert.match(accept, /\*\/\*/);
});

test('reports manifests it never asked, so they are not marked as failed', async () => {
    const urls = Array.from({ length: 8 }, (_, i) => `https://down.example/${i}`);
    const skipped = new Set();
    const result = await fetchCatalogue(urls, { pause: 0, giveUpAfter: 3, skipped, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(result.size, 0);
    assert.equal(skipped.size, 5);
});

test('hosts take turns, each keeping its own order', () => {
    const urls = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://b.example/1', 'https://c.example/1', 'https://c.example/2'];
    assert.deepEqual(interleaveByHost(urls), [
        'https://a.example/1', 'https://b.example/1', 'https://c.example/1',
        'https://a.example/2', 'https://c.example/2', 'https://a.example/3',
    ]);
});
