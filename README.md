# WebMapX Layer Repository

A catalog of map layer services: who provides them, what endpoints they run, what
layers those serve, and whether any of it is actually up.

## What is curated and what is generated

Two kinds of data live here, and the difference decides where each belongs.

**Curated** — in git, hand-written, reviewed in pull requests:

- `sources/` — pointers to places layers can be read from automatically. One
  entry is about ten lines and yields hundreds or thousands of layers. Reviewing
  one means judging whether an endpoint is worth trusting, which a person can do.
- `layers/` — layer definitions written by hand, for services that do not
  describe themselves. A Google or Bing tile template has no capabilities
  document; somebody has to write it down.

**Generated** — not in git, rebuilt on demand:

- `harvested/` — produced by `npm run harvest` from `sources/`. Regenerated
  wholesale, like `node_modules`. Never edit it; the next harvest overwrites it.

**Measured** — in git, because it cannot be regenerated:

- `status/` — the uptime record. Rerunning nothing recreates "up 51 of the last
  52 weeks"; it only accrues by observing, so it is committed like any other
  irreplaceable data.

```bash
npm install
npm run harvest       # sources/ -> harvested/
npm run build-index   # layers/ + harvested/ -> layers/index.json
npm run build         # both of the above
npm run serve         # browse at http://localhost:5200
```

A fresh clone has no `harvested/`; the index notes its absence and the site
serves the curated layers alone until you run the harvest.

## Provider → service → layer

```
provider   Who publishes the data. Identified by who they are, not by the
           hostname serving it — a cache is not the provider of what it fronts.
  service  One endpoint. PDOK runs a WMTS for basemaps, a WMS for thematic
           overlays and a WFS for features. The endpoint sets the CRS list,
           formats, auth and rate limit for everything it serves, so those are
           stated once here rather than repeated per layer.
    layer  One dataset as one renderable thing, with a ready-to-use
           webmapxConfig.
```

`layers/` mirrors **geographic extent**, not provider origin, and is fully
recursive: continent → country → province → city. The same provider appears
wherever it has coverage.

```
layers/
  world/                          data covering the whole world
    esri.json  nasa-earthdata.json  …
    styles/                       style variants, keyed by layerId
    europe/
      netherlands/
        pdok.json  rivm.json  rce.json
        flevoland/  noord-holland/amsterdam/
      belgium/
    north-america/caribbean-netherlands/
```

## Availability

`npm run test-layers` probes one tile or feature per layer and records what it
finds. Two fields, deliberately separate:

- `lifecycle` — what the operator says: `stable`, `beta`, `deprecated`,
  `retired`. Curated, never written by tooling.
- `availability` — what was measured: `up`, `down`, `auth-required`,
  `unreachable`, `unknown`. Written only by the prober, never by hand.

Uptime in `status/` excludes probes that reached no verdict: a layer that could
not be tested is not a layer that failed.

Availability is measurement, not validation. `test-layers` exits 0 whatever it
finds — an upstream service being down is not a defect in this repository. Only
`validate-layers`, which checks the files themselves, can fail a build.

## Credentials

Copy `apikeys.example.json` to `apikeys.json` (gitignored) and fill in what you
have. `referer` matters as much as the keys: Stadia issues no API key at all and
authenticates on the request origin, and MapTiler locks keys to registered
origins. In CI, pass keys as `APIKEY_<NAME>` secrets and the origin as
`PROBE_REFERER`.

## Time-dimensioned layers

Where a service needs an instant in the URL, the template carries `{time}` and
the layer declares a `time` block modelled on the OGC WMTS `<Dimension>`, whose
UOM is ISO 8601. MapLibre does not substitute `{time}`; `lib/time.mjs` does,
and is shared by the prober and the UI.

`coverage` says whether one instant covers the extent at all. A satellite L2
product returns that day's orbital swaths, so no choice of date yields a full
global field — only a composited or analysed product does. Picking a better time
is not a way to get full cover; choosing the right product is.

## Scripts

| command | does |
|---|---|
| `npm run harvest` | read `sources/`, write `harvested/` |
| `npm run build-index` | index `layers/` + `harvested/` into `layers/index.json` |
| `npm run validate-layers` | check every provider file against the schema |
| `npm run test-layers` | probe availability, append to `status/` |
| `npm run migrate-services` | one-shot: convert legacy `layers[]` to `services[]` |

Schemas live in `schema/`: `provider.schema.json` (providers, services, layers),
`source.schema.json` (harvest sources), `status.schema.json` (uptime history).
