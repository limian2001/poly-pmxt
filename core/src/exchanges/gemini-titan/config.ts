export const DEFAULT_GEMINI_BASE_URL = 'https://api.gemini.com';
export const GEMINI_SANDBOX_BASE_URL = 'https://api.sandbox.gemini.com';

export const GEMINI_WS_URL = 'wss://ws.gemini.com';
export const GEMINI_SANDBOX_WS_URL = 'wss://ws.sandbox.gemini.com';

// All Gemini prediction market instrument symbols use this prefix
export const INSTRUMENT_PREFIX = 'GEMI-';

// Gemini prediction market prices are in the range [0.01, 0.99]
export const MIN_PRICE = 0.01;
export const MAX_PRICE = 0.99;
export const TICK_SIZE = 0.01;

// Payout is always $1.00 per winning contract
export const PAYOUT_PER_CONTRACT = 1.0;

export interface GeminiApiConfig {
    baseUrl: string;
    wsUrl: string;
    sandbox: boolean;
}

export function getGeminiConfig(
    baseUrlOverride?: string,
    sandbox?: boolean,
): GeminiApiConfig {
    const isSandbox = sandbox ?? false;
    return {
        baseUrl: baseUrlOverride ?? (isSandbox ? GEMINI_SANDBOX_BASE_URL : DEFAULT_GEMINI_BASE_URL),
        wsUrl: isSandbox ? GEMINI_SANDBOX_WS_URL : GEMINI_WS_URL,
        sandbox: isSandbox,
    };
}
