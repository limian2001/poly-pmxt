import { Ticker, OracleRound } from '../types';
import { IFeedNormalizer } from '../interfaces';
import {
    ChainlinkLatestPriceRecord,
    ChainlinkPriceRecord,
    ChainlinkWsEvent,
    TOKEN_BY_SHORT,
    TOKEN_BY_PAIR,
} from './types';

// ----------------------------------------------------------------------------
// Chainlink normalizer — produces CCXT-compatible Ticker and OracleRound.
// ----------------------------------------------------------------------------

function makeTicker(symbol: string, price: number, timestamp: number, info: any): Ticker {
    return {
        symbol,
        info,
        timestamp,
        datetime: new Date(timestamp).toISOString(),
        high: undefined,
        low: undefined,
        bid: undefined,
        bidVolume: undefined,
        ask: undefined,
        askVolume: undefined,
        vwap: undefined,
        open: undefined,
        close: undefined,
        last: price,
        previousClose: undefined,
        change: undefined,
        percentage: undefined,
        average: undefined,
        quoteVolume: undefined,
        baseVolume: undefined,
        indexPrice: undefined,
        markPrice: undefined,
    };
}

export const chainlinkNormalizer: IFeedNormalizer<
    ChainlinkLatestPriceRecord,
    ChainlinkPriceRecord
> = {
    normalizeTicker(raw: ChainlinkLatestPriceRecord): Ticker {
        if (raw.price === null || raw.price === undefined) {
            throw new Error(`Chainlink returned null price for token=${raw.token}`);
        }
        const token = TOKEN_BY_SHORT.get(raw.token.toLowerCase());
        return makeTicker(
            token?.pair ?? `${raw.token.toUpperCase()}/USD`,
            raw.price,
            Date.now(),
            raw,
        );
    },
};

export function normalizeLatestToTicker(
    raw: ChainlinkLatestPriceRecord,
    now: number,
): Ticker {
    if (raw.price === null || raw.price === undefined) {
        throw new Error(`Chainlink returned null price for token=${raw.token}`);
    }
    const token = TOKEN_BY_SHORT.get(raw.token.toLowerCase());
    return makeTicker(
        token?.pair ?? `${raw.token.toUpperCase()}/USD`,
        raw.price,
        now,
        raw,
    );
}

export function normalizePriceRecordToTicker(
    raw: ChainlinkPriceRecord,
): Ticker {
    if (raw.price === null || raw.price === undefined) {
        throw new Error(`Chainlink returned null price for token=${raw.token} at timestamp=${raw.timestamp}`);
    }
    const token = TOKEN_BY_SHORT.get(raw.token.toLowerCase());
    return makeTicker(
        token?.pair ?? `${raw.token.toUpperCase()}/USD`,
        raw.price,
        raw.timestamp * 1000,
        raw,
    );
}

export function normalizePriceRecordToOracleRound(
    raw: ChainlinkPriceRecord,
): OracleRound {
    if (raw.price === null || raw.price === undefined) {
        throw new Error(`Chainlink returned null price for token=${raw.token} at timestamp=${raw.timestamp}`);
    }
    const token = TOKEN_BY_SHORT.get(raw.token.toLowerCase());
    const decimals = token?.decimals ?? 8;
    return {
        feed: token?.pair ?? `${raw.token.toUpperCase()}/USD`,
        roundId: String(raw.timestamp),
        answer: raw.price,
        startedAt: raw.timestamp,
        updatedAt: raw.timestamp,
        answeredInRound: String(raw.timestamp),
        decimals,
        description: token
            ? `${token.base} / ${token.quote} on Polygon`
            : undefined,
    };
}

export function normalizeWsEventToTicker(event: ChainlinkWsEvent): Ticker {
    return makeTicker(
        event.symbol,
        event.price,
        event.updated_at * 1000,
        event,
    );
}

export function normalizeWsEventToOracleRound(event: ChainlinkWsEvent): OracleRound {
    const token = TOKEN_BY_PAIR.get(event.symbol);
    const decimals = token?.decimals ?? 8;
    return {
        feed: event.symbol,
        roundId: String(event.round_id),
        answer: event.price,
        startedAt: event.updated_at,
        updatedAt: event.updated_at,
        answeredInRound: String(event.round_id),
        decimals,
        description: token
            ? `${token.base} / ${token.quote} on Polygon`
            : undefined,
    };
}
