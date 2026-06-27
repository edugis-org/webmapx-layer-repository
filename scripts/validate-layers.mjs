#!/usr/bin/env node
/**
 * Validates all provider JSON files against schema/provider.schema.json.
 * Skips $ref link files.
 *
 * Usage: node scripts/validate-layers.mjs [--file layers/world/openstreetmap.json]
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../');
const args = process.argv.slice(2);
const fileArg = args.find(a => a.startsWith('--file=') || a === '--file');
const targetFile = fileArg
    ? (fileArg === '--file' ? args[args.indexOf('--file') + 1] : fileArg.slice(7))
    : null;

const schema = JSON.parse(readFileSync(join(ROOT, 'schema/provider.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function allProviderFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'index.json') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...allProviderFiles(full));
        } else if (entry.endsWith('.json')) {
            try {
                const raw = JSON.parse(readFileSync(full, 'utf8'));
                if (!raw.$ref) results.push(full);
            } catch { /* skip unparseable — reported below */ }
        }
    }
    return results;
}

const files = targetFile
    ? [resolve(ROOT, targetFile)]
    : allProviderFiles(join(ROOT, 'layers'));

let errors = 0;

for (const file of files) {
    const rel = file.replace(ROOT + '/', '');
    let data;
    try {
        data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        console.error(`❌ ${rel}: invalid JSON — ${e.message}`);
        errors++;
        continue;
    }

    const valid = validate(data);
    if (valid) {
        console.log(`✅ ${rel}`);
    } else {
        console.error(`❌ ${rel}`);
        for (const err of validate.errors) {
            console.error(`   ${err.instancePath || '/'} ${err.message}`);
        }
        errors++;
    }
}

console.log(`\n─────────────────────────────────`);
console.log(`Validated ${files.length} files — ${errors} error(s)`);
if (errors > 0) process.exit(1);
