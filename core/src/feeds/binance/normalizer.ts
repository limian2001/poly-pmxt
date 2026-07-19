import { Ticker } from '../types';
import { BinanceRelayTradeEvent } from './types';

// ----------------------------------------------------------------------------
// Normalizer — pure functions mapping raw relay events to CCXT Ticker.
// ----------------------------------------------------------------------------

/**
 * Convert a Binance symbol (e.g. "BTCUSDT") to CCXT pair format (e.g. "BTC/USDT").
 */
export function symbolToPair(symbol: string): string {
    const quotes = ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH', 'BNB'];
    for (const quote of quotes) {
        if (symbol.endsWith(quote)) {
            const base = symbol.slice(0, -quote.length);
            if (base.length > 0) {
                return `${base}/${quote}`;
            }
        }
    }
    return symbol;
}

export function normalizeTradeToTicker(event: BinanceRelayTradeEvent): Ticker {
    const pair = symbolToPair(event.symbol);
    const price = parseFloat(event.price);
    const ts = event.trade_time_ms;
    return {
        symbol: pair,
        info: event,
        timestamp: ts,
        datetime: new Date(ts).toISOString(),
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
