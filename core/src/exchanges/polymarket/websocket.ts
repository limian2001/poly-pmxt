/**
 * @license
 * Polymarket WebSocket implementation for pmxt.
 *
 * NOTICE: This implementation depends on "@nevuamarkets/poly-websockets",
 * which is licensed under the MIT License.
 */

import { SubscribedAddressSnapshot, SubscriptionOption } from '../../subscriber/base';
import { logger } from '../../utils/logger';
import {
    buildPolymarketActivity,
    GoldSkySubscriber,
    POLYMARKET_DEFAULT_SUBSCRIPTION,
} from '../../subscriber/external/goldsky';
import { AddressWatcher, WatcherConfig } from '../../subscriber/watcher';
import { OrderBook, QueuedPromise, Trade } from '../../types';
import { DEFAULT_WATCH_TIMEOUT_MS, withWatchTimeout } from '../../utils/watch-timeout';


export interface PolymarketUserChannelCreds {
    apiKey: string;
    secret: string;
    passphrase: string;
}

export interface UserTradeEvent {
    asset_id: string;
    event_type: 'trade';
    price: string;
    size: string;
    side: string;
    status: string; // MATCHED, MINED, CONFIRMED, RETRYING, FAILED
    maker_orders?: any[];
    timestamp?: string;
}

export interface UserOrderEvent {
    asset_id: string;
    event_type: 'order';
    order_id: string;
    price: string;
    original_size: string;
    matched_size?: string;
    side: string;
    type: string; // PLACEMENT, UPDATE, CANCELLATION
    timestamp?: string;
}

export type UserChannelEvent = UserTradeEvent | UserOrderEvent;
export type UserChannelCallback = (event: UserChannelEvent) => void;

export interface PolymarketWebSocketConfig {
    /** Reconnection check interval in milliseconds (default: 5000) */
    reconnectIntervalMs?: number;
    /** Pending subscription flush interval in milliseconds (default: 100) */
    flushIntervalMs?: number;
    /** Watcher subscription configurations */
    watcherConfig?: WatcherConfig;
    /** Timeout in ms for watch methods to receive data (default: 30000). 0 = no timeout. */
    watchTimeoutMs?: number;
    /** API credentials for the authenticated user channel (fills/orders). */
    userChannelCreds?: PolymarketUserChannelCreds;
    /** Timeout in ms for WebSocket connections to open (default: 30000). */
    connectionTimeoutMs?: number;
    /** Time to wait for an initial market-channel book before using a REST snapshot fallback. */
    snapshotFallbackMs?: number;
    /**
     * 合并订阅新增的时间窗（毫秒，默认 500）。
     * market channel 一条连接只认一次 subscribe，扩充订阅必须换连接；
     * 这个窗口把「同一批要盯的资产」攒成一次重连，避免开 160 个订阅时重连 160 遍。
     * 调大 = 首次报价更慢但更省连接；调 0 = 每个新增都立刻换一条连接（别这么干）。
     */
    subscribeCoalesceMs?: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_SNAPSHOT_FALLBACK_MS = 3_000;
const DEFAULT_SUBSCRIBE_COALESCE_MS = 500;
const MAX_PENDING_TRADES_PER_ASSET = 1000;
const MAX_USER_CALLBACKS = 100;

const POLYMARKET_MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Native WebSocket implementation for Polymarket market data.
 * Replaces the @nevuamarkets/poly-websockets dependency.
 */
export class PolymarketWebSocket {
    private ws: any;
    private subscribedAssets = new Set<string>();
    private readonly watcher: AddressWatcher;
    private orderBookResolvers = new Map<string, QueuedPromise<OrderBook>[]>();
    private tradeResolvers = new Map<string, QueuedPromise<Trade[]>[]>();
    private pendingTrades = new Map<string, Trade[]>();
    private orderBooks = new Map<string, OrderBook>();
    private config: PolymarketWebSocketConfig;
    private initializationPromise?: Promise<void>;
    private marketPingInterval: ReturnType<typeof setInterval> | null = null;
    /** 当前这条连接是否已经用掉了它唯一的一次 subscribe 机会 */
    private subscriptionSent = false;
    /** coalesce 窗口的定时器；非 null 表示已经有一次 apply 排着队了 */
    private applyTimer: ReturnType<typeof setTimeout> | null = null;
    /** 正在为扩充订阅而换连接。此时不要再触发新的换连接 */
    private reconnecting = false;
    /** 服务端回过的纯文本帧只在第一次记一条，免得刷屏 */
    private loggedTextFrames = new Set<string>();
    private readonly callApi: (operationId: string, params?: Record<string, any>) => Promise<any>;

