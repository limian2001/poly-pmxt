import { MockExchange } from '../../src/exchanges/mock/index';
import { SeededRng } from '../../src/exchanges/mock/seededRng';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round = (n: number, decimals = 3) => parseFloat(n.toFixed(decimals));

/** Compute the deterministic mid price the mock uses for a given outcomeId */
function bookMidPrice(outcomeId: string): number {
    const r = new SeededRng(outcomeId);
    return round(r.float(0.1, 0.9), 3);
}

/** Market / outcome IDs produced by the default seed */
const MARKET_ID = 'mock-m0';
const OUTCOME_YES = `${MARKET_ID}-yes`;
const OUTCOME_NO = `${MARKET_ID}-no`;

// ---------------------------------------------------------------------------
// Fixture factory — always 0-latency
// ---------------------------------------------------------------------------

function makeExchange(
    opts: {
        balance?: number;
        limitOrderMode?: 'immediate' | 'resting';
        marketCount?: number;
    } = {},
) {
    return new MockExchange({
        orderLatencyMs: 0,
        balance: opts.balance ?? 1000,
        limitOrderMode: opts.limitOrderMode ?? 'immediate',
        marketCount: opts.marketCount ?? 5,
    });
}

// ---------------------------------------------------------------------------
// 1. Balance math
// ---------------------------------------------------------------------------

describe('Balance math', () => {
    it('starts with the configured balance, all available, nothing locked', async () => {
        const ex = makeExchange({ balance: 500 });
        const [bal] = await ex.fetchBalance();
        expect(bal!.currency).toBe('USDC');
        expect(bal!.total).toBe(500);
        expect(bal!.available).toBe(500);
        expect(bal!.locked).toBe(0);
    });

    it('total equals available + locked at all times', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const price = bookMidPrice(OUTCOME_YES);
        const amount = 10;

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount,
        });

        const [bal] = await ex.fetchBalance();
        expect(bal!.total).toBeCloseTo(bal!.available + bal!.locked, 5);
    });

    it('buy in immediate mode deducts cost from available', async () => {
        const ex = makeExchange({ balance: 1000 });
        const price = bookMidPrice(OUTCOME_YES);
        const amount = 20;
        const cost = round(price * amount, 2);

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount,
        });

        const [bal] = await ex.fetchBalance();
        expect(bal!.available).toBeCloseTo(1000 - cost, 2);
        expect(bal!.locked).toBe(0);
    });

    it('sell in immediate mode adds cost to available', async () => {
        const ex = makeExchange({ balance: 1000 });
        const price = bookMidPrice(OUTCOME_YES);
        const amount = 10;
        const cost = round(price * amount, 2);

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'sell',
            type: 'limit',
            price,
            amount,
        });

        const [bal] = await ex.fetchBalance();
        expect(bal!.available).toBeCloseTo(1000 + cost, 2);
    });

    it('locked reflects funds reserved by an open resting buy order', async () => {
        const ex = makeExchange({ balance: 1000, limitOrderMode: 'resting' });
        const price = bookMidPrice(OUTCOME_YES);
        const amount = 10;
        const cost = round(price * amount, 2);

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount,
        });

        const [bal] = await ex.fetchBalance();
        expect(bal!.locked).toBeCloseTo(cost, 2);
        expect(bal!.available).toBeCloseTo(1000 - cost, 2);
    });
});

// ---------------------------------------------------------------------------
// 2. Immediate-fill limit order
// ---------------------------------------------------------------------------

describe('Immediate fill mode', () => {
    it('limit order returns status filled immediately', async () => {
        const ex = makeExchange();
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        expect(order.status).toBe('filled');
        expect(order.filled).toBe(5);
        expect(order.remaining).toBe(0);
    });

    it('immediate fill creates a position', async () => {
        const ex = makeExchange();
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        const positions = await ex.fetchPositions();
        expect(positions).toHaveLength(1);
        expect(positions[0]!.outcomeId).toBe(OUTCOME_YES);
        expect(positions[0]!.size).toBeCloseTo(5, 4);
    });

    it('immediate fill appears in fetchMyTrades', async () => {
        const ex = makeExchange();
        const price = bookMidPrice(OUTCOME_YES);
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 5,
        });

        const trades = await ex.fetchMyTrades();
        expect(trades).toHaveLength(1);
        expect(trades[0]!.orderId).toBe(order.id);
        expect(trades[0]!.side).toBe('buy');
        expect(trades[0]!.outcomeId).toBe(OUTCOME_YES);
        expect(trades[0]!.amount).toBe(5);
        expect(trades[0]!.price).toBeCloseTo(price, 3);
    });
});

