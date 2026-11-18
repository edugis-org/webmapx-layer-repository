import test from 'node:test';
import assert from 'node:assert/strict';
import { styleIdSuffixes } from '../lib/style-ids.mjs';

// The same cut harvest.mjs applies.
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

test('names that slug apart keep their suffix unchanged', () => {
    assert.deepEqual(styleIdSuffixes(['default', 'Status 2020'], slug), ['default', 'status-2020']);
});

test('names that differ only past the cut are told apart by what differs', () => {
    // RCE Landschapsatlas, haltes_metro_en_sneltram: all three used to share one id.
    const base = 'Landschapsatlas_historische_infrastructuur_haltes_metro_en_sneltram_';
    const names = [`${base}style`, `${base}2000_style`, `${base}2025_style`];
    assert.equal(new Set(names.map(slug)).size, 1);
    assert.deepEqual(styleIdSuffixes(names, slug), ['style', '2000-style', '2025-style']);
});

test('only the colliding names change', () => {
    const long = 'x'.repeat(60);
    assert.deepEqual(styleIdSuffixes(['plain', `${long}_a`, `${long}_b`], slug), ['plain', 'a', 'b']);
});

test('ids stay unique when the differing part itself collides', () => {
    // Same slug and nothing after the common prefix to tell them apart.
    assert.deepEqual(styleIdSuffixes(['A b', 'a-b', 'a_b'], slug), ['a-b', 'a-b-2', 'a-b-2-2']);
});
