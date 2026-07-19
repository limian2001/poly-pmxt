// ----------------------------------------------------------------------------
// Data Feed Types — CCXT-compatible unified types for auxiliary data feeds.
// These match CCXT's unified API structures exactly so users don't need to
// learn a parallel vocabulary.
// ----------------------------------------------------------------------------

export interface Dictionary<T> {
    [key: string]: T;
}

/**
 * CCXT-compatible Ticker structure.
 * Fields that a feed cannot populate are left undefined.
 */
export interface Ticker {
    symbol: string;
    info: any;
    timestamp: number | undefined;
    datetime: string | undefined;
    high: number | undefined;
    low: number | undefined;
    bid: number | undefined;
    bidVolume: number | undefined;
    ask: number | undefined;
    askVolume: number | undefined;
    vwap: number | undefined;
    open: number | undefined;
    close: number | undefined;
    last: number | undefined;
    previousClose: number | undefined;
    change: number | undefined;
    percentage: number | undefined;
    average: number | undefined;
    quoteVolume: number | undefined;
    baseVolume: number | undefined;
    indexPrice: number | undefined;
    markPrice: number | undefined;
}

export type Tickers = Dictionary<Ticker>;

/**
 * CCXT-compatible OHLCV tuple.
 * [timestamp, open, high, low, close, volume]
 */
export type OHLCV = [number, number, number, number, number, number];

/**
 * CCXT-compatible OrderBook structure.
 */
export interface OrderBook {
    asks: [number, number][];
    bids: [number, number][];
    datetime: string | undefined;
    timestamp: number | undefined;
    nonce: number | undefined;
    symbol: string | undefined;
}

/**
 * CCXT-compatible Market structure (simplified for feeds).
 */
export interface Market {
    id: string;
    symbol: string;
    base: string;
    quote: string;
    active: boolean;
    type: string;
    spot: boolean;
    margin: boolean;
    swap: boolean;
    future: boolean;
    option: boolean;
    contract: boolean;
    precision: { amount: number | undefined; price: number | undefined };
    limits: {
        amount?: { min: number | undefined; max: number | undefined };
        cost?: { min: number | undefined; max: number | undefined };
        price?: { min: number | undefined; max: number | undefined };
    };
    info: any;
}

/**
 * CCXT-compatible FundingRate structure.
 */
export interface FundingRate {
    symbol: string;
    info: any;
    timestamp?: number;
    datetime?: string;
    fundingRate?: number;
    markPrice?: number;
    indexPrice?: number;
    interestRate?: number;
    fundingTimestamp?: number;
    fundingDatetime?: string;
    nextFundingTimestamp?: number;
    nextFundingDatetime?: string;
    nextFundingRate?: number;
    previousFundingRate?: number;
    interval?: string;
}

export type FundingRates = Dictionary<FundingRate>;

// ----------------------------------------------------------------------------
// pmxt extensions — no CCXT equivalent
// ----------------------------------------------------------------------------

/**
 * ChainLink oracle price round (pmxt-specific).
 */
export interface OracleRound {
    feed: string;
    roundId: string;
    answer: number;
    startedAt: number;
    updatedAt: number;
    answeredInRound: string;
    decimals: number;
    description?: string;
}

export interface OracleParams {
    feed: string;
    roundId?: string;
    limit?: number;
}
