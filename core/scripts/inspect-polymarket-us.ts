/**
 * Dumps normalized Polymarket US data so a human can eyeball the values.
 * Finds a market with actual orderbook liquidity if possible.
 */
import { PolymarketUSExchange } from '../src/exchanges/polymarket_us';

async function main() {
    const ex = new PolymarketUSExchange();

    console.log('=== Fetching 50 markets ===');
    const markets = await ex.fetchMarkets({ limit: 50 });
    console.log(`Got ${markets.length} markets.\n`);

    // Sort by liquidity descending and take top 5
    const byLiq = [...markets].sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
    console.log('Top 5 by liquidity:');
    for (const m of byLiq.slice(0, 5)) {
        console.log(`  ${m.marketId} -- liquidity=${m.liquidity} volume=${m.volume} -- "${m.title}"`);
    }
    console.log();

    // Dump the raw first market with all fields
    console.log('=== Full dump of markets[0] ===');
    console.log(JSON.stringify(markets[0], null, 2));
    console.log();

    // Try to find a market with a non-empty orderbook
    console.log('=== Probing order books ===');
    let found = false;
    for (const m of byLiq.slice(0, 10)) {
        const book = await ex.fetchOrderBook(m.marketId);
        const bidCount = book.bids.length;
        const askCount = book.asks.length;
        const bestBid = book.bids[0]?.price;
        const bestAsk = book.asks[0]?.price;
        console.log(`  ${m.marketId}: bids=${bidCount} asks=${askCount} bestBid=${bestBid} bestAsk=${bestAsk}`);
        if ((bidCount > 0 || askCount > 0) && !found) {
            found = true;
            console.log(`\n=== Full dump of orderbook for ${m.marketId} ===`);
            console.log(JSON.stringify(book, null, 2));
            console.log();
        }
    }
    if (!found) {
        console.log('\n(No markets in top 10 had any order book activity.)');
    }

    console.log('\n=== Fetching 3 events ===');
    const events = await ex.fetchEvents({ limit: 3 });
    console.log('=== Full dump of events[0] ===');
    console.log(JSON.stringify(events[0], null, 2));

    await ex.close();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
