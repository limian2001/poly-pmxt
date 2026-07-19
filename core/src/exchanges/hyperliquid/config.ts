export const DEFAULT_HYPERLIQUID_BASE_URL = 'https://api.hyperliquid.xyz';
export const HYPERLIQUID_TESTNET_BASE_URL = 'https://api.hyperliquid-testnet.xyz';

export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
export const HYPERLIQUID_TESTNET_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';

// HIP-4 Outcome Markets asset ID encoding
// Asset ID = 100_000_000 + (10 * outcome_id) + side
// side: 0 = Yes, 1 = No
export const OUTCOME_ASSET_BASE = 100_000_000;
export const OUTCOME_MULTIPLIER = 10;
export const SIDE_YES = 0;
export const SIDE_NO = 1;

// EIP-712 signing constants
export const EXCHANGE_DOMAIN = 'Exchange';
export const EXCHANGE_CHAIN_ID = 1337;

// Minimum order value in USDH
export const MIN_ORDER_VALUE = 10;

export interface HyperliquidApiConfig {
    baseUrl: string;
    wsUrl: string;
    testnet: boolean;
}

export function getHyperliquidConfig(
    baseUrlOverride?: string,
    testnet?: boolean,
): HyperliquidApiConfig {
    const isTestnet = testnet ?? false;
    return {
        baseUrl: baseUrlOverride ?? (isTestnet ? HYPERLIQUID_TESTNET_BASE_URL : DEFAULT_HYPERLIQUID_BASE_URL),
        wsUrl: isTestnet ? HYPERLIQUID_TESTNET_WS_URL : HYPERLIQUID_WS_URL,
        testnet: isTestnet,
    };
}
