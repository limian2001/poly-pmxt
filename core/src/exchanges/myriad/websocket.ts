import { OrderBook, Trade } from '../../types';
import { logger } from '../../utils/logger';

// Myriad API v2 does not expose a WebSocket endpoint.
// We implement a poll-based fallback that resolves promises
// on each polling interval, matching the CCXT Pro async pattern.

const DEFAULT_POLL_INTERVAL = 5000; // 5 seconds
const MAX_CONSECUTIVE_FAILURES = 5;

export type FetchOrderBookFn = (id: string) => Promise<OrderBook>;

export class MyriadWebSocket {
    private callApi: (operationId: string, params?: Record<string, any>) => Promise<any>;
    private fetchOrderBook: FetchOrderBookFn;
    private pollInterval: number;
    private orderBookTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
    private tradeTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
    private orderBookResolvers: Map<string, ((value: OrderBook) => void)[]> = new Map();
    private orderBookRejecters: Map<string, ((reason: unknown) => void)[]> = new Map();
    private tradeResolvers: Map<string, ((value: Trade[]) => void)[]> = new Map();
    private tradeRejecters: Map<string, ((reason: unknown) => void)[]> = new Map();
    private lastTradeTimestamp: Map<string, number> = new Map();
    private orderBookFailureCount: Map<string, number> = new Map();
    private tradeFailureCount: Map<string, number> = new Map();
    private closed = false;

    constructor(
        callApi: (operationId: string, params?: Record<string, any>) => Promise<any>,
        fetchOrderBook: FetchOrderBookFn,
        pollInterval?: number,
    ) {
        this.callApi = callApi;
        this.fetchOrderBook = fetchOrderBook;
        this.pollInterval = pollInterval || DEFAULT_POLL_INTERVAL;
    }

    async watchOrderBook(outcomeId: string): Promise<OrderBook> {
        if (this.closed) throw new Error('WebSocket connection is closed');

        return new Promise<OrderBook>((resolve, reject) => {
            if (!this.orderBookResolvers.has(outcomeId)) {
                this.orderBookResolvers.set(outcomeId, []);
                this.orderBookRejecters.set(outcomeId, []);
            }
            const resolvers = this.orderBookResolvers.get(outcomeId);
            const rejecters = this.orderBookRejecters.get(outcomeId);
            if (!resolvers || !rejecters) {
                reject(new Error(`Failed to initialize orderBook resolvers for outcomeId=${outcomeId}`));
                return;
            }
            resolvers.push(resolve);
            rejecters.push(reject);

            if (!this.orderBookTimers.has(outcomeId)) {
                this.startOrderBookPolling(outcomeId);
            }
        });
    }

    async watchTrades(outcomeId: string): Promise<Trade[]> {
        if (this.closed) throw new Error('WebSocket connection is closed');

        return new Promise<Trade[]>((resolve, reject) => {
            if (!this.tradeResolvers.has(outcomeId)) {
                this.tradeResolvers.set(outcomeId, []);
                this.tradeRejecters.set(outcomeId, []);
            }
            const resolvers = this.tradeResolvers.get(outcomeId);
            const rejecters = this.tradeRejecters.get(outcomeId);
            if (!resolvers || !rejecters) {
                reject(new Error(`Failed to initialize trade resolvers for outcomeId=${outcomeId}`));
                return;
            }
            resolvers.push(resolve);
            rejecters.push(reject);

            if (!this.tradeTimers.has(outcomeId)) {
                this.startTradePolling(outcomeId);
            }
        });
    }

    async close(): Promise<void> {
        this.closed = true;

        for (const timer of this.orderBookTimers.values()) {
            clearInterval(timer);
        }
        for (const timer of this.tradeTimers.values()) {
            clearInterval(timer);
        }

        this.orderBookTimers.clear();
        this.tradeTimers.clear();
        this.orderBookResolvers.clear();
        this.orderBookRejecters.clear();
        this.tradeResolvers.clear();
        this.tradeRejecters.clear();
    }