    constructor(callApi: (operationId: string, params?: Record<string, any>) => Promise<any>, config: PolymarketWebSocketConfig = {}) {
        this.callApi = callApi;
        this.config = config;
        const watcherConfig = this.config.watcherConfig;
        const subscriber = new GoldSkySubscriber({
            ...watcherConfig,
            buildSubscription: POLYMARKET_DEFAULT_SUBSCRIPTION,
        });
        this.watcher = new AddressWatcher(
            (address, types) => callApi('fetchWatchedAddressActivity', { address, types }),
            {
                subscriber,
                buildActivity: buildPolymarketActivity,
            },
        );
    }

    async watchOrderBook(outcomeId: string): Promise<OrderBook> {
        await this.ensureInitialized();
        await this.subscribe([outcomeId]);

        // Return a promise that resolves on the next orderbook update.
        // If the upstream market channel accepts the subscription but stays
        // quiet, return a real REST snapshot instead of hanging indefinitely.
        const resolverEntry: QueuedPromise<OrderBook> = {
            resolve: () => {},
            reject: () => {},
        };
        const dataPromise = new Promise<OrderBook>((resolve, reject) => {
            resolverEntry.resolve = resolve;
            resolverEntry.reject = reject;
            const existing = this.orderBookResolvers.get(outcomeId) ?? [];
            this.orderBookResolvers.set(outcomeId, [...existing, resolverEntry]);
        });

        return withWatchTimeout(
            this.withSnapshotFallback(outcomeId, dataPromise, resolverEntry),
            this.config.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
            `watchOrderBook('${outcomeId}')`,
        );
    }

    async unwatchOrderBook(outcomeId: string): Promise<void> {
        this.subscribedAssets.delete(outcomeId);

        // Clear any pending resolvers for this asset
        const resolvers = this.orderBookResolvers.get(outcomeId);
        if (resolvers) {
            this.orderBookResolvers = new Map(
                [...this.orderBookResolvers].filter(([key]) => key !== outcomeId),
            );
        }

        // Remove the cached orderbook for this asset
        if (this.orderBooks.has(outcomeId)) {
            this.orderBooks = new Map(
                [...this.orderBooks].filter(([key]) => key !== outcomeId),
            );
        }
    }

    async watchTrades(outcomeId: string, address?: string): Promise<Trade[]> {
        if (address) {
            return this.watcher.watch(address, ['trades'], outcomeId);
        }

        await this.ensureInitialized();
        await this.subscribe([outcomeId]);

        // Return accumulated trades immediately if any arrived between calls
        const accumulated = this.pendingTrades.get(outcomeId);
        if (accumulated && accumulated.length > 0) {
            const result = [...accumulated];
            this.pendingTrades.set(outcomeId, []);
            return result;
        }

        // Otherwise wait for the next trade
        const dataPromise = new Promise<Trade[]>((resolve, reject) => {
            const existing = this.tradeResolvers.get(outcomeId) ?? [];
            this.tradeResolvers.set(outcomeId, [...existing, { resolve, reject }]);
        });

        return withWatchTimeout(
            dataPromise,
            this.config.watchTimeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
            `watchTrades('${outcomeId}')`,
        );
    }

    async watchAddress(address: string, types: SubscriptionOption[]): Promise<SubscribedAddressSnapshot> {
        return this.watcher.watch(address, types);
    }

