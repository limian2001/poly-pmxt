/**
 * Smoke test for the Polymarket US adapter.
 *
 * Exercises every public (unauthenticated) code path against the live
 * gateway and asserts the normalizer output looks sane. Also verifies
 * that auth-gated methods throw AuthenticationError without credentials.
 *
 * Run: npx ts-node core/scripts/smoke-polymarket-us.ts
 */

import { PolymarketUSExchange } from '../src/exchanges/polymarket_us';
import { AuthenticationError } from '../src/errors';
import { UnifiedMarket, UnifiedEvent, OrderBook } from '../src/types';

let passed = 0;
let failed = 0;

function ok(name: string, detail?: string): void {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ''}`);
}

function fail(name: string, err: unknown): void {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL  ${name} -- ${msg}`);
}

function section(title: string): void {
    console.log(`\n== ${title} ==`);
}

function assertMarketShape(m: UnifiedMarket): void {
    if (typeof m.marketId !== 'string' || !m.marketId) throw new Error('marketId not a non-empty string');
    if (typeof m.title !== 'string') throw new Error(`title not a string (got ${typeof m.title})`);
    if (!Array.isArray(m.outcomes) || m.outcomes.length !== 2) {
        throw new Error(`outcomes length != 2 (got ${m.outcomes?.length})`);
    }
    const [o1, o2] = m.outcomes;
    if (o1.outcomeId !== `${m.marketId}:long`) throw new Error(`outcomes[0].outcomeId != slug:long (got ${o1.outcomeId})`);
    if (o2.outcomeId !== `${m.marketId}:short`) throw new Error(`outcomes[1].outcomeId != slug:short (got ${o2.outcomeId})`);
    if (typeof o1.price !== 'number' || !Number.isFinite(o1.price)) {
        throw new Error(`outcomes[0].price not a finite number (got ${o1.price})`);
    }
    if (typeof o2.price !== 'number' || !Number.isFinite(o2.price)) {
        throw new Error(`outcomes[1].price not a finite number (got ${o2.price})`);
    }
    if (!(m.resolutionDate instanceof Date)) throw new Error('resolutionDate not a Date');
    if (typeof m.url !== 'string' || !m.url.includes(m.marketId)) throw new Error(`url missing slug (got ${m.url})`);
    if (!Array.isArray(m.tags)) throw new Error('tags not an array');
    if (m.tickSize !== undefined && (typeof m.tickSize !== 'number' || !Number.isFinite(m.tickSize) || m.tickSize <= 0)) {
        throw new Error(`tickSize present but not a positive number (got ${m.tickSize})`);
    }
}

function assertEventShape(e: UnifiedEvent): void {
    if (typeof e.id !== 'string' || !e.id) throw new Error('id not a non-empty string');
    if (typeof e.title !== 'string') throw new Error(`title not a string (got ${typeof e.title})`);
    if (!Array.isArray(e.markets)) throw new Error('markets not an array');
    if (!Array.isArray(e.tags)) throw new Error('tags not an array');
    for (const m of e.markets) assertMarketShape(m);
}

function assertOrderBookShape(b: OrderBook): void {
    if (!Array.isArray(b.bids)) throw new Error('bids not an array');
    if (!Array.isArray(b.asks)) throw new Error('asks not an array');
    for (const lvl of [...b.bids, ...b.asks]) {
        if (typeof lvl.price !== 'number' || !Number.isFinite(lvl.price)) {
            throw new Error(`level.price not a finite number (got ${lvl.price})`);
        }
        if (typeof lvl.size !== 'number' || !Number.isFinite(lvl.size)) {
            throw new Error(`level.size not a finite number (got ${lvl.size})`);
        }
    }
}

