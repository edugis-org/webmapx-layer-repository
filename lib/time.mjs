/**
 * Resolution of the {time} token in tile URL templates.
 *
 * MapLibre substitutes {z}/{x}/{y}, {quadkey}, {ratio}, {prefix} and
 * {bbox-epsg-3857} itself, but has no notion of a time dimension. A
 * time-dimensioned service (NASA GIBS, any WMS-T) needs a concrete instant in
 * the URL before the source is added, so the consumer resolves {time} first.
 *
 * Vocabulary follows OGC WMTS 1.0.0, which models this as a <Dimension> whose
 * <ows:UOM> is ISO8601 and spells the token with the dimension identifier
 * ({Time}); WMS-T (WMS 1.3.0 Annex C) uses the same ISO 8601 values for TIME.
 * Both {time} and {Time} are accepted here.
 *
 * Shared verbatim by scripts/test-layers.mjs and the browser UI — import it,
 * do not copy it, or the catalog and the prober will drift.
 */

/** Matches {time} in any casing. */
const TIME_TOKEN = /\{time\}/gi;

export function hasTimeToken(str) {
    return typeof str === 'string' && /\{time\}/i.test(str);
}

/** ISO 8601 duration → milliseconds. Years and months are approximated (365 / 30 days). */
export function parseDuration(duration) {
    const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
        .exec(duration ?? '');
    if (!m) throw new Error(`not an ISO 8601 duration: ${duration}`);
    const [, y, mo, w, d, h, mi, s] = m.map(v => (v === undefined ? 0 : Number(v)));
    return ((((y * 365 + mo * 30 + w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/** Render an instant to the precision the endpoint expects. */
export function formatInstant(date, precision = 'day') {
    const iso = date.toISOString();
    switch (precision) {
        case 'year':   return iso.slice(0, 4);
        case 'month':  return iso.slice(0, 7);
        case 'day':    return iso.slice(0, 10);
        case 'hour':   return `${iso.slice(0, 13)}:00:00Z`;
        case 'minute': return `${iso.slice(0, 16)}:00Z`;
        case 'second': return `${iso.slice(0, 19)}Z`;
        default: throw new Error(`unknown time precision: ${precision}`);
    }
}

/**
 * Floor an instant onto the dimension's value grid.
 *
 * A monthly product does not accept an arbitrary day: GIBS advertises
 * 2026-08-01/…/P1M and rejects 2026-08-14. Snapping keeps "latest" landing on a
 * value the service actually publishes. Periods that do not describe a calendar
 * grid (P8D and friends) are left alone — their grid has an arbitrary epoch, so
 * flooring locally would guess wrong.
 */
export function snapToPeriod(date, period) {
    const d = new Date(date.getTime());
    switch (period) {
        case 'P1Y': return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        case 'P1M': return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
        case 'P1D': return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        default: return d;
    }
}

/**
 * The concrete ISO 8601 value {time} stands for.
 *
 * @param time  the layer's `time` declaration (see schema/provider.schema.json)
 * @param opts.value  an explicit instant chosen by the user, e.g. from a slider
 * @param opts.now    clock override, for tests
 */
export function resolveTimeValue(time = {}, opts = {}) {
    const requested = opts.value ?? time.default ?? 'latest';
    if (requested !== 'latest') return requested;   // already an ISO 8601 instant

    // 'latest' is the newest instant the service is expected to hold. Near-real-time
    // products trail the clock, so without `lag` we would ask for a tile that has
    // not been produced yet.
    const now = opts.now ?? new Date();
    const lag = time.lag ? parseDuration(time.lag) : 0;
    const instant = snapToPeriod(new Date(now.getTime() - lag), time.period);
    return formatInstant(instant, time.precision ?? 'day');
}

/** Substitute {time} in one template. */
export function resolveTimeTokens(template, time, opts) {
    if (!hasTimeToken(template)) return template;
    return template.replace(TIME_TOKEN, resolveTimeValue(time, opts));
}

/** Substitute {time} throughout a webmapxConfig, leaving everything else untouched. */
export function resolveTimeDeep(value, time, opts) {
    if (typeof value === 'string') return resolveTimeTokens(value, time, opts);
    if (Array.isArray(value)) return value.map(v => resolveTimeDeep(v, time, opts));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, resolveTimeDeep(v, time, opts)]));
    }
    return value;
}
