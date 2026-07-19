import { INSTRUMENT_PREFIX } from './config';

/**
 * Build a unique market ID from a Gemini instrumentSymbol.
 * Format: "gemi-{instrumentSymbol}"
 *
 * A market encompasses both YES and NO sides of a single contract.
 */
export function toMarketId(instrumentSymbol: string): string {
    return `gemi-${instrumentSymbol}`;
}

/**
 * Extract the instrumentSymbol from our market ID format.
 */
export function fromMarketId(marketId: string): string {
    const prefix = 'gemi-';
    if (!marketId.startsWith(prefix)) {
        throw new Error(`Invalid Gemini Titan market ID: ${marketId}`);
    }
    return marketId.slice(prefix.length);
}

/**
 * Build an outcome ID that encodes both the instrumentSymbol and side.
 * Format: "GEMI:{instrumentSymbol}:{side}"
 *
 * The side is needed because Gemini orders require an explicit
 * "outcome" field ("yes" or "no").
 */
export function toOutcomeId(instrumentSymbol: string, side: 'yes' | 'no'): string {
    return `GEMI:${instrumentSymbol}:${side}`;
}

/**
 * Decode an outcome ID back into instrumentSymbol and side.
 */
export function fromOutcomeId(outcomeId: string): { instrumentSymbol: string; side: 'yes' | 'no' } {
    const parts = outcomeId.split(':');
    if (parts.length !== 3 || parts[0] !== 'GEMI') {
        throw new Error(`Invalid Gemini Titan outcome ID: ${outcomeId}`);
    }
    const side = parts[2];
    if (side !== 'yes' && side !== 'no') {
        throw new Error(`Invalid side in outcome ID: ${outcomeId}`);
    }
    return { instrumentSymbol: parts[1], side };
}

/**
 * Check if a string looks like a Gemini prediction market instrument symbol.
 */
export function isGeminiInstrument(symbol: string): boolean {
    return symbol.startsWith(INSTRUMENT_PREFIX);
}