    private startOrderBookPolling(id: string): void {
        const poll = async () => {
            try {
                const book = await this.fetchOrderBook(id);
                this.orderBookFailureCount.set(id, 0);
                const resolvers = this.orderBookResolvers.get(id) || [];
                this.orderBookResolvers.set(id, []);
                this.orderBookRejecters.set(id, []);
                for (const resolve of resolvers) {
                    resolve(book);
                }
            } catch (error: unknown) {
                const failures = (this.orderBookFailureCount.get(id) || 0) + 1;
                this.orderBookFailureCount.set(id, failures);
                logger.warn(`Myriad watchOrderBook poll failed for outcomeId=${id} (consecutive failures: ${failures})`, { error: String(error) });

                if (failures >= MAX_CONSECUTIVE_FAILURES) {
                    const timer = this.orderBookTimers.get(id);
                    if (timer) clearInterval(timer);
                    this.orderBookTimers.delete(id);
                    this.orderBookFailureCount.delete(id);

                    const rejecters = this.orderBookRejecters.get(id) || [];
                    this.orderBookResolvers.set(id, []);
                    this.orderBookRejecters.set(id, []);
                    for (const reject of rejecters) {
                        reject(error);
                    }
                }
            }
        };

        // Immediate first poll
        poll();

        const timer = setInterval(poll, this.pollInterval);
        this.orderBookTimers.set(id, timer);
    }

    private startTradePolling(id: string): void {
        const poll = async () => {
            try {
                const parts = id.split(':');
                const [networkId, marketId] = parts;
                const outcomeId = parts.length >= 3 ? parts[2] : undefined;

                const since = this.lastTradeTimestamp.get(id);
                const queryParams: Record<string, any> = {
                    id: marketId,
                    network_id: Number(networkId),
                    page: 1,
                    limit: 50,
                };
                if (since) queryParams.since = Math.floor(since / 1000);

                const data = await this.callApi('getMarketsEvents', queryParams);
                const events = data.data || data.events || [];

                const tradeEvents = events.filter((e: any) => e.action === 'buy' || e.action === 'sell');
                const filtered = outcomeId
                    ? tradeEvents.filter((e: any) => String(e.outcomeId) === outcomeId)
                    : tradeEvents;

                const trades: Trade[] = filtered.map((t: any, index: number) => ({
                    id: `${t.blockNumber || t.timestamp}-${index}`,
                    timestamp: (t.timestamp || 0) * 1000,
                    price: t.shares > 0 ? Number(t.value) / Number(t.shares) : 0,
                    amount: Number(t.shares || 0),
                    side: t.action === 'buy' ? 'buy' as const : 'sell' as const,
                }));

                if (trades.length > 0) {
                    const maxTs = Math.max(...trades.map(t => t.timestamp));
                    this.lastTradeTimestamp.set(id, maxTs + 1);
                }

                this.tradeFailureCount.set(id, 0);
                const resolvers = this.tradeResolvers.get(id) || [];
                this.tradeResolvers.set(id, []);
                this.tradeRejecters.set(id, []);
                for (const resolve of resolvers) {
                    resolve(trades);
                }
            } catch (error: unknown) {
                const failures = (this.tradeFailureCount.get(id) || 0) + 1;
                this.tradeFailureCount.set(id, failures);
                logger.warn(`Myriad watchTrades poll failed for outcomeId=${id} (consecutive failures: ${failures})`, { error: String(error) });

                if (failures >= MAX_CONSECUTIVE_FAILURES) {
                    const timer = this.tradeTimers.get(id);
                    if (timer) clearInterval(timer);
                    this.tradeTimers.delete(id);
                    this.tradeFailureCount.delete(id);

                    const rejecters = this.tradeRejecters.get(id) || [];
                    this.tradeResolvers.set(id, []);
                    this.tradeRejecters.set(id, []);
                    for (const reject of rejecters) {
                        reject(error);
                    }
                }
            }
        };

        poll();

        const timer = setInterval(poll, this.pollInterval);
        this.tradeTimers.set(id, timer);
    }
}
