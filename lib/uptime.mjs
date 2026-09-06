/**
 * Uptime history: the shape of status/, and the arithmetic over it.
 *
 * Shared by the layer prober and the source prober so that one measured record
 * means the same thing wherever it came from. Probes recorded as `unknown` are
 * excluded from both sides of the ratio: something we could not test is not
 * something that failed.
 */

/** Weekly checks kept per subject — two years of history. */
export const HISTORY_LIMIT = 104;

const FAILURE = new Set(['down', 'unreachable', 'auth-required']);

/** Roll a list of checks, oldest first, into the summary stored beside them. */
export function summarise(checks) {
    const verdicts = checks.filter(c => c.availability !== 'unknown');
    const up = verdicts.filter(c => c.availability === 'up');
    const untested = checks.length - verdicts.length;

    // Trailing failures since the last success. Probes we could not run are
    // stepped over rather than treated as either outcome.
    let consecutiveFailures = 0;
    for (let i = checks.length - 1; i >= 0; i--) {
        const a = checks[i].availability;
        if (a === 'up') break;
        if (FAILURE.has(a)) consecutiveFailures++;
    }

    const lastWith = pred => [...checks].reverse().find(pred)?.date;

    return {
        firstChecked: checks[0]?.date,
        lastChecked: checks[checks.length - 1]?.date,
        current: checks[checks.length - 1]?.availability,
        checks: checks.length,
        up: up.length,
        uptime: verdicts.length ? Number((up.length / verdicts.length).toFixed(4)) : null,
        untested,
        consecutiveFailures,
        lastUp: lastWith(c => c.availability === 'up'),
        lastDown: lastWith(c => c.availability === 'down' || c.availability === 'unreachable'),
    };
}

/**
 * Append a check to `record` (creating it) and re-summarise.
 * Re-running on the same day replaces that day's entry instead of stacking.
 */
export function recordCheck(bucket, key, check, date, limit = HISTORY_LIMIT) {
    const rec = bucket[key] ??= { checks: [] };
    const existing = rec.checks.findIndex(c => c.date === date);
    const entry = { date, ...check };
    if (existing >= 0) rec.checks[existing] = entry;
    else rec.checks.push(entry);

    if (rec.checks.length > limit) rec.checks = rec.checks.slice(rec.checks.length - limit);
    rec.summary = summarise(rec.checks);
    return rec.summary;
}
