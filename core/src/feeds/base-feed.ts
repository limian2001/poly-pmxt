import { IDataFeed } from './interfaces';
import { Ticker, Tickers, OHLCV, OrderBook, Market, Dictionary } from './types';

// ----------------------------------------------------------------------------
// Base class for data feeds — CCXT-compatible method names.
// Provides rate limiting, ticker caching, and throttling.
// ----------------------------------------------------------------------------

export interface DataFeedOptions {
    rateLimit?: number;
    enableCache?: boolean;
    cacheTtlMs?: number;
}

interface CacheEntry {
    readonly ticker: Ticker;
    readonly expiresAt: number;
}

export abstract class BaseDataFeed implements IDataFeed {
    abstract readonly name: string;
    abstract readonly description: string;

    protected readonly options: Required<DataFeedOptions>;
    private readonly cache: Map<string, CacheEntry> = new Map();
    private lastRequestTime = 0;

    constructor(options: DataFeedOptions = {}) {
        this.options = {
            rateLimit: options.rateLimit ?? 10,
            enableCache: options.enableCache ?? true,
            cacheTtlMs: options.cacheTtlMs ?? 1000,
        };
    }

    // -- Public API (CCXT-compatible names) --

    async fetchTicker(symbol: string): Promise<Ticker> {
        const cached = this.getCached(symbol);
        if (cached) return cached;

        await this.throttle();
        const ticker = await this.fetchTickerImpl(symbol);
        this.setCache(symbol, ticker);
        return ticker;
    }

    async fetchTickers(symbols?: string[]): Promise<Tickers> {
        await this.throttle();
        return this.fetchTickersImpl(symbols);
    }

    watchTicker(symbol: string, callback: (ticker: Ticker) => void): () => void {
        return this.watchTickerImpl(symbol, (ticker) => {
            this.setCache(symbol, ticker);
            callback(ticker);
        });
    }

    async fetchOHLCV(symbol: string, timeframe?: string, since?: number, limit?: number): Promise<OHLCV[]> {
        await this.throttle();
        return this.fetchOHLCVImpl(symbol, timeframe, since, limit);
    }

    async fetchOrderBook(symbol: string, limit?: number): Promise<OrderBook> {
        await this.throttle();
        return this.fetchOrderBookImpl(symbol, limit);
    }

    abstract loadMarkets(reload?: boolean): Promise<Dictionary<Market>>;

    // -- Abstract implementations (subclasses fill these in) --

    protected abstract fetchTickerImpl(symbol: string): Promise<Ticker>;
    protected abstract fetchTickersImpl(symbols?: string[]): Promise<Tickers>;
    protected abstract watchTickerImpl(symbol: string, callback: (ticker: Ticker) => void): () => void;
    protected abstract fetchOHLCVImpl(symbol: string, timeframe?: string, since?: number, limit?: number): Promise<OHLCV[]>;
    protected abstract fetchOrderBookImpl(symbol: string, limit?: number): Promise<OrderBook>;

    // -- Lifecycle --

    async connect(): Promise<void> {}
    async close(): Promise<void> {}

    // -- Internal --

    private getCached(symbol: string): Ticker | null {
        if (!this.options.enableCache) return null;
        const entry = this.cache.get(symbol);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(symbol);
            return null;
        }
        return entry.ticker;
    }

    private setCache(symbol: string, ticker: Ticker): void {
        if (!this.options.enableCache) return;
        this.cache.set(symbol, {
            ticker,
            expiresAt: Date.now() + this.options.cacheTtlMs,
        });
    }

    private async throttle(): Promise<void> {
        const minInterval = 1000 / this.options.rateLimit;
        const elapsed = Date.now() - this.lastRequestTime;
        if (elapsed < minInterval) {
            await new Promise((resolve) => setTimeout(resolve, minInterval - elapsed));
        }
        this.lastRequestTime = Date.now();
    }
}
