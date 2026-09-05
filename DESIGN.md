# Design notes and where to go next

Written 2026-09-05, after the session that introduced services, harvesting and
availability measurement. This records *why* the repository is shaped the way it
is, and what is still open. `README.md` covers how to run things.

## 1. The model

```
provider   Who publishes the data.
  service  One endpoint, with its own CRS list, formats, auth and rate limit.
    layer  One dataset rendered one way, with a ready-to-use webmapxConfig.
```

Three levels, because two were not enough. Layers hanging straight off a provider
had to repeat the endpoint on every layer, and there was nowhere to say that PDOK
runs a WMTS for basemaps, a WMS for overlays and a WFS for features. Sixteen hosts
in the original catalog each backed several layers; the endpoint was copy-pasted
every time.

**A provider is not a hostname.** The EduGIS atlas configs pointed 940 of their
1112 URLs at `*.edugis.nl` hosts that proxy PDOK, RIVM and others. Importing by
hostname would have invented one "edugis" provider owning other people's data.
Those 940 were deliberately left out — see §5.

### Curated / generated / measured

The single most useful distinction in the repository. Each kind of data has a
different home and a different lifecycle.

| | where | in git? | lifecycle |
|---|---|---|---|
| **Curated** | `sources/`, `layers/` | yes | hand-written, reviewed in PRs |
| **Generated** | `harvested/` | **no** | rebuilt wholesale by `npm run harvest` |
| **Measured** | `status/` | yes | appended to, never regenerable |

Git holds the endpoints and the code that reads them; running the harvest
produces the rest, like `npm install`. A `sources/` entry is about ten lines and
yields thousands of layers, and reviewing one means judging whether an endpoint
is worth trusting — something a person can actually do. Nobody can review 3284
generated layer records, so nobody should be asked to.

`status/` is the exception that proves the rule: it stays in git because it
**cannot be regenerated**. No rerun recreates "up 51 of the last 52 weeks"; it
only accrues by observing. It is not a build artifact.

Current state: 156 curated layers in 54 services across 31 providers; 1837
harvested layers in 233 services from **2 source files**.

## 2. Decisions worth not relitigating

**Lifecycle and availability are separate fields.** The old `status` conflated
what the operator announced with what was measured. `lifecycle`
(`stable|beta|deprecated|retired`) is curated and never written by tooling;
`availability` (`up|down|auth-required|unreachable|unknown`) is written only by
the prober and never by hand. A 403 is `auth-required` — the endpoint answered —
and a DNS failure is `unreachable`; collapsing both into "unknown" hid real
differences.

**Availability is measurement, not validation.** `test-layers` exits 0 whatever
it finds. An upstream service being down is a fact about the world, not a defect
in this repository. Only `validate-layers`, which checks the files themselves,
can fail a build.

**Uptime excludes probes that reached no verdict.** A layer that could not be
tested is not a layer that failed. `untested` is reported alongside, so 100%
uptime resting on two probes is visibly weak.

**Credentials never live in source.** API keys *and* the request origin go in
`apikeys.json` (gitignored) or the environment. Stadia issues no API key at all
and authenticates on `Referer`; MapTiler locks keys to registered origins.
Hard-coding a domain put one deployment's access configuration into shared code.

**Provider notes describe the service, not our account.** "MapTiler locks keys to
registered origins" is catalog data. "Our Pages URL is not registered" is not.

**`{time}` follows the OGC WMTS `<Dimension>`, whose UOM is ISO 8601.** MapLibre
has no time token, so `lib/time.mjs` resolves it before the source is added,
shared by prober and UI rather than copied. `lag` keeps `latest` off tiles that
have not been produced yet; `snapToPeriod` floors onto the published grid, since
a monthly product advertises `2026-08-01/…/P1M` and rejects an arbitrary day.

**Coverage is a property of the product, not of the time you pick.** An L2 swath
product returns that day's orbital strips; no date yields a full global field.
Only a composited (L3) or analysed (L4) product does. `coverage` and
`compositedOver` record this so users can choose correctly instead of discovering
holes.

**Attributes come from WFS, not GetFeatureInfo.** A WMS cannot describe its own
fields; `GetFeatureInfo` samples a point and returns whatever is there — one
feature, not a schema, and nothing where the map is empty. `DescribeFeatureType`
on the WFS beside it (`/wms/` → `/wfs/`) gives a typed list. Where that 404s the
data is genuinely raster, which is worth recording rather than retrying.

**Legends come from `LegendURL` in the capabilities document**, not a constructed
`GetLegendGraphic` call — PDOK answers that with `OperationNotSupported` while
publishing legend images perfectly well.