    async unwatchAddress(address: string): Promise<void> {
        return this.watcher.unwatch(address);
    }

    // -----------------------------------------------------------------
    // Authenticated User Channel (fills + order updates)
    // -----------------------------------------------------------------

    private userWs: any = null;
    private userCallbacks: UserChannelCallback[] = [];
    private userPingInterval: ReturnType<typeof setInterval> | null = null;
    private userReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private userConditionIds: string[] = [];

    /**
     * Subscribe to authenticated fill/order events via Polymarket's user channel.
     * Requires `userChannelCreds` in the config.
     *
     * @param conditionIds - Market condition IDs to monitor
     * @param callback     - Called for each trade or order event
     */
    async watchUserFills(conditionIds: string[], callback: UserChannelCallback): Promise<void> {
        const creds = this.config.userChannelCreds;
        if (!creds) {
            throw new Error(
                'User channel requires API credentials. Pass userChannelCreds in PolymarketWebSocketConfig.',
            );
        }
        if (!this.userCallbacks.includes(callback)) {
            if (this.userCallbacks.length >= MAX_USER_CALLBACKS) {
                throw new Error(
                    `Maximum user callback limit (${MAX_USER_CALLBACKS}) reached. Call unwatchUserFills() to clear existing callbacks.`,
                );
            }
            this.userCallbacks = [...this.userCallbacks, callback];
        }
        this.userConditionIds = [...new Set([...this.userConditionIds, ...conditionIds])];

        if (this.userWs) {
            // Already connected — just re-subscribe with updated condition IDs.
            this.sendUserSubscription(creds);
            return;
        }

        await this.connectUserChannel(creds);
    }

    /**
     * Stop watching user fills and close the user channel WebSocket.
     */
    async unwatchUserFills(): Promise<void> {
        this.userCallbacks = [];
        this.userConditionIds = [];
        this.closeUserChannel();
    }