// ---------------------------------------------------------------------------
// 3. Market order
// ---------------------------------------------------------------------------

describe('Market order', () => {
    it('market order executes at the seeded mid price and returns filled', async () => {
        const ex = makeExchange();
        const expectedPrice = bookMidPrice(OUTCOME_YES);

        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'market',
            amount: 8,
        });

        expect(order.status).toBe('filled');
        expect(order.type).toBe('market');
        expect(order.price).toBeCloseTo(expectedPrice, 3);
    });

    it('market order creates a position', async () => {
        const ex = makeExchange();
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'market',
            amount: 8,
        });

        const positions = await ex.fetchPositions();
        expect(positions).toHaveLength(1);
        expect(positions[0]!.size).toBeCloseTo(8, 4);
    });
});

// ---------------------------------------------------------------------------
// 4. Resting limit order full lifecycle
// ---------------------------------------------------------------------------

describe('Resting limit flow', () => {
    async function placeRestingBuy(ex: MockExchange, amount = 10) {
        const price = bookMidPrice(OUTCOME_YES);
        return ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount,
        });
    }

    it('resting order starts with status open', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await placeRestingBuy(ex);
        expect(order.status).toBe('open');
        expect(order.filled).toBe(0);
        expect(order.remaining).toBe(10);
    });

    it('funds are locked while order is open', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting', balance: 1000 });
        const price = bookMidPrice(OUTCOME_YES);
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 10,
        });

        const [bal] = await ex.fetchBalance();
        expect(bal!.locked).toBeGreaterThan(0);
        expect(bal!.available).toBeLessThan(1000);
    });

    it('fillOrder completes the order and unlocks funds', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting', balance: 1000 });
        const price = bookMidPrice(OUTCOME_YES);
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 10,
        });

        const balBefore = await ex.fetchBalance();
        expect(balBefore[0]!.locked).toBeGreaterThan(0);

        const filled = await ex.fillOrder(order.id);

        expect(filled.status).toBe('filled');
        expect(filled.filled).toBe(10);
        expect(filled.remaining).toBe(0);

        const balAfter = await ex.fetchBalance();
        expect(balAfter[0]!.locked).toBe(0);
    });

    it('fillOrder creates a position', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await placeRestingBuy(ex);
        const positionsBefore = await ex.fetchPositions();
        expect(positionsBefore).toHaveLength(0);

        await ex.fillOrder(order.id);

        const positionsAfter = await ex.fetchPositions();
        expect(positionsAfter).toHaveLength(1);
        expect(positionsAfter[0]!.outcomeId).toBe(OUTCOME_YES);
        expect(positionsAfter[0]!.size).toBeCloseTo(10, 4);
    });
});

// ---------------------------------------------------------------------------
// 5. Partial fill
// ---------------------------------------------------------------------------

