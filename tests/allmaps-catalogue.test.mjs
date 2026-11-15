import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueRecord, scaleDenominator, fetchCatalogue, interleaveByHost, tidyRecord } from '../lib/allmaps-catalogue.mjs';
import { layerFor, labelOf } from '../lib/allmaps.mjs';

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
        creator: 'Sanborn Map Company',
        date: '1912',
        year: 1912,
        scale: '1:600 ; drawn to a scale of 50 feet to an inch',
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
    assert.equal(record.creator, 'Sanborn Map & Publishing Co.');
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

test('stops starting requests when the time budget runs out, leaving the rest unread', async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://slow.example/${i}`);
    const skipped = new Set();
    const stats = {};
    let asked = 0;
    const result = await fetchCatalogue(urls, { pause: 0, budget: 50, skipped, stats, fetchImpl: async () => {
        asked++;
        await new Promise(r => setTimeout(r, 30));
        return new Response('{}');
    } });
    assert.equal(asked, 2);
    assert.equal(result.size, 2);
    assert.equal(skipped.size, 4);
    assert.equal(stats['slow.example'].deferred, 4);
});

test('hosts take turns, each keeping its own order', () => {
    const urls = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://b.example/1', 'https://c.example/1', 'https://c.example/2'];
    assert.deepEqual(interleaveByHost(urls), [
        'https://a.example/1', 'https://b.example/1', 'https://c.example/1',
        'https://a.example/2', 'https://c.example/2', 'https://a.example/3',
    ]);
});

test('NYPL names fold their roles per person and dates lose their sub-label', () => {
    assert.deepEqual(tidyRecord({
        creator: 'Ohman Map Co. (Creator); Petersen, H. B. (H. Buchardt) (Draftsman); Petersen, H. B. (H. Buchardt) (Engineer)',
        date: 'Date Issued: 1920 (Inferred)', year: 1920,
    }), { creator: 'Ohman Map Co.; Petersen, H. B. (H. Buchardt) (draftsman, engineer)', date: '1920 (inferred)', year: 1920 });
    assert.equal(tidyRecord({ creator: 'G.W. Bromley & Co. (Publication place)' }).creator, 'G.W. Bromley & Co.');
    assert.equal(tidyRecord({ creator: 'Valentine, D. T. (David Thomas), 1801-1869 (Publisher)' }).creator, 'Valentine, D. T. (David Thomas), 1801-1869 (publisher)');
    assert.equal(tidyRecord({ creator: 'Taintor Brothers', date: '[1875?]' }).date, '[1875?]');
    assert.equal(tidyRecord({ creator: 'Smith, John (Firm)' }).creator, 'Smith, John (Firm)');
});

test('reads NYPL Names and Dates / Origin as display text', () => {
    const record = catalogueRecord({ metadata: [
        { label: { en: ['Names'] }, value: { en: ["<span><a href='x'>G.W. Bromley & Co.</a>  (Publication place)</span>"] } },
        { label: { en: ['Dates / Origin'] }, value: { en: ["<span>Date Issued: <a href='x'>1959</a></span>", "<span>Place: <a href='x'>New York</a></span>"] } },
        { label: { en: ['Date Issued'] }, value: { en: ['1959'] } },
    ] });
    assert.equal(record.creator, 'G.W. Bromley & Co.');
    assert.equal(record.date, '1959');
});

test('unwraps a label whose text is itself a language map', () => {
    assert.equal(labelOf({ none: ['{"none":["[Plan of the battles of Saratoga]"]}'] }), '[Plan of the battles of Saratoga]');
    assert.equal(labelOf({ none: ['{Braces} in a title'] }), '{Braces} in a title');
});

