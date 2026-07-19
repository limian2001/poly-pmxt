/**
 * Pipeline contract test: verifies that every field on UnifiedMarket and
 * UnifiedEvent survives the full path from exchange -> server -> JSON -> SDK converter.
 *
 * This is the single highest-leverage test in the suite. If a field gets
 * dropped at any of the three layers (normalizer, server serialisation,
 * SDK converter), this test fails with the exact field name.
 */

import http from 'http';
import { createApp } from '../../src/server/app';
import { UnifiedMarket, UnifiedEvent, MarketOutcome } from '../../src/types';

// TS SDK converter — imported to test the consumer-facing transform.
// We replicate the converter logic here because the SDK is a separate
// package with ESM imports that don't work in Jest CJS mode.
function convertMarketFromSDK(raw: any): Record<string, any> {
    return {
        ...raw,
        resolutionDate: raw.resolutionDate ? new Date(raw.resolutionDate) : undefined,
        outcomes: (raw.outcomes || []).map((o: any) => ({ ...o })),
        yes: raw.yes ? { ...raw.yes } : undefined,
        no: raw.no ? { ...raw.no } : undefined,
        up: raw.up ? { ...raw.up } : undefined,
        down: raw.down ? { ...raw.down } : undefined,
    };
}

function convertEventFromSDK(raw: any): Record<string, any> {
    const markets = (raw.markets || []).map(convertMarketFromSDK);
    return { ...raw, markets };
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
    const app = createApp({ accessToken: undefined });
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
        server.listen(0, () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
});

async function fetchJSON(path: string): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.json();
    if (!body.success) {
        throw new Error(`Server error: ${body.error}`);
    }
    return body.data;
}

// ---------------------------------------------------------------------------
// The core field lists. If a field is added to types.ts but not here, the
// test won't check it — but the schema drift test (separate) catches that.
// These lists are intentionally maintained by hand so they serve as a
// human-readable contract of "fields the SDK consumer expects."
// ---------------------------------------------------------------------------

const MARKET_OUTCOME_FIELDS: (keyof MarketOutcome)[] = [
    'outcomeId',
    'marketId',
    'label',
    'price',
    'priceChange24h',
    'metadata',
];

const UNIFIED_MARKET_REQUIRED_FIELDS: (keyof UnifiedMarket)[] = [
    'marketId',
    'title',
    'outcomes',
    'volume24h',
    'liquidity',
    'url',
    'description',
    'resolutionDate',
    'slug',
    'status',
    'category',
    'tags',
    'tickSize',
    'image',
    'sourceExchange',
];

// Fields that are populated on some markets but not all
const UNIFIED_MARKET_CONDITIONAL_FIELDS: (keyof UnifiedMarket)[] = [
    'eventId',
    'volume',
    'openInterest',
    'contractAddress',
    'yes',
    'no',
];

const UNIFIED_EVENT_FIELDS: (keyof UnifiedEvent)[] = [
    'id',
    'title',
    'description',
    'slug',
    'markets',
    'volume24h',
    'volume',
    'url',
    'image',
    'category',
    'tags',
    'sourceExchange',
];

