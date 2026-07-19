/**
 * Build a `sourceMetadata` object from a raw venue payload, capturing only the
 * venue-specific data that the unified shape would otherwise drop.
 *
 * Keys listed in `promotedKeys` are omitted because they are already
 * represented by first-class Unified / DB columns (price, volume, status, ...),
 * so keeping them here would duplicate data. Everything else on the raw payload
 * is preserved verbatim. `extra` adds non-promoted fields that live on a
 * different raw object (e.g. a parent event's series identifiers attached to a
 * market); `undefined` extras are skipped so we never store empty keys.
 *
 * Returns a new object — the inputs are never mutated.
 */
export function buildSourceMetadata(
    raw: Record<string, unknown> | null | undefined,
    promotedKeys: readonly string[],
    extra?: Record<string, unknown>,
): Record<string, unknown> {
    const promoted = new Set(promotedKeys);
    const out: Record<string, unknown> = {};

    if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw)) {
            if (!promoted.has(key)) out[key] = value;
        }
    }

    if (extra) {
        for (const [key, value] of Object.entries(extra)) {
            if (value !== undefined) out[key] = value;
        }
    }

    return out;
}