test('catalogue punctuation, authority ids and placeholder dates are tidied', () => {
    const t = c => tidyRecord({ creator: c }).creator;
    assert.equal(t('Schenk, Petrus, 1693-1775,; Zürner, Adam Friedrich, 1679-1742,'), 'Schenk, Petrus, 1693-1775; Zürner, Adam Friedrich, 1679-1742');
    assert.equal(t('Flinders, Matthew, 1774-1814, cartographer.'), 'Flinders, Matthew, 1774-1814');
    assert.equal(t('Hooghe, Cornelis de, 1540 or 1541-1583, engraver'), 'Hooghe, Cornelis de, 1540 or 1541-1583 (engraver)');
    assert.equal(t('Ortelius, Abraham, 1527-1598 -- (GND: 118736590 )'), 'Ortelius, Abraham, 1527-1598');
    assert.equal(t('Verniquet, Edme (1727-1804). Auteur du texte; Mathieu, A. J. (17..-18..; dessinateur). Graveur'),
        'Verniquet, Edme (1727-1804); Mathieu, A. J. (17..-18..; dessinateur) (graveur)');
    assert.equal(t('Great Britain. War Office. General Staff. Geographical Section.'), 'Great Britain. War Office. General Staff. Geographical Section');
    assert.equal(t('Kochersperger, H. L. (publisher); O.W. Gray & Son; Davis, F. A.'), 'Kochersperger, H. L. (publisher); O.W. Gray & Son; Davis, F. A.');
    assert.equal(t('Geo. H. Walker & Co.'), 'Geo. H. Walker & Co.');
    assert.equal(t('Bull, Edward (Publisher), publisher'), 'Bull, Edward (publisher)');
    assert.equal(t('Bull, Edward (Publisher) (Publisher)'), 'Bull, Edward (publisher)');
    assert.equal(t('Delisle, Guillaume, 1675-1726.'), 'Delisle, Guillaume, 1675-1726');
    const d = s => tidyRecord({ date: s, year: 1 }).date;
    assert.equal(d('1912-01-01'), '1912');
    assert.equal(d('1912-03-01'), '1912-03-01');
    assert.equal(d('1956-XX-XX/1961-XX-XX'), '1956–1961');
    assert.equal(d('1850/1864'), '1850–1864');
    assert.equal(d('1635;'), '1635');
    assert.equal(d('2022/06/30'), undefined);
    assert.deepEqual(tidyRecord({ subjects: ['Österreich', '(GND: 4043271-3 )', 'Atlas'] }).subjects, ['Österreich', 'Atlas']);
    assert.equal(d('1941-XX-XX/..'), '1941–');
    assert.equal(d('[ca. 1710]'), '[ca. 1710]');
    assert.deepEqual(tidyRecord({ date: 'Date of digitisation: 2022', year: 2022, creator: 'X' }), { creator: 'X' });
    assert.equal(tidyRecord({ scale: "1:14 000. With 1 bar scale: Echelle de 1000 Mètres = 6.9 cm; (VE 2°21')" }).scale, '1:14 000');
    assert.equal(tidyRecord({ scale: '1:600 ; drawn to a scale of 50 feet to an inch.' }).scale, '1:600 ; drawn to a scale of 50 feet to an inch');
});

test('a digitisation date is not read as the map\'s date', () => {
    const record = catalogueRecord({ metadata: [
        { label: 'Date of digitisation', value: '2022' },
        { label: { fr: ['Date de mise en ligne'], en: ['Date of online publication'] }, value: { fr: ['2022/06/30'] } },
        { label: 'Scale', value: '1:50.000' },
    ] });
    assert.equal(record.date, undefined);
    assert.equal(record.year, undefined);
});

test('titles lose appended shelfmarks and doubled halves', () => {
    assert.equal(labelOf('Waterstaatskaart van Nederland : op de schaal van 1:50.000 KAART: *VII*.B.a.21'), 'Waterstaatskaart van Nederland : op de schaal van 1:50.000');
    assert.equal(labelOf('[Le Sas de Gant fet en l\'an 1633] - COLLBN Port 38 N 128'), '[Le Sas de Gant fet en l\'an 1633]');
    assert.equal(labelOf('Plate No. 248 [Map bounded by W. 140th St., Lenox Ave., W.. 135th St.]'), 'Plate No. 248 [Map bounded by W. 140th St., Lenox Ave., W. 135th St.]');
    assert.equal(labelOf('nae de meetinge gedaen by Daniel Schellinex .. in den j. 1617 ...'), 'nae de meetinge gedaen by Daniel Schellinex .. in den j. 1617 ...');
    assert.equal(labelOf('Ballarat. 836 Zone 7. base map / Ballarat. 836 Zone 7. base map'), 'Ballarat. 836 Zone 7. base map');
});

test('a map without a manifest says it has no metadata', () => {
    const feature = {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[6.9, 52.9], [7, 52.9], [7, 53], [6.9, 53], [6.9, 52.9]]] },
        properties: {
            id: 'https://annotations.allmaps.org/maps/7f77aaae818b87b1',
            resource: { id: 'https://objects.library.uu.nl/iiif/x.jp2', type: 'ImageService2', provider: [{ label: { none: ['Universiteitsbibliotheek Utrecht'] } }] },
        },
    };
    const layer = layerFor(feature);
    assert.match(layer.abstract, /Universiteitsbibliotheek Utrecht: no metadata for this map/);
    assert.doesNotMatch(layer.abstract, /Scan held by/);
});

test('a map with neither manifest nor holder names the server its scan comes from', () => {
    const layer = layerFor({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[6.5, 53.2], [6.6, 53.2], [6.6, 53.3], [6.5, 53.3], [6.5, 53.2]]] },
        properties: { id: 'https://annotations.allmaps.org/maps/d95224f3a35606de', resource: { id: 'https://images.memorix.nl/gra/iiif/c9a6', type: 'ImageService2' } },
    });
    assert.match(layer.abstract, /Scan from images\.memorix\.nl: no metadata for this map/);
});