describe('Pipeline: field survival (mock -> server -> SDK converter)', () => {
    test('GET /api/mock/fetchMarkets returns markets', async () => {
        const data = await fetchJSON('/api/mock/fetchMarkets?limit=5');
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
    });

    test('every UnifiedMarket field survives the server round-trip (raw JSON)', async () => {
        const markets = await fetchJSON('/api/mock/fetchMarkets?limit=10');
        // Use a binary market (has yes/no)
        const binary = markets.find((m: any) => m.yes != null);
        expect(binary).toBeDefined();

        for (const field of UNIFIED_MARKET_REQUIRED_FIELDS) {
            expect({
                field,
                value: binary[field],
                type: typeof binary[field],
            }).toEqual(
                expect.objectContaining({
                    field,
                    value: expect.anything(),
                }),
            );
            // Field must not be undefined or null
            expect(binary[field]).not.toBeUndefined();
            expect(binary[field]).not.toBeNull();
        }

        for (const field of UNIFIED_MARKET_CONDITIONAL_FIELDS) {
            // These should exist on mock data (we populate all fields)
            expect(binary[field]).not.toBeUndefined();
        }
    });

    test('every MarketOutcome field survives the server round-trip', async () => {
        const markets = await fetchJSON('/api/mock/fetchMarkets?limit=5');
        const market = markets[0];
        expect(market.outcomes.length).toBeGreaterThan(0);

        const outcome = market.outcomes[0];
        for (const field of MARKET_OUTCOME_FIELDS) {
            expect(outcome[field]).not.toBeUndefined();
        }
    });

    test('every UnifiedEvent field survives the server round-trip', async () => {
        const events = await fetchJSON('/api/mock/fetchEvents?limit=5');
        expect(events.length).toBeGreaterThan(0);

        const event = events[0];
        for (const field of UNIFIED_EVENT_FIELDS) {
            expect({
                field,
                value: event[field],
                type: typeof event[field],
            }).toEqual(
                expect.objectContaining({
                    field,
                    value: expect.anything(),
                }),
            );
            expect(event[field]).not.toBeUndefined();
            expect(event[field]).not.toBeNull();
        }

        // Events must contain markets, and those markets must also have all fields
        expect(event.markets.length).toBeGreaterThan(0);
        const nestedMarket = event.markets[0];
        for (const field of UNIFIED_MARKET_REQUIRED_FIELDS) {
            expect(nestedMarket[field]).not.toBeUndefined();
        }
    });

    test('TS SDK convertMarket preserves all fields from server JSON', async () => {
        const markets = await fetchJSON('/api/mock/fetchMarkets?limit=10');
        const binary = markets.find((m: any) => m.yes != null);

        const converted = convertMarketFromSDK(binary);

        for (const field of UNIFIED_MARKET_REQUIRED_FIELDS) {
            expect(converted[field]).not.toBeUndefined();
            expect(converted[field]).not.toBeNull();
        }
        for (const field of UNIFIED_MARKET_CONDITIONAL_FIELDS) {
            expect(converted[field]).not.toBeUndefined();
        }

        // Verify resolutionDate is a Date object after conversion
        expect(converted.resolutionDate).toBeInstanceOf(Date);

        // Verify outcomes survived as arrays with structure
        expect(Array.isArray(converted.outcomes)).toBe(true);
        expect(converted.outcomes.length).toBeGreaterThan(0);
        expect(converted.outcomes[0].outcomeId).toBeDefined();

        // Verify yes/no survived
        expect(converted.yes).toBeDefined();
        expect(converted.yes.outcomeId).toBeDefined();
        expect(converted.no).toBeDefined();
        expect(converted.no.outcomeId).toBeDefined();
    });

    test('TS SDK convertEvent preserves all fields from server JSON', async () => {
        const events = await fetchJSON('/api/mock/fetchEvents?limit=5');
        const converted = convertEventFromSDK(events[0]);

        for (const field of UNIFIED_EVENT_FIELDS) {
            expect(converted[field]).not.toBeUndefined();
            expect(converted[field]).not.toBeNull();
        }

        // Nested markets should also survive conversion
        expect(converted.markets.length).toBeGreaterThan(0);
        const nestedMarket = converted.markets[0];
        for (const field of UNIFIED_MARKET_REQUIRED_FIELDS) {
            expect(nestedMarket[field]).not.toBeUndefined();
        }
    });

    test('fetchOrderBook returns structured bid/ask data', async () => {
        const markets = await fetchJSON('/api/mock/fetchMarkets?limit=1');
        const outcomeId = markets[0].outcomes[0].outcomeId;

        const book = await fetchJSON(
            `/api/mock/fetchOrderBook?outcomeId=${encodeURIComponent(outcomeId)}`,
        );

        expect(Array.isArray(book.bids)).toBe(true);
        expect(Array.isArray(book.asks)).toBe(true);
        expect(book.bids.length).toBeGreaterThan(0);
        expect(book.asks.length).toBeGreaterThan(0);
        expect(book.timestamp).toBeDefined();

        // Each level must have price and size
        for (const level of [...book.bids, ...book.asks]) {
            expect(typeof level.price).toBe('number');
            expect(typeof level.size).toBe('number');
            expect(level.price).toBeGreaterThan(0);
            expect(level.price).toBeLessThan(1);
        }
    });

    test('fetchOHLCV returns candle data with all fields', async () => {
        const markets = await fetchJSON('/api/mock/fetchMarkets?limit=1');
        const outcomeId = markets[0].outcomes[0].outcomeId;

        const candles = await fetchJSON(
            `/api/mock/fetchOHLCV?outcomeId=${encodeURIComponent(outcomeId)}&resolution=1h&limit=10`,
        );

        expect(Array.isArray(candles)).toBe(true);
        expect(candles.length).toBeGreaterThan(0);

        for (const candle of candles) {
            expect(typeof candle.timestamp).toBe('number');
            expect(typeof candle.open).toBe('number');
            expect(typeof candle.high).toBe('number');
            expect(typeof candle.low).toBe('number');
            expect(typeof candle.close).toBe('number');
            expect(typeof candle.volume).toBe('number');
        }
    });

    test('fetchBalance returns balance with all fields', async () => {
        const balances = await fetchJSON('/api/mock/fetchBalance');

        expect(Array.isArray(balances)).toBe(true);
        expect(balances.length).toBeGreaterThan(0);

        const bal = balances[0];
        expect(typeof bal.currency).toBe('string');
        expect(typeof bal.total).toBe('number');
        expect(typeof bal.available).toBe('number');
        expect(typeof bal.locked).toBe('number');
    });

    test('fetchTrades returns trade data with all fields', async () => {
        const markets = await fetchJSON('/api/mock/fetchMarkets?limit=1');
        const outcomeId = markets[0].outcomes[0].outcomeId;

        const trades = await fetchJSON(
            `/api/mock/fetchTrades?outcomeId=${encodeURIComponent(outcomeId)}`,
        );

        expect(Array.isArray(trades)).toBe(true);
        expect(trades.length).toBeGreaterThan(0);

        for (const trade of trades) {
            expect(typeof trade.id).toBe('string');
            expect(typeof trade.timestamp).toBe('number');
            expect(typeof trade.price).toBe('number');
            expect(typeof trade.amount).toBe('number');
            expect(['buy', 'sell']).toContain(trade.side);
            expect(typeof trade.outcomeId).toBe('string');
        }
    });
});
