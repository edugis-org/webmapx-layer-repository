#!/usr/bin/env node
// Audit existing harvest output without fetching services. --write removes copies.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deduplicateLayers } from '../lib/deduplicate-layers.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../../');
const args = process.argv.slice(2);
const write = args.includes('--write');
const directory = resolve(root, args.find(arg => !arg.startsWith('--')) ?? 'harvested');
function* files(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* files(path);
        else if (entry.name.endsWith('.json')) yield path;
    }
}
let total = 0;
if (existsSync(directory)) for (const path of files(directory)) {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const count = deduplicateLayers(doc.services ?? []);
    if (!count) continue;
    total += count;
    console.log(`${relative(directory, path)}: ${count} exact duplicate layer(s)`);
    if (write) writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
}
console.log(`${total} exact duplicate layer(s) ${write ? 'removed' : 'found (use --write to remove)'}`);