describe('Partial fill', () => {
    it('partial fill leaves order open with correct filled / remaining counts', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        const partial = await ex.fillOrder(order.id, 3);

        expect(partial.status).toBe('open');
        expect(partial.filled).toBeCloseTo(3, 4);
        expect(partial.remaining).toBeCloseTo(7, 4);
    });

    it('second fill that exhausts remainder transitions to filled', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        await ex.fillOrder(order.id, 3);
        const done = await ex.fillOrder(order.id, 7);

        expect(done.status).toBe('filled');
        expect(done.filled).toBeCloseTo(10, 4);
        expect(done.remaining).toBe(0);
    });

    it('each partial fill generates its own trade entry', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        await ex.fillOrder(order.id, 3);
        await ex.fillOrder(order.id, 7);

        const trades = await ex.fetchMyTrades();
        expect(trades).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// 6. Cancel open resting order
// ---------------------------------------------------------------------------

describe('Cancel', () => {
    it('cancelling an open resting order sets status to canceled', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        const canceled = await ex.cancelOrder(order.id);
        expect(canceled.status).toBe('canceled');
    });

    it('cancelling returns locked funds to available', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting', balance: 1000 });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        const balLocked = await ex.fetchBalance();
        expect(balLocked[0]!.locked).toBeGreaterThan(0);

        await ex.cancelOrder(order.id);

        const balFree = await ex.fetchBalance();
        expect(balFree[0]!.locked).toBe(0);
        expect(balFree[0]!.available).toBeCloseTo(1000, 2);
    });

    it('open order appears in fetchOpenOrders, absent after cancel', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        const openBefore = await ex.fetchOpenOrders();
        expect(openBefore.some(o => o.id === order.id)).toBe(true);

        await ex.cancelOrder(order.id);

        const openAfter = await ex.fetchOpenOrders();
        expect(openAfter.some(o => o.id === order.id)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 7. Cancel a filled order throws
// ---------------------------------------------------------------------------

describe('Cancel filled throws', () => {
    it('cancelling a filled order throws with a descriptive message', async () => {
        const ex = makeExchange();
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });
        expect(order.status).toBe('filled');

        await expect(ex.cancelOrder(order.id)).rejects.toThrow(/cancel/i);
    });

    it('cancelling a non-existent order throws', async () => {
        const ex = makeExchange();
        await expect(ex.cancelOrder('does-not-exist')).rejects.toThrow(/not found/i);
    });
});

// ---------------------------------------------------------------------------
// 8. Position tracking
// ---------------------------------------------------------------------------

describe('Position tracking', () => {
    it('multiple buys accumulate size and entry price stays consistent', async () => {
        const ex = makeExchange();
        const price = bookMidPrice(OUTCOME_YES);

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 10,
        });
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 10,
        });

        const positions = await ex.fetchPositions();
        expect(positions).toHaveLength(1);
        expect(positions[0]!.size).toBeCloseTo(20, 4);
        // Both fills at same price -> weighted avg entry price equals that price
        expect(positions[0]!.entryPrice).toBeCloseTo(price, 3);
    });

    it('weighted average entry price is correct for mixed prices', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const priceA = 0.4;
        const priceB = 0.6;

        const orderA = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: priceA,
            amount: 10,
        });
        const orderB = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: priceB,
            amount: 10,
        });

        await ex.fillOrder(orderA.id);
        await ex.fillOrder(orderB.id);

        const positions = await ex.fetchPositions();
        expect(positions[0]!.size).toBeCloseTo(20, 4);
        // Weighted avg of 10@0.4 + 10@0.6 = 0.5
        expect(positions[0]!.entryPrice).toBeCloseTo(0.5, 4);
    });

    it('selling reduces position size', async () => {
        const ex = makeExchange();
        const price = bookMidPrice(OUTCOME_YES);

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 10,
        });
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'sell',
            type: 'limit',
            price,
            amount: 4,
        });

        const positions = await ex.fetchPositions();
        expect(positions).toHaveLength(1);
        expect(positions[0]!.size).toBeCloseTo(6, 4);
    });

    it('selling the entire position removes it', async () => {
        const ex = makeExchange();
        const price = bookMidPrice(OUTCOME_YES);

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 10,
        });
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'sell',
            type: 'limit',
            price,
            amount: 10,
        });

        const positions = await ex.fetchPositions();
        expect(positions).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 9. fetchMyTrades
// ---------------------------------------------------------------------------

describe('fetchMyTrades', () => {
    it('each fill creates a UserTrade with correct fields', async () => {
        const ex = makeExchange();
        const price = bookMidPrice(OUTCOME_YES);

        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price,
            amount: 7,
        });

        const trades = await ex.fetchMyTrades();
        expect(trades).toHaveLength(1);
        const trade = trades[0]!;
        expect(trade.orderId).toBe(order.id);
        expect(trade.side).toBe('buy');
        expect(trade.outcomeId).toBe(OUTCOME_YES);
        expect(trade.amount).toBe(7);
        expect(trade.price).toBeCloseTo(price, 3);
        expect(typeof trade.id).toBe('string');
        expect(trade.timestamp).toBeGreaterThan(0);
    });

    it('can filter trades by outcomeId', async () => {
        const ex = makeExchange();

        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_NO,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_NO),
            amount: 5,
        });

        const yesTrades = await ex.fetchMyTrades({ outcomeId: OUTCOME_YES });
        expect(yesTrades).toHaveLength(1);
        expect(yesTrades[0]!.outcomeId).toBe(OUTCOME_YES);
    });

    it('trades are returned newest-first', async () => {
        const ex = makeExchange();
        const price = bookMidPrice(OUTCOME_YES);

        await ex.createOrder({ marketId: MARKET_ID, outcomeId: OUTCOME_YES, side: 'buy', type: 'limit', price, amount: 1 });
        await ex.createOrder({ marketId: MARKET_ID, outcomeId: OUTCOME_YES, side: 'buy', type: 'limit', price, amount: 1 });
        await ex.createOrder({ marketId: MARKET_ID, outcomeId: OUTCOME_YES, side: 'buy', type: 'limit', price, amount: 1 });

        const trades = await ex.fetchMyTrades();
        expect(trades).toHaveLength(3);
        for (let i = 0; i < trades.length - 1; i++) {
            expect(trades[i]!.timestamp).toBeGreaterThanOrEqual(trades[i + 1]!.timestamp);
        }
    });
});

