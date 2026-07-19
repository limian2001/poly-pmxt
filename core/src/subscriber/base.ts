// ----------------------------------------------------------------------------
// Basic Types & interface
// ----------------------------------------------------------------------------
import { Balance, Position, Trade } from '../types';

export type SubscriptionOption = 'trades' | 'positions' | 'balances';

export interface SubscribedAddressSnapshot {
    /** The wallet address being watched */
    address: string;

    /** Recent trades for this address
     * (if the above SubscriptionOption 'trades' option was requested)
     */
    trades?: Trade[];

    /** Current open positions for this address
     * (if the above SubscriptionOption 'positions' option was requested)
     */
    positions?: Position[];

    /** Current balances for this address
     * (if the above SubscriptionOption 'balances' option was requested)
     */
    balances?: Balance[];

    /** Unix timestamp (ms) of this snapshot */
    timestamp: number;
}

/**
 * Partial snapshot constructed from a subscribed event's on-chain data.
 * Only the types that could be fully derived from the event are present.
 */
export type SubscribedResult = Partial<Omit<SubscribedAddressSnapshot, 'address' | 'timestamp'>>;

type SubscriptionBuilder = (address: string) => any;

/**
 * Tries to build a partial SubscribedAddressSnapshot from raw watched event data.
 * The implementation varies depending on the implementation of SubscriptionBuilder.
 *
 * Data is the raw payload, the subscribed address, the requested types,
 * and the last known snapshot.
 *
 * Return an `SubscribedResult` object containing only the types you can fully
 * populate from the event
 */
export type SubscribedActivityBuilder = (
    data: unknown,
    address: string,
    types: SubscriptionOption[],
    lastSnapshot?: SubscribedAddressSnapshot | null,
) => SubscribedResult | null;


export interface SubscriberConfig {
    /**
     * HTTP endpoint used for polling queries.
     */
    baseUrl?: string;

    /**
     * Milliseconds between query polls once websocket subscription is not available.
     * @default 3000
     */
    pollMs?: number;

    /**
     * WebSocket endpoint
     */
    wsEndpoint?: string;

    /** API key for authenticating with the external subscription provider.
     * Required when the provider restricts access to authenticated clients.
     */
    apiKey?: string;

    /**
     * Builds the customized per-address subscription query
     */
    buildSubscription?: SubscriptionBuilder;

    /**
     * Milliseconds between reconnect attempts after a WebSocket disconnect.
     * @default 5000
     */
    reconnectDelayMs?: number;
}

// ----------------------------------------------------------------------------
// BaseSubscriber interface
// ----------------------------------------------------------------------------

/**
 * Optional subscription that notifies the watcher of on-chain activity for a
 * watched address.
 */
export interface BaseSubscriber {
    /**
     * Start receiving notifications for `address`.
     * Resolves once the subscription is active, or throws if the watcher
     * cannot be set up (the watcher will fall back to polling-only on error).
     */
    subscribe(address: string, types: SubscriptionOption[], onEvent: (data: unknown) => void): Promise<void>;

    /** Stop receiving notifications for `address`. */
    unsubscribe(address: string): void;

    /** Tear down all subscriptions and close underlying connections. */
    close(): void;
}