## 3. Open decisions

### 3.1 Storage: files, or a database?

Measured, not guessed:

- Full PDOK import ≈ **3 MB of layer JSON**. Not a scale problem; a browser
  filters a few thousand rows without noticing.
- Uptime history at 2000 layers × 104 weekly checks = **208,000 rows, ~21 MB,
  rewritten weekly in git**. That *is* a problem.

The catalog should not move into a database as source of truth: git *is* the
curation mechanism (diffs, PRs, CI, blame), a binary file gives that up, and "a
service on top" means giving up static GitHub Pages hosting — the catalog would
then need the SLA it exists to describe.

Where a database genuinely earns its place:

1. **Uptime history** — append-only time series, queried by aggregate. Already
   straining the JSON-per-provider design.
2. **Harvested layers past ~100k rows**, once harvesting goes beyond PDOK.
3. **Multi-hierarchy query** — region, topic, featuretype, attributes, provider,
   operator type, uptime, cost. Six orthogonal axes; a directory tree expresses
   exactly one.

The option that gets SQL without a server: generate SQLite as a **build
artifact** and query it in the browser over HTTP range requests
(`sql.js-httpvfs`), or DuckDB-WASM over Parquet. Static hosting, real SQL, JSON
stays the reviewable source of truth. `build-index.mjs` already does this shape
of work.

**Recommendation:** not yet for the catalog; soon for `status/`.

### 3.2 The directory tree only expresses one hierarchy

`layers/` mirrors geographic extent. Users also want topic, featuretype,
attributes, provider quality and cost. Those need generated indexes, not
directories. Note the current tagging is also at the wrong level: `categories`
sit on the **provider**, so Esri's 14 layers inherit one label and "show me
elevation layers" is unanswerable.

### 3.3 How much to harvest, and how often

`--enrich` made ~1750 requests to PDOK in one run. It is opt-in and cached in
`.cache/`, but CI starts cold on every push. Either cache `.cache/` in the
workflow or enrich only on a schedule — decide before that workflow runs often.

Separately, `check-layers` currently probes only the 156 curated layers. Probing
2040 weekly is a different proposition: runtime, rate limits, and 208k history
rows a year.

### 3.4 CBS Gebiedsindelingen

~600 of PDOK's 1822 harvested layers are `CBS Gebiedsindelingen` for 2010–2023,
about 50 near-identical layers per year — buurt, wijk, gemeente, provincie. Either
trim with a `sources/` exclude pattern, or model the year as a dimension rather
than 14 nearly identical services. This is the same data as the
`cbsbuurtwijkgemeente` project, already published as WMS.

## 4. Known gaps

- **`check-layers.yml` stages `git add layers/` only**, so CI-measured history in
  `status/` is discarded. It also has no `PROBE_REFERER` secret, so it records
  `auth-required` for providers that are actually fine and will commit that
  weaker picture over local results on the next scheduled run.
- **`edugis-org.github.io` is not a registered MapTiler origin** (403), so the
  deployed catalog cannot preview its own 8 MapTiler layers.
- **TomTom's key is refused regardless of origin** — account entitlement, not a
  domain restriction.
- **8 layers are dead and recorded as such**: GHSL (JRC GeoServer withdrawn, no
  WMS successor), SEDAC (host accepts no connections; population density was
  recovered via NASA GIBS).
- **`layers/world/europe/eu/germany.json`** is a `$ref` link resolving to zero
  providers.
- Legacy top-level `layers[]` still validates; `provider.status` is still written
  for the UI. Both are transitional and should be removed once nothing reads them.

## 5. Next steps, in the order I would do them

1. **Fix the CI gaps** (§4, first bullet). Small, and every week without it loses
   history that cannot be recovered.
2. **Convert existing providers into sources.** Belgian services, remaining Dutch
   ones. Each replaces hand-written layers with a self-refreshing endpoint. The
   curated surface should stop growing as the catalog grows.
3. **Move `status/` to SQLite** — the piece actually breaking, and independent of
   any decision about the catalog.
4. **Move `categories` to the layer** and generate topic/region indexes. This is
   what makes the catalog answer users' real questions.
5. **Harvest the 940 proxied EduGIS URLs**, now that services exist: model them
   as a service whose `operator` (the cache) differs from its `provider` (the
   upstream). The schema already allows this; nothing uses it yet.
6. **Featuretype and attribute search** across harvested layers — 1378 layers
   already carry field schemas, and nothing queries them.
7. **SQLite query artifact** (§3.1) when client-side filtering stops being enough.
