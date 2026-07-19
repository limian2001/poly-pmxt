/**
 * Probes the PolymarketUS adapter for markets that are actually open for
 * trading (closed=false) so a human can eyeball live outcome prices.
 *
 * Uses the SDK client directly to pass the `closed=false` filter because
 * the wrapper's `fetchMarkets` only forwards `active=true` today.
 */
import { PolymarketUSExchange } from '../src/exchanges/polymarket_us';

async function main() {
    const ex = new PolymarketUSExchange();
    // Use the underlying SDK client via a cast to bypass the wrapper's
    // current parameter set; the gateway honours `closed=false`.
    const sdk = (ex as unknown as { client: any }).client;
    const resp = await sdk.markets.list({ active: true, closed: false, limit: 10 });
    const rawMarkets = resp.markets || [];
    console.log(`Got ${rawMarkets.length} open markets.\n`);

    const normalizer = (ex as unknown as { normalizer: any }).normalizer;

    for (const raw of rawMarkets) {
        const m = normalizer.normalizeMarket(raw);
        const long = m.outcomes[0];
        const short = m.outcomes[1];
        console.log(
            `${m.marketId}\n` +
            `  resolves=${m.resolutionDate.toISOString()} tick=${m.tickSize}\n` +
            `  long (${long.metadata?.sideDescription ?? '-'}) = ${long.price}\n` +
            `  short(${short.metadata?.sideDescription ?? '-'}) = ${short.price}\n` +
            `  sum = ${long.price + short.price}`,
        );
    }

    // Try to probe a book on the first open market
    if (rawMarkets.length > 0) {
        const slug = rawMarkets[0].slug;
        console.log(`\nProbing order book for ${slug}`);
        const book = await ex.fetchOrderBook(slug);
        console.log(
            `  bids=${book.bids.length} asks=${book.asks.length} ` +
            `bestBid=${book.bids[0]?.price} bestAsk=${book.asks[0]?.price}`,
        );
        if (book.bids.length > 0 || book.asks.length > 0) {
            console.log('  top 5 bids:', book.bids.slice(0, 5));
            console.log('  top 5 asks:', book.asks.slice(0, 5));
        }
    }

    await ex.close();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