async function main() {
    const ex = new PolymarketUSExchange();
    console.log(`Smoke testing ${ex.name} against the live gateway (no credentials)...`);

    let sampleMarket: UnifiedMarket | undefined;
    let sampleEvent: UnifiedEvent | undefined;

    // ------------------------------------------------------------------
    section('fetchMarkets');
    // ------------------------------------------------------------------
    try {
        const markets = await ex.fetchMarkets({ limit: 5 });
        if (markets.length === 0) throw new Error('no markets returned');
        for (const m of markets) assertMarketShape(m);
        sampleMarket = markets[0];
        ok('fetchMarkets() returns normalized markets', `${markets.length} markets, sample title: "${sampleMarket.title}"`);

        // Verify we're actually pulling prices/tickSize off the gateway
        // (the two correctness bugs caught by human eyeball inspection).
        const withPrices = markets.filter(m =>
            (m.outcomes[0]?.price ?? 0) > 0 || (m.outcomes[1]?.price ?? 0) > 0,
        );
        if (withPrices.length === 0) {
            fail('fetchMarkets() outcome prices', new Error('every market reported outcomes[*].price === 0'));
        } else {
            const sample = withPrices[0];
            ok(
                'fetchMarkets() populates outcome prices',
                `${withPrices.length}/${markets.length} markets quoted; sample "${sample.marketId}" long=${sample.outcomes[0].price} short=${sample.outcomes[1].price}`,
            );
        }

        const withTick = markets.filter(m => typeof m.tickSize === 'number');
        if (withTick.length === 0) {
            fail('fetchMarkets() tickSize', new Error('no market surfaced a per-market tickSize'));
        } else {
            ok(
                'fetchMarkets() populates tickSize',
                `${withTick.length}/${markets.length} markets; sample tick=${withTick[0].tickSize}`,
            );
        }
    } catch (e) {
        fail('fetchMarkets()', e);
    }

    if (sampleMarket) {
        try {
            const bySlug = await ex.fetchMarkets({ slug: sampleMarket.marketId });
            if (bySlug.length !== 1) throw new Error(`expected 1 market, got ${bySlug.length}`);
            assertMarketShape(bySlug[0]);
            if (bySlug[0].marketId !== sampleMarket.marketId) {
                throw new Error(`slug mismatch: ${bySlug[0].marketId} vs ${sampleMarket.marketId}`);
            }
            ok('fetchMarkets({ slug }) direct lookup', `title: "${bySlug[0].title}"`);
        } catch (e) {
            fail('fetchMarkets({ slug })', e);
        }

        try {
            const byOutcomeId = await ex.fetchMarkets({ outcomeId: `${sampleMarket.marketId}:short` });
            if (byOutcomeId.length !== 1) throw new Error(`expected 1 market, got ${byOutcomeId.length}`);
            if (byOutcomeId[0].marketId !== sampleMarket.marketId) {
                throw new Error(`slug mismatch after outcomeId strip: ${byOutcomeId[0].marketId}`);
            }
            ok('fetchMarkets({ outcomeId: "slug:short" }) strips suffix');
        } catch (e) {
            fail('fetchMarkets({ outcomeId })', e);
        }
    }

    // ------------------------------------------------------------------
    section('fetchEvents');
    // ------------------------------------------------------------------
    try {
        const events = await ex.fetchEvents({ limit: 3 });
        if (events.length === 0) throw new Error('no events returned');
        for (const e of events) assertEventShape(e);
        sampleEvent = events[0];
        ok('fetchEvents() returns normalized events', `${events.length} events, sample title: "${sampleEvent.title}", ${sampleEvent.markets.length} nested markets`);
    } catch (e) {
        fail('fetchEvents()', e);
    }

    if (sampleEvent) {
        try {
            const bySlug = await ex.fetchEvents({ slug: sampleEvent.id });
            if (bySlug.length !== 1) throw new Error(`expected 1 event, got ${bySlug.length}`);
            assertEventShape(bySlug[0]);
            ok('fetchEvents({ slug }) direct lookup', `${bySlug[0].markets.length} nested markets`);
        } catch (e) {
            fail('fetchEvents({ slug })', e);
        }

        if (sampleEvent.markets.length > 0) {
            try {
                const fromEvent = await ex.fetchMarkets({ eventId: sampleEvent.id });
                if (fromEvent.length === 0) throw new Error('no markets returned');
                for (const m of fromEvent) assertMarketShape(m);
                ok('fetchMarkets({ eventId }) flattens nested markets', `${fromEvent.length} markets`);
            } catch (e) {
                fail('fetchMarkets({ eventId })', e);
            }
        }
    }

    // ------------------------------------------------------------------
    section('fetchOrderBook');
    // ------------------------------------------------------------------
    if (sampleMarket) {
        try {
            const book = await ex.fetchOrderBook(sampleMarket.marketId);
            assertOrderBookShape(book);
            const bestBid = book.bids[0]?.price;
            const bestAsk = book.asks[0]?.price;
            ok('fetchOrderBook(slug)', `bids=${book.bids.length}, asks=${book.asks.length}, best bid=${bestBid}, best ask=${bestAsk}`);
        } catch (e) {
            fail('fetchOrderBook(slug)', e);
        }

        try {
            const book = await ex.fetchOrderBook(`${sampleMarket.marketId}:long`);
            assertOrderBookShape(book);
            ok('fetchOrderBook("slug:long") strips suffix', `bids=${book.bids.length}, asks=${book.asks.length}`);
        } catch (e) {
            fail('fetchOrderBook("slug:long")', e);
        }
    }

    // ------------------------------------------------------------------
    section('auth gates (should all throw AuthenticationError)');
    // ------------------------------------------------------------------
    const authGated: Array<[string, () => Promise<unknown>]> = [
        ['fetchBalance', () => ex.fetchBalance()],
        ['fetchPositions', () => ex.fetchPositions()],
        ['fetchOpenOrders', () => ex.fetchOpenOrders()],
        ['watchOrderBook', () => ex.watchOrderBook('any-slug')],
        ['watchTrades', () => ex.watchTrades('any-slug')],
    ];
    for (const [name, fn] of authGated) {
        try {
            await fn();
            fail(`${name} should have thrown`, new Error('no error thrown'));
        } catch (e) {
            if (e instanceof AuthenticationError) {
                ok(`${name} throws AuthenticationError`);
            } else {
                fail(`${name} threw wrong error type`, e);
            }
        }
    }

    await ex.close();

    // ------------------------------------------------------------------
    console.log(`\n== Summary ==`);
    console.log(`  ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('Smoke test crashed:', e);
    process.exit(1);
});