// ---------------------------------------------------------------------------
// 10. reset()
// ---------------------------------------------------------------------------

describe('reset()', () => {
    it('restores balance to initial value', async () => {
        const ex = makeExchange({ balance: 750 });
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 10,
        });

        ex.reset();

        const [bal] = await ex.fetchBalance();
        expect(bal!.total).toBeCloseTo(750, 2);
        expect(bal!.available).toBeCloseTo(750, 2);
        expect(bal!.locked).toBe(0);
    });

    it('clears all orders', async () => {
        const ex = makeExchange();
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        ex.reset();

        const allOrders = await ex.fetchAllOrders();
        expect(allOrders).toHaveLength(0);
    });

    it('clears all positions', async () => {
        const ex = makeExchange();
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        ex.reset();

        const positions = await ex.fetchPositions();
        expect(positions).toHaveLength(0);
    });

    it('clears all trades', async () => {
        const ex = makeExchange();
        await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        ex.reset();

        const trades = await ex.fetchMyTrades();
        expect(trades).toHaveLength(0);
    });

    it('order sequence restarts so post-reset IDs match fresh-instance IDs', async () => {
        const ex = makeExchange();
        const order1 = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 1,
        });

        ex.reset();

        const order2 = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 1,
        });

        // Same sequence slot -> same deterministic ID
        expect(order1.id).toBe(order2.id);
    });
});

// ---------------------------------------------------------------------------
// 11. Deterministic markets
// ---------------------------------------------------------------------------

describe('Deterministic markets', () => {
    it('two instances with the same marketCount produce identical market IDs', async () => {
        const ex1 = makeExchange({ marketCount: 10 });
        const ex2 = makeExchange({ marketCount: 10 });

        const markets1 = await ex1.fetchMarkets();
        const markets2 = await ex2.fetchMarkets();

        expect(markets1.map(m => m.marketId)).toEqual(markets2.map(m => m.marketId));
    });

    it('two instances with the same marketCount produce identical titles', async () => {
        const ex1 = makeExchange({ marketCount: 10 });
        const ex2 = makeExchange({ marketCount: 10 });

        const markets1 = await ex1.fetchMarkets();
        const markets2 = await ex2.fetchMarkets();

        expect(markets1.map(m => m.title)).toEqual(markets2.map(m => m.title));
    });

    it('two instances with the same marketCount produce identical outcome prices', async () => {
        const ex1 = makeExchange({ marketCount: 10 });
        const ex2 = makeExchange({ marketCount: 10 });

        const markets1 = await ex1.fetchMarkets();
        const markets2 = await ex2.fetchMarkets();

        const prices1 = markets1.flatMap(m => m.outcomes.map(o => o.price));
        const prices2 = markets2.flatMap(m => m.outcomes.map(o => o.price));

        expect(prices1).toEqual(prices2);
    });

    it('instances with different marketCounts produce different-sized market sets', async () => {
        const ex1 = makeExchange({ marketCount: 5 });
        const ex2 = makeExchange({ marketCount: 8 });

        const markets1 = await ex1.fetchMarkets();
        const markets2 = await ex2.fetchMarkets();

        expect(markets1.length).not.toBe(markets2.length);
    });
});

// ---------------------------------------------------------------------------
// 12. Insufficient balance
// ---------------------------------------------------------------------------

