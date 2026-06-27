# WebMapX Layer Repository

Curated catalog of known map layer services, organized by region and provider.

## Structure

```
layers/
  world/           # Global services
  europe/          # European services
  north-america/
  asia/
  africa/
  south-america/
  oceania/
  <country>/       # Country-specific (e.g. netherlands/, germany/)
    <provider>.json
schema/
  provider.schema.json   # JSON schema for provider files
ui/
  index.html             # Browser UI to browse and search layers
scripts/
  test-layers.mjs        # Availability tester — checks tiles, updates status/lastChecked
```

## Provider file format

Each `<provider>.json` file contains one provider and its layers:

```json
{
  "provider": {
    "id": "openstreetmap",
    "name": "OpenStreetMap",
    "url": "https://www.openstreetmap.org",
    "abstract": "Community-maintained global street map.",
    "access": "free",              // free | api-key | paid | registration
    "license": "ODbL 1.0",
    "categories": ["general-purpose", "street-maps"],
    "regions": ["world"],
    "status": "active"
  },
  "layers": [
    {
      "id": "osm-standard",
      "title": "OSM Standard",
      "type": "raster",            // raster | vector | wms | wmts | wfs | geojson | mvt | 3d-tiles | terrain
      "status": "active",          // active | deprecated | unknown
      "lastChecked": "2026-06-27",
      "requiresKey": false,
      "webmapxConfig": { ... }     // ready-to-use webmapx layer config
    }
  ]
}
```

## UI

Open `ui/index.html` in a browser (needs a local HTTP server due to JSON fetches):

```bash
npm run serve
# → http://localhost:5200/ui/
```

## Layer availability tester

```bash
node scripts/test-layers.mjs               # test all layers, update status + lastChecked
node scripts/test-layers.mjs --dry-run     # test only, no file writes
node scripts/test-layers.mjs --file layers/world/openstreetmap.json
```

Layers requiring an API key are skipped (marked with `requiresKey: true`).

## Categories

`general-purpose` · `street-maps` · `satellite` · `elevation` · `terrain` ·
`weather` · `climate` · `population` · `boundaries` · `transport` ·
`hydrology` · `geology` · `tectonic` · `environment` · `land-use` ·
`historical` · `realtime` · `indoor` · `maritime` · `aviation`

## Access types

| Value | Meaning |
|-------|---------|
| `free` | No authentication needed |
| `api-key` | Free with a registered API key |
| `registration` | Free after account sign-up |
| `paid` | Commercial subscription required |
