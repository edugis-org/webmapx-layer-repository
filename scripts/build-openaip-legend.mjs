/**
 * Draws assets/legends/openaip-map.svg.
 *
 * openAIP publishes no legend image, but it does publish the style its own map
 * is drawn with. The rows below carry the colours, widths and dash patterns that
 * style applies to each airspace type at about zoom 10, so the legend can be
 * checked against the source and redrawn when openAIP changes it:
 *
 *   node scripts/build-openaip-legend.mjs            # redraw from the table
 *   node scripts/build-openaip-legend.mjs --check    # print the live style's
 *                                                    # airspace paint to compare
 *
 * The icons for airports, navaids, obstacles and hotspots are deliberately
 * absent: that icon set is CC BY-NC-SA 4.0, which this repository is not.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STYLE_URL = 'https://api.tiles.openaip.net/api/styles/openaip-default-style.json';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/legends/openaip-map.svg');

// kind: hatch | fill | line | dashdot | circle. Numbers are the style's own,
// read at zoom 10; `lop` is the line's opacity where the style fades it.
const rows = [
  ['Restricted, danger, prohibited', 'solid dark red edge, red hatch', 'hatch', { pat: 'red', op: 0.6, line: 'rgb(154,14,14)', w: 2 }],
  ['TSA — temporary segregated area', 'as above, drawn faint', 'hatch', { pat: 'red', op: 0.3, line: 'rgb(154,14,14)', w: 2, lop: 0.3 }],
  ['TRA — temporary reserved area', 'dashed dark red edge, red hatch', 'hatch', { pat: 'red', op: 0.3, line: 'rgb(154,14,14)', w: 2, dash: '12 4', lop: 0.3 }],
  ['TFR — temporary flight restriction', 'faint red edge', 'line', { line: 'rgb(154,14,14)', w: 1, lop: 0.5 }],
  ['Class A and B', 'dashed green edge, pale green fill', 'fill', { fill: 'rgb(51,158,47)', fop: 0.2, line: 'rgb(51,158,47)', w: 2, dash: '5 5', lop: 0.5 }],
  ['Class C and D', 'solid green edge, green hatch', 'hatch', { pat: 'green', op: 0.55, line: 'rgb(51,158,47)', w: 2 }],
  ['Class E', 'solid blue edge, no fill', 'line', { line: 'rgb(21,77,154)', w: 2 }],
  ['Class F', 'thick blue edge, blue-grey fill', 'fill', { fill: 'rgb(118,145,195)', fop: 0.5, line: 'rgb(21,77,154)', w: 4 }],
  ['Class G', 'dashed pale blue edge, very light fill', 'fill', { fill: 'rgb(118,145,195)', fop: 0.1, line: 'rgb(21,77,154)', w: 2, dash: '5 5', lop: 0.5 }],
  ['CTR — control zone', 'dashed blue edge, pink fill', 'fill', { fill: 'rgb(218,111,134)', fop: 0.2, line: 'rgb(21,77,154)', w: 3, dash: '12 4' }],
  ['TMA and CTA — control areas', 'solid blue edge, pink fill', 'fill', { fill: 'rgb(218,111,134)', fop: 0.2, line: 'rgb(21,77,154)', w: 2 }],
  ['TMZ — transponder mandatory zone', 'blue dash-dot edge', 'dashdot', { line: 'rgb(21,77,154)', w: 4 }],
  ['RMZ, TIZ, TIA', 'blue dotted edge, faint blue fill', 'fill', { fill: 'rgb(101,134,175)', fop: 0.1, line: 'rgb(21,77,154)', w: 2, dash: '2 2', lop: 0.5 }],
  ['TRP — transponder recommended', 'blue dotted edge', 'line', { line: 'rgb(21,77,154)', w: 4, dash: '2 2' }],
  ['MATZ, ATZ, HTZ — traffic zones', 'thin blue edge, blue hatch', 'hatch', { pat: 'blue', op: 0.3, line: 'rgb(21,77,154)', w: 1, lop: 0.3 }],
  ['MOA, MTA, MRT — military areas', 'dashed orange edge, faint orange fill', 'fill', { fill: 'rgb(255,146,0)', fop: 0.1, line: 'rgb(255,146,0)', w: 2, dash: '2 2', lop: 0.6 }],
  ['Alert, warning, protected area', 'dashed purple edge, purple fill', 'fill', { fill: 'rgb(147,53,201)', fop: 0.1, line: 'rgb(147,53,201)', w: 2, dash: '12 4', lop: 0.4 }],
  ['Aerial sporting and recreational', 'teal edge, hatched fill', 'hatch', { pat: 'teal', op: 0.5, line: 'rgb(0,139,175)', w: 2 }],
  ['Overflight restriction', 'thick violet edge', 'line', { line: 'rgb(119,21,154)', w: 3 }],
  ['Gliding sector', 'gold edge, faint gold fill', 'fill', { fill: 'rgb(255,215,0)', fop: 0.1, line: 'rgb(255,215,0)', w: 1 }],
  ['Airway (AWY), military training route', 'grey hatch on light grey', 'hatch', { pat: 'gray', op: 0.2, line: 'rgb(87,87,87)', w: 1, lop: 0.2, under: 'rgb(206,206,206)', uop: 0.4 }],
  ['Special rules area', 'muted green edge', 'line', { line: 'rgb(96,141,103)', w: 3, lop: 0.6 }],
  ['RC model airfield airspace', 'blue circle, blue fill', 'circle', { line: '#0741a2', fill: '#2973f8' }],
  ['FIR, FIS, ACC boundary', 'thick light green dashed edge', 'line', { line: 'rgb(110,201,32)', w: 6, dash: '10 5', lop: 0.4 }],
  ['UIR boundary', 'thick darker green dashed edge', 'line', { line: 'rgb(91,156,38)', w: 6, dash: '10 5', lop: 0.4 }],
  ['ADIZ — air defence identification zone', 'thick purple edge, purple fill', 'fill', { fill: 'rgb(122,0,150)', fop: 0.2, line: 'rgb(86,0,150)', w: 4 }],
];

const HATCHES = {
  red: 'rgb(154,14,14)', green: 'rgb(51,158,47)', blue: 'rgb(21,77,154)',
  gray: 'rgb(87,87,87)', teal: 'rgb(0,139,175)',
};

function draw() {
  const W = 560, SW = 86, ROW_H = 40, TOP = 72;
  const H = TOP + ROW_H * rows.length + 116;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">`);
  o.push('  <title>openAIP aviation chart — airspace legend</title>');
  o.push(`  <desc>Airspace symbology of the openAIP map, read from openAIP’s own published map style at ${STYLE_URL}. Colours, widths and dash patterns are those the style applies around zoom 10.</desc>`);
  o.push('  <defs>');
  for (const [name, colour] of Object.entries(HATCHES)) {
    o.push(`    <pattern id="hatch-${name}" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="${colour}" stroke-width="2"/></pattern>`);
  }
  o.push('  </defs>');
  o.push(`  <rect width="${W}" height="${H}" fill="#ffffff"/>`);
  o.push('  <text x="20" y="34" font-size="17" font-weight="600" fill="#1a1a1a">openAIP aviation chart — airspaces</text>');
  o.push('  <text x="20" y="54" font-size="11.5" fill="#666">Symbology as the openAIP map style draws it at about zoom 10.</text>');

  rows.forEach(([label, sub, kind, p], i) => {
    o.push(`  <g transform="translate(20,${TOP + i * ROW_H})">`);
    if (kind === 'hatch') {
      if (p.under) o.push(`    <rect width="${SW}" height="30" fill="${p.under}" opacity="${p.uop}"/>`);
      o.push(`    <rect width="${SW}" height="30" fill="url(#hatch-${p.pat})" opacity="${p.op}"/>`);
    } else if (kind === 'fill') {
      o.push(`    <rect width="${SW}" height="30" fill="${p.fill}" opacity="${p.fop}"/>`);
    } else if (kind === 'circle') {
      o.push(`    <circle cx="43" cy="15" r="13" fill="${p.fill}" fill-opacity="0.5" stroke="${p.line}" stroke-opacity="0.7" stroke-width="1"/>`);
    }
    const dash = p.dash ? ` stroke-dasharray="${p.dash}"` : '';
    const lop = p.lop === undefined ? '' : ` opacity="${p.lop}"`;
    if (kind === 'hatch' || kind === 'fill') {
      o.push(`    <line x1="0" y1="${p.w / 2}" x2="${SW}" y2="${p.w / 2}" stroke="${p.line}" stroke-width="${p.w}"${dash}${lop}/>`);
    } else if (kind === 'line') {
      o.push(`    <line x1="0" y1="15" x2="${SW}" y2="15" stroke="${p.line}" stroke-width="${p.w}"${dash}${lop}/>`);
    } else if (kind === 'dashdot') {
      o.push(`    <line x1="0" y1="15" x2="${SW}" y2="15" stroke="${p.line}" stroke-width="${p.w}" stroke-dasharray="10 10"/>`);
      o.push(`    <line x1="0" y1="15" x2="${SW}" y2="15" stroke="${p.line}" stroke-width="${p.w}" stroke-dasharray="2 5"/>`);
    }
    o.push(`    <text x="100" y="14" font-size="12.5" fill="#1a1a1a">${label}</text>`);
    o.push(`    <text x="100" y="28" font-size="11" fill="#777">${sub}</text>`);
    o.push('  </g>');
  });

  const fy = TOP + ROW_H * rows.length + 12;
  o.push(`  <line x1="20" y1="${fy}" x2="${W - 20}" y2="${fy}" stroke="#e0e0e0" stroke-width="1"/>`);
  o.push(`  <text x="20" y="${fy + 20}" font-size="11" fill="#666">Airports, navaids, reporting points, obstacles, hang gliding sites and thermal hotspots are</text>`);
  o.push(`  <text x="20" y="${fy + 36}" font-size="11" fill="#666">drawn as icons; that icon set is published separately, under CC BY-NC-SA 4.0.</text>`);
  o.push(`  <text x="20" y="${fy + 58}" font-size="11" fill="#888">Read from openAIP’s published map style, openaip-default-style.json.</text>`);
  o.push(`  <text x="20" y="${fy + 72}" font-size="11" fill="#888">Data © openAIP contributors.</text>`);
  o.push('</svg>');
  return o.join('\n') + '\n';
}

// Prints what the live style says today, so the table above can be checked
// against it by eye. It is not applied automatically: a legend is a reading of a
// style, and a machine that rewrote it would hide the day the reading changed.
async function check() {
  const res = await fetch(STYLE_URL);
  if (!res.ok) throw new Error(`${STYLE_URL} → ${res.status}`);
  const style = await res.json();
  for (const layer of style.layers) {
    if (!layer.id.startsWith('airspace')) continue;
    console.log(layer.id, layer.type, JSON.stringify(layer.paint));
  }
}

if (process.argv.includes('--check')) {
  await check();
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, draw());
  console.log(`✅ Wrote ${OUT} (${rows.length} rows)`);
}