describe('Insufficient balance', () => {
    it('resting buy that exceeds available balance throws', async () => {
        const ex = makeExchange({ balance: 1, limitOrderMode: 'resting' });

        await expect(
            ex.createOrder({
                marketId: MARKET_ID,
                outcomeId: OUTCOME_YES,
                side: 'buy',
                type: 'limit',
                price: 0.5,
                amount: 1000,
            }),
        ).rejects.toThrow(/insufficient/i);
    });

    it('balance is unchanged after a failed resting buy', async () => {
        const ex = makeExchange({ balance: 1, limitOrderMode: 'resting' });

        await expect(ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: 0.5,
            amount: 1000,
        })).rejects.toThrow(/insufficient/i);

        const [bal] = await ex.fetchBalance();
        expect(bal!.available).toBeCloseTo(1, 5);
        expect(bal!.locked).toBe(0);
    });

    it('no order is created after a failed resting buy', async () => {
        const ex = makeExchange({ balance: 1, limitOrderMode: 'resting' });

        await expect(ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: 0.5,
            amount: 1000,
        })).rejects.toThrow(/insufficient/i);

        const orders = await ex.fetchAllOrders();
        expect(orders).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 13. Order query methods
// ---------------------------------------------------------------------------

describe('Order query methods', () => {
    it('fetchOrder retrieves the exact order by ID', async () => {
        const ex = makeExchange();
        const created = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        const fetched = await ex.fetchOrder(created.id);
        expect(fetched.id).toBe(created.id);
        expect(fetched.status).toBe('filled');
    });

    it('fetchOrder throws for an unknown ID', async () => {
        const ex = makeExchange();
        await expect(ex.fetchOrder('ghost-order')).rejects.toThrow(/not found/i);
    });

    it('fetchOpenOrders returns only open orders', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting', balance: 1000 });

        const orderA = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });
        const orderB = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        await ex.fillOrder(orderA.id);

        const open = await ex.fetchOpenOrders();
        expect(open.some(o => o.id === orderA.id)).toBe(false);
        expect(open.some(o => o.id === orderB.id)).toBe(true);
    });

    it('fetchClosedOrders returns filled and canceled orders', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting', balance: 1000 });

        const orderA = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });
        const orderB = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        await ex.fillOrder(orderA.id);
        await ex.cancelOrder(orderB.id);

        const closed = await ex.fetchClosedOrders();
        const closedIds = closed.map(o => o.id);
        expect(closedIds).toContain(orderA.id);
        expect(closedIds).toContain(orderB.id);
    });

    it('fetchAllOrders returns every order regardless of status', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting', balance: 1000 });

        const o1 = await ex.createOrder({ marketId: MARKET_ID, outcomeId: OUTCOME_YES, side: 'buy', type: 'limit', price: bookMidPrice(OUTCOME_YES), amount: 5 });
        const o2 = await ex.createOrder({ marketId: MARKET_ID, outcomeId: OUTCOME_YES, side: 'buy', type: 'limit', price: bookMidPrice(OUTCOME_YES), amount: 5 });
        const o3 = await ex.createOrder({ marketId: MARKET_ID, outcomeId: OUTCOME_YES, side: 'buy', type: 'limit', price: bookMidPrice(OUTCOME_YES), amount: 5 });

        await ex.fillOrder(o1.id);
        await ex.cancelOrder(o2.id);
        // o3 remains open

        const all = await ex.fetchAllOrders();
        expect(all).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// 14. fillOrder edge cases
// ---------------------------------------------------------------------------

describe('fillOrder edge cases', () => {
    it('throws when order does not exist', async () => {
        const ex = makeExchange();
        await expect(ex.fillOrder('no-such-order')).rejects.toThrow(/not found/i);
    });

    it('throws when trying to fill an already-filled order', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        await ex.fillOrder(order.id);
        await expect(ex.fillOrder(order.id)).rejects.toThrow(/filled|not.*open/i);
    });

    it('fillOrder with zero amount returns current order state unchanged', async () => {
        const ex = makeExchange({ limitOrderMode: 'resting' });
        const order = await ex.createOrder({
            marketId: MARKET_ID,
            outcomeId: OUTCOME_YES,
            side: 'buy',
            type: 'limit',
            price: bookMidPrice(OUTCOME_YES),
            amount: 5,
        });

        const result = await ex.fillOrder(order.id, 0);
        expect(result.status).toBe('open');
        expect(result.filled).toBe(0);
    });
});