    private async connectUserChannel(creds: PolymarketUserChannelCreds): Promise<void> {
        const WebSocket = (await import('ws')).default;
        const url = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';
        const timeoutMs = this.config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;

        this.userWs = new WebSocket(url);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.userWs?.terminate();
                this.userWs = null;
                reject(new Error(`Polymarket user channel connection timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.userWs.on('open', () => {
                clearTimeout(timeout);
                logger.info('[polymarket-ws] user channel connected');
                this.sendUserSubscription(creds);

                // Ping every 10 seconds to keep the connection alive.
                if (this.userPingInterval) clearInterval(this.userPingInterval);
                this.userPingInterval = setInterval(() => {
                    if (this.userWs?.readyState === WebSocket.OPEN) {
                        this.userWs.ping();
                    }
                }, 10_000);
                resolve();
            });

            this.userWs.on('error', (err: Error) => {
                clearTimeout(timeout);
                logger.error('[polymarket-ws] user channel error', { error: err.message });
                reject(err);
            });
        });

        this.userWs.on('message', (raw: Buffer) => {
            try {
                const events: UserChannelEvent[] = JSON.parse(raw.toString());
                const arr = Array.isArray(events) ? events : [events];
                for (const event of arr) {
                    for (const cb of this.userCallbacks) {
                        try { cb(event); } catch (e: unknown) {
                            logger.error('[polymarket-ws] user callback error', { error: e instanceof Error ? e.message : String(e) });
                        }
                    }
                }
            } catch {
                // Non-JSON control message (pong, etc.) — ignore.
            }
        });

        this.userWs.on('close', () => {
            logger.warn('[polymarket-ws] user channel disconnected, reconnecting in 5s');
            this.scheduleUserReconnect(creds);
        });
    }

    private sendUserSubscription(creds: PolymarketUserChannelCreds): void {
        if (!this.userWs || this.userWs.readyState !== 1) return;
        const msg = JSON.stringify({
            auth: {
                apiKey: creds.apiKey,
                secret: creds.secret,
                passphrase: creds.passphrase,
            },
            markets: this.userConditionIds,
            type: 'user',
        });
        this.userWs.send(msg);
    }

    private scheduleUserReconnect(creds: PolymarketUserChannelCreds): void {
        if (this.userReconnectTimer) return;
        this.userReconnectTimer = setTimeout(async () => {
            this.userReconnectTimer = null;
            if (this.userCallbacks.length > 0) {
                try { await this.connectUserChannel(creds); } catch (e: any) {
                    logger.error('[polymarket-ws] reconnect failed', { error: e.message });
                    this.scheduleUserReconnect(creds);
                }
            }
        }, 5000);
    }

    private closeUserChannel(): void {
        if (this.userPingInterval) { clearInterval(this.userPingInterval); this.userPingInterval = null; }
        if (this.userReconnectTimer) { clearTimeout(this.userReconnectTimer); this.userReconnectTimer = null; }
        if (this.userWs) { this.userWs.close(); this.userWs = null; }
    }

    async close() {
        if (this.applyTimer) { clearTimeout(this.applyTimer); this.applyTimer = null; }
        this.reconnecting = false;
        this.subscriptionSent = false;
        if (this.ws) {
            // 这是我们主动关的，close 回调不该再去 reject / 重连
            (this.ws as any).__plannedClose = true;
            this.ws.close();
            this.ws = null;
        }
        this.initializationPromise = undefined;
        this.stopMarketHeartbeat();
        this.subscribedAssets.clear();
        this.loggedTextFrames.clear();
        this.closeUserChannel();
        this.watcher.close();
    }

    /**
     * 订阅资产。
     *
     * **Polymarket 的 market channel 每条连接只接受一次 subscribe。**
     * 2026-07 实测（wss://ws-subscriptions-clob.polymarket.com/ws/market）：
     *   第 1 帧 subscribe  -> 正常回 book 快照，之后持续推送
     *   第 2 帧 subscribe  -> 回一个纯文本 "INVALID OPERATION"，**连接不断**，
     *                        第 1 批资产照常推，第 2 批则从此石沉大海
     *   第 3 帧（去掉 custom_feature_enabled）-> 同样 INVALID OPERATION
     *   心跳字符串 "PING"  -> 正常回 "PONG"（心跳是好的，别去动它）
     *
     * 老实现是「差集增量发帧」：每来一个新 id 就单独发一帧，并且**发之前就把 id
     * 记进 subscribedAssets**。后果是灾难性的 ——
     *   1. 并发订阅 N 个资产时只有第 1 帧生效，其余 N-1 帧被静默拒绝，
     *      但那些 id 已经被记成"已订阅"，它们的 resolver 永远等不到数据；
     *   2. 连接重连后，subscribedAssets 里全是"已订阅"，差集为空，
     *      于是**一帧都不会重发**，整条连接从此哑掉。
     *
     * 新实现把 subscribedAssets 当作**目标集合**，订阅帧是连接生命周期的函数而不是
     * 差集的函数：每条连接在 open 之后只发一次，内容是当时的完整目标集合。
     * 目标集合变大时，唯一的办法是换一条新连接重来（换连接会拿到全量 book 快照，
     * 所以 pending 的 resolver 会被新快照喂饱，不需要 reject）。
     * 短时间内的多次新增用 coalesce 窗口合并，避免抖动成重连风暴。
     */
    private async subscribe(assetIds: string[]) {
        let grew = false;
        for (const id of assetIds) {
            if (!this.subscribedAssets.has(id)) {
                this.subscribedAssets.add(id);
                grew = true;
            }
        }
        // 没有新增，但这条连接还没把订阅帧发出去（刚重连），也得补一次
        if (!grew && this.subscriptionSent) return;
        this.scheduleApplySubscriptions();
    }

    /** 合并短时间内的多次新增，只触发一次真正的订阅动作 */
    private scheduleApplySubscriptions(): void {
        if (this.applyTimer) return;
        const delay = this.config.subscribeCoalesceMs ?? DEFAULT_SUBSCRIBE_COALESCE_MS;
        this.applyTimer = setTimeout(() => {
            this.applyTimer = null;
            void this.applySubscriptions().catch((e: unknown) => {
                logger.error('[polymarket-ws] apply subscriptions failed', {
                    error: e instanceof Error ? e.message : String(e),
                });
            });
        }, delay);
        (this.applyTimer as any)?.unref?.();
    }

    private async applySubscriptions(): Promise<void> {
        if (this.subscribedAssets.size === 0) return;
        if (this.reconnecting) { this.scheduleApplySubscriptions(); return; }   // 换连接的过程中，等它落定再说
        if (!this.ws || this.ws.readyState !== 1) return;                       // 连接还没好，open 时会自己发
        if (!this.subscriptionSent) { this.sendSubscriptionFrame(); return; }
        // 这条连接唯一的一次 subscribe 机会已经用掉了，只能换一条
        await this.reconnectForSubscription();
    }

    /** 每条连接只调用一次，内容是完整目标集合 */
    private sendSubscriptionFrame(): void {
        if (!this.ws || this.ws.readyState !== 1) return;
        if (this.subscribedAssets.size === 0) return;
        this.ws.send(JSON.stringify({
            assets_ids: [...this.subscribedAssets],
            type: 'market',
            custom_feature_enabled: true,
        }));
        this.subscriptionSent = true;
    }

    /**
     * 为了扩充订阅而主动换一条连接。
     * 关键是打上 __plannedClose：这是我们自己关的，close 回调不能去 reject 上层那些
     * 还在等报价的 resolver —— 新连接一 open 就会推来全量 book 快照，它们马上会被喂饱。
     */
    private async reconnectForSubscription(): Promise<void> {
        const old = this.ws;
        this.reconnecting = true;
        this.subscriptionSent = false;
        this.initializationPromise = undefined;
        this.ws = null;
        this.stopMarketHeartbeat();
        if (old) {
            (old as any).__plannedClose = true;
            try { old.close(); } catch { /* 关不掉就算了，反正已经不用它了 */ }
        }
        try {
            await this.ensureInitialized();
        } finally {
            this.reconnecting = false;
        }
    }

    private async ensureInitialized() {
        if (this.initializationPromise) return this.initializationPromise;

        const timeoutMs = this.config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;

        this.initializationPromise = new Promise<void>((resolve, reject) => {
            const WebSocket = require('ws');
            // **所有回调都绑在这个局部 ws 上，不要用 this.ws。**
            // 换连接期间 this.ws 已经指向新的那条了，旧连接的 close/error 回调如果还去读
            // this.ws，就会把新连接一起清掉 —— 这类"回调打错对象"的 bug 极难查。
            const ws = new WebSocket(POLYMARKET_MARKET_WS_URL);
            this.ws = ws;
            this.subscriptionSent = false;

            const timeout = setTimeout(() => {
                try { ws.terminate(); } catch { /* 已经没了就算了 */ }
                if (this.ws === ws) { this.ws = null; this.initializationPromise = undefined; }
                reject(new Error(`Polymarket market channel connection timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            ws.on('open', () => {
                clearTimeout(timeout);
                this.startMarketHeartbeat();
                // 这条连接唯一的一次 subscribe，内容是当下的完整目标集合。
                // 必须在这里发：重连之后没人会替我们补，老实现就是栽在这一点上。
                if (this.ws === ws) {
                    this.subscriptionSent = false;
                    this.sendSubscriptionFrame();
                }
                resolve();
            });

            ws.on('message', (raw: any) => {
                try {
                    const text = raw.toString();
                    if (text === 'PONG' || text === 'PING') return;
                    // 服务端的控制类回应是纯文本，不是 JSON。直接扔进 JSON.parse 只会
                    // 得到一句没头没尾的 "Unexpected token 'I'"，把真正的信息
                    // （"INVALID OPERATION"）藏起来。原样记一次，别每帧都刷。
                    if (text[0] !== '{' && text[0] !== '[') {
                        if (!this.loggedTextFrames.has(text)) {
                            this.loggedTextFrames.add(text);
                            logger.warn('[polymarket-ws] market channel text frame', { text: text.slice(0, 200) });
                        }
                        return;
                    }
                    const msgs = JSON.parse(text);
                    const arr = Array.isArray(msgs) ? msgs : [msgs];
                    for (const msg of arr) {
                        const type = msg.event_type;
                        if (type === 'book') this.handleBookSnapshot(msg);
                        else if (type === 'price_change') this.handlePriceChange(msg);
                        else if (type === 'last_trade_price') this.handleTrade(msg);
                    }
                } catch (e: unknown) {
                    logger.error('[polymarket-ws] market message handler error', {
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            });

            ws.on('error', (err: Error) => {
                clearTimeout(timeout);
                if ((ws as any).__plannedClose) return;   // 自己关的，别惊动上层
                logger.error('[polymarket-ws] WebSocket error', { error: err.message });
                this.rejectPendingMarketResolvers(err);
                reject(err);
            });

            ws.on('close', () => {
                // 为了扩充订阅主动换连接时走这里。**绝对不能 reject pending resolver**：
                // 新连接一 open 就会推来全量 book 快照，那些还在等报价的调用马上会被喂饱。
                // 老代码在这里无差别 reject，一次换连接就把上百个订阅全判一次失败。
                if ((ws as any).__plannedClose) return;
                this.stopMarketHeartbeat();
                this.rejectPendingMarketResolvers(new Error('Polymarket market channel closed'));
                if (this.ws === ws) {
                    this.initializationPromise = undefined;
                    this.ws = null;
                    this.subscriptionSent = false;
                }
            });
        });

        return this.initializationPromise;
    }

    private handleBookSnapshot(event: any) {
        const id = event.asset_id;

        const orderBook = this.normalizeRawOrderBook(event);

        this.orderBooks.set(id, orderBook);
        this.resolveOrderBook(id, orderBook);
    }

    private withSnapshotFallback(
        outcomeId: string,
        dataPromise: Promise<OrderBook>,
        resolverEntry: QueuedPromise<OrderBook>,
    ): Promise<OrderBook> {
        const fallbackMs = this.config.snapshotFallbackMs ?? DEFAULT_SNAPSHOT_FALLBACK_MS;
        if (fallbackMs <= 0) return dataPromise;

        let timer: ReturnType<typeof setTimeout>;
        const fallbackPromise = new Promise<OrderBook>((resolve, reject) => {
            timer = setTimeout(async () => {
                this.removeOrderBookResolver(outcomeId, resolverEntry);
                try {
                    resolve(await this.fetchOrderBookSnapshot(outcomeId));
                } catch (error) {
                    reject(error);
                }
            }, fallbackMs);
        });

        return Promise.race([dataPromise, fallbackPromise]).finally(() => {
            clearTimeout(timer);
        });
    }

    private removeOrderBookResolver(outcomeId: string, resolverEntry: QueuedPromise<OrderBook>): void {
        const resolvers = this.orderBookResolvers.get(outcomeId);
        if (!resolvers) return;
        const filtered = resolvers.filter((entry) => entry !== resolverEntry);
        if (filtered.length > 0) {
            this.orderBookResolvers.set(outcomeId, filtered);
        } else {
            this.orderBookResolvers.delete(outcomeId);
        }
    }

    private async fetchOrderBookSnapshot(outcomeId: string): Promise<OrderBook> {
        const raw = await this.callApi('getBook', { token_id: outcomeId });
        const orderBook = this.normalizeRawOrderBook({
            ...raw,
            asset_id: raw?.asset_id ?? outcomeId,
        });
        this.orderBooks.set(outcomeId, orderBook);
        return orderBook;
    }

    private normalizeRawOrderBook(raw: any): OrderBook {
        const bids = (raw?.bids || []).map((level: any) => ({
            price: parseFloat(level.price),
            size: parseFloat(level.size),
        })).sort((a: any, b: any) => b.price - a.price);

        const asks = (raw?.asks || []).map((level: any) => ({
            price: parseFloat(level.price),
            size: parseFloat(level.size),
        })).sort((a: any, b: any) => a.price - b.price);

        return {
            bids,
            asks,
            timestamp: this.parseTimestamp(raw?.timestamp),
        };
    }

    private parseTimestamp(value: unknown): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.length > 0) {
            const numeric = Number(value);
            return Number.isNaN(numeric) ? new Date(value).getTime() : numeric;
        }
        return Date.now();
    }

    private startMarketHeartbeat(): void {
        this.stopMarketHeartbeat();
        this.marketPingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === 1) {
                try {
                    this.ws.send('PING');
                } catch (error) {
                    logger.warn('[polymarket-ws] market heartbeat failed', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }, 10_000);
    }

    private stopMarketHeartbeat(): void {
        if (this.marketPingInterval) {
            clearInterval(this.marketPingInterval);
            this.marketPingInterval = null;
        }
    }

    private rejectPendingMarketResolvers(error: Error): void {
        for (const [, resolvers] of this.orderBookResolvers) {
            for (const resolver of resolvers) resolver.reject(error);
        }
        this.orderBookResolvers.clear();

        for (const [, resolvers] of this.tradeResolvers) {
            for (const resolver of resolvers) resolver.reject(error);
        }
        this.tradeResolvers.clear();
    }

    private handlePriceChange(event: any) {
        const id = event.asset_id;
        const existing = this.orderBooks.get(id);

        if (!existing) return;

        // Native API sends individual price_change events (not wrapped in an array)
        const changes = event.price_changes || [event];
        for (const change of changes) {
            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            const side = (change.side || '').toUpperCase();

            const levels = side === 'BUY' ? existing.bids : existing.asks;
            const existingIndex = levels.findIndex((l) => l.price === price);

            if (size === 0) {
                // Remove level
                if (existingIndex !== -1) {
                    levels.splice(existingIndex, 1);
                }
            } else {
                // Update or add level
                if (existingIndex !== -1) {
                    levels[existingIndex].size = size;
                } else {
                    levels.push({ price, size });
                    // Re-sort
                    if (side === 'BUY') {
                        levels.sort((a, b) => b.price - a.price);
                    } else {
                        levels.sort((a, b) => a.price - b.price);
                    }
                }
            }

            existing.timestamp = event.timestamp ? (isNaN(Number(event.timestamp)) ? new Date(event.timestamp).getTime() : Number(event.timestamp)) : Date.now();
            this.resolveOrderBook(id, existing);
        }
    }

    private handleTrade(event: any) {
        const id = event.asset_id;

        const trade: Trade = {
            id: `${event.timestamp}-${Math.random()}`,
            timestamp: event.timestamp ? (isNaN(Number(event.timestamp)) ? new Date(event.timestamp).getTime() : Number(event.timestamp)) : Date.now(),
            price: parseFloat(event.price),
            amount: parseFloat(event.size),
            side: event.side.toLowerCase() as 'buy' | 'sell' | 'unknown',
        };

        // Resolve waiting promises if any, otherwise buffer for next watchTrades call
        const resolvers = this.tradeResolvers.get(id);
        if (resolvers && resolvers.length > 0) {
            resolvers.forEach((r) => r.resolve([trade]));
            this.tradeResolvers.set(id, []);
        } else {
            const pending = this.pendingTrades.get(id) ?? [];
            const updated = pending.length >= MAX_PENDING_TRADES_PER_ASSET
                ? [...pending.slice(1), trade]
                : [...pending, trade];
            this.pendingTrades.set(id, updated);
        }
    }

    private resolveOrderBook(id: string, orderBook: OrderBook) {
        const resolvers = this.orderBookResolvers.get(id);
        if (resolvers && resolvers.length > 0) {
            resolvers.forEach((r) => r.resolve(orderBook));
            this.orderBookResolvers.set(id, []);
        }
    }
}
