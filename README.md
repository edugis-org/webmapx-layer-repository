# WebMapX Layer Repository

Curated catalog of known map layer services, organized by geographic data extent and provider.

## Structure

The `layers/` directory tree mirrors **geographic data extent** — not provider origin. The same provider (e.g. Esri) can appear in multiple places for different spatial coverages.

The hierarchy is fully recursive: continent → sub-region → country → province/state → city. Depth is up to the administrator.

```
layers/
  world/                      # Data covering the entire world
  europe/                     # Data confined to Europe
    germany/
      esri.json               # Esri layers covering Germany only
      bkg.json                # Bundesamt für Kartographie und Geodäsie
    netherlands/
      pdok.json               # PDOK — Dutch public geo-data
      noord-holland/
        amsterdam/
    eu/                       # EU member states as a group
      germany.json            # { "$ref": "../germany" } → expands europe/germany/
      netherlands.json        # { "$ref": "../netherlands" }
  north-america/
    usa/
      california/
  asia/ africa/ south-america/ oceania/
schema/
  provider.schema.json        # JSON schema for provider files
ui/
  index.html                  # Browser UI: browse, search, preview, copy config
scripts/
  build-index.mjs             # Scans layers/ tree → writes layers/index.json
  test-layers.mjs             # Availability tester: checks tiles, updates status/lastChecked
```

### Link files

To avoid duplicating provider files when a region belongs to multiple groupings, place the real files in one directory and use a minimal link file that points to the directory:

```json
{ "$ref": "../germany" }
```

From `europe/eu/germany.json`, `../germany` resolves to `europe/germany/`. The index builder expands the link to all provider files in that directory. Adding a new provider to `europe/germany/` automatically makes it appear under `europe/eu/germany` too — no extra link maintenance needed.

## Provider file format

Each `<provider>.json` contains one provider and its layers for the region indicated by the directory:

```json
{
  "provider": {
    "id": "esri",
    "name": "Esri",
    "url": "https://www.esri.com",
    "abstract": "Esri basemaps and thematic layers covering Germany.",
    "access": "free",              // free | api-key | paid | registration
    "license": "Esri Master License Agreement",
    "categories": ["general-purpose", "satellite"],
    "status": "active"
  },
  "layers": [
    {
      "id": "esri-topo-germany",
      "title": "Topographic (Germany)",
      "type": "raster",            // raster | vector | wms | wmts | wfs | geojson | mvt | 3d-tiles | terrain
      "status": "active",          // active | deprecated | unknown
      "lastChecked": "2026-06-27",
      "requiresKey": false,
      "webmapxConfig": { ... }     // ready-to-use webmapx layer config
    }
  ]
}
```

API key placeholder syntax in tile URLs: `{key-<providername>}` — matches webmapx substitution convention.

## API keys

Copy `apikeys.example.json` → `apikeys.json` (gitignored) and fill in your keys. The UI and tester load this file automatically when present.

In CI, pass keys as environment variables: `APIKEY_OPENWEATHERMAP`, `APIKEY_MAPBOX`, etc.

## UI

```bash
npm run serve
# → http://localhost:5200/ui/
```

- Browse providers by region, search by name/category
- Config button: copy ready-to-use webmapx layer config (keys substituted if apikeys.json present)
- Preview button: live MapLibre map preview (enabled when keys available)

## Scripts

```bash
npm run build-index               # Rebuild layers/index.json after adding/removing files
npm run test-layers               # Test all layers, write status + lastChecked
npm run test-layers:dry           # Test without writing files
node scripts/test-layers.mjs --file layers/world/openstreetmap.json
```

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
