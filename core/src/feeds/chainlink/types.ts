// ----------------------------------------------------------------------------
// Chainlink Price Feed — raw API types and configuration
// REST: https://github.com/pmxt-dev/pmxt-ohlc/blob/main/docs/CHAINLINK_API.md
// WS:   https://github.com/pmxt-dev/pmxt-ohlc/blob/main/docs/CHAINLINK_WS.md
// ----------------------------------------------------------------------------

// -- Raw API response shapes --------------------------------------------------

export interface ChainlinkLatestPriceRecord {
    readonly token: string;
    readonly price: number | null;
}

export interface ChainlinkLatestPricesResponse {
    readonly data: readonly ChainlinkLatestPriceRecord[];
}

export interface ChainlinkPriceRecord {
    readonly timestamp: number;
    readonly date: string;
    readonly token: string;
    readonly price: number | null;
}

export interface ChainlinkPricesResponse {
    readonly data: readonly ChainlinkPriceRecord[];
}

// -- Configuration ------------------------------------------------------------

export interface ChainlinkFeedConfig {
    /** Base URL for the Chainlink REST API. */
    readonly baseUrl?: string;
    /** API key for REST authentication (X-API-Key header). */
    readonly apiKey: string;
    /** WebSocket URL for live Chainlink events. */
    readonly wsUrl?: string;
    /** API key for WebSocket authentication (may differ from REST key). */
    readonly wsApiKey?: string;
    /** Reconnect interval in ms (default: 5000). */
    readonly reconnectIntervalMs?: number;
}

export const CHAINLINK_DEFAULTS = {
    baseUrl: process.env.CHAINLINK_API_URL || '',
    wsUrl: process.env.CHAINLINK_WS_URL || '',
    reconnectIntervalMs: 5000,
} as const;

// -- Token mapping ------------------------------------------------------------

export interface ChainlinkToken {
    readonly short: string;
    readonly pair: string;
    readonly base: string;
    readonly quote: string;
    readonly proxyAddress: string;
    readonly decimals: number;
}

export const SUPPORTED_TOKENS: readonly ChainlinkToken[] = [
    {
        short: 'eth',
        pair: 'ETH/USD',
        base: 'ETH',
        quote: 'USD',
        proxyAddress: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
        decimals: 8,
    },
    {
        short: 'btc',
        pair: 'BTC/USD',
        base: 'BTC',
        quote: 'USD',
        proxyAddress: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
        decimals: 8,
    },
    {
        short: 'xrp',
        pair: 'XRP/USD',
        base: 'XRP',
        quote: 'USD',
        proxyAddress: '0x785ba89291f676b5386652eB12b30cF361020694',
        decimals: 8,
    },
    {
        short: 'sol',
        pair: 'SOL/USD',
        base: 'SOL',
        quote: 'USD',
        proxyAddress: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',
        decimals: 8,
    },
] as const;

/** Map short token name -> token metadata. */
export const TOKEN_BY_SHORT = new Map(
    SUPPORTED_TOKENS.map((t) => [t.short, t]),
);

/** Map pair string (e.g. "ETH/USD") -> token metadata. */
export const TOKEN_BY_PAIR = new Map(
    SUPPORTED_TOKENS.map((t) => [t.pair, t]),
);

// -- WebSocket message types --------------------------------------------------

export interface ChainlinkWsEvent {
    readonly op: 'event';
    readonly source: 'chainlink';
    readonly chain: string;
    readonly symbol: string;
    readonly aggregator: string;
    readonly round_id: number;
    readonly price: number;
    readonly updated_at: number;
    readonly block_number: number;
    readonly log_index: number;
    readonly tx_hash: string;
}

export interface ChainlinkWsAck {
    readonly op: 'ack';
    readonly subscribed_all?: boolean;
    readonly subscribed?: readonly string[];
    readonly unsubscribed_all?: boolean;
    readonly unsubscribed?: readonly string[];
}

export interface ChainlinkWsError {
    readonly op: 'error';
    readonly code: string;
    readonly reason: string;
}

export interface ChainlinkWsPong {
    readonly op: 'pong';
}

export type ChainlinkWsMessage =
    | ChainlinkWsEvent
    | ChainlinkWsAck
    | ChainlinkWsError
    | ChainlinkWsPong;
