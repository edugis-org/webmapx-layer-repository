import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hitsUrl, parseHits, featureCounts } from '../lib/wfs-counts.mjs';

const LP = 'https://service.pdok.nl/lv/bag/wfs/v2_0?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
    + '&TYPENAMES=bag%3Aligplaats&OUTPUTFORMAT=application/json&COUNT=1000&SRSNAME=EPSG:4326';

test('a hits URL drops paging and output format, keeps the rest', () => {
    const u = new URL(hitsUrl(LP));
    assert.equal(u.searchParams.get('RESULTTYPE'), 'hits');
    assert.equal(u.searchParams.has('COUNT'), false);
    assert.equal(u.searchParams.has('OUTPUTFORMAT'), false);
    assert.equal(u.searchParams.get('TYPENAMES'), 'bag:ligplaats');
});

test('counts are read from 2.0 and 1.1 answers, not from "unknown"', () => {
    assert.equal(parseHits('<wfs:FeatureCollection numberMatched="11453084" numberReturned="0"/>'), 11453084);
    assert.equal(parseHits('<wfs:FeatureCollection numberOfFeatures="12"/>'), 12);
    assert.equal(parseHits('<wfs:FeatureCollection numberMatched="unknown"/>'), undefined);
    assert.equal(parseHits('<ows:ExceptionReport/>'), undefined);
});

test('counts are cached, and asked again only when stale', async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), 'wfs-counts-')), 'c.json');
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response('<x numberMatched="42"/>'); };
    const a = await featureCounts([LP], { cacheFile, fetchImpl, now: 0 });
    assert.equal(a.get(LP), 42);
    await featureCounts([LP], { cacheFile, fetchImpl, now: 1000 });
    assert.equal(calls, 1, 'fresh: not asked again');
    await featureCounts([LP], { cacheFile, fetchImpl, now: 31 * 24 * 3600 * 1000 });
    assert.equal(calls, 2, 'stale: asked again');
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8'))[LP].count, 42);
});

test('nothing is asked once the budget is spent; those stay uncached', async () => {
    const cacheFile = join(mkdtempSync(join(tmpdir(), 'wfs-counts-')), 'c.json');
    let calls = 0;
    const out = await featureCounts([LP], { cacheFile, budgetMs: 0, fetchImpl: async () => { calls++; return new Response(''); } });
    assert.equal(calls, 0);
    assert.equal(out.size, 0);
    assert.deepEqual(JSON.parse(readFileSync(cacheFile, 'utf8')), {});
});
