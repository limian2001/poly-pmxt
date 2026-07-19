// ----------------------------------------------------------------------------
// Raw message types from the Binance trade relay (obdata)
// See: https://github.com/pmxt-dev/obdata/blob/main/docs/apis/BINANCE_WS.md
// ----------------------------------------------------------------------------

export interface BinanceRelayTradeEvent {
    readonly op: 'event';
    readonly source: 'binance';
    readonly symbol: string;
    readonly trade_id: number;
    readonly price: string;
    readonly quantity: string;
    readonly event_time_ms: number;
    readonly trade_time_ms: number;
    readonly is_buyer_maker: boolean;
    readonly timestamp_received_ms: number;
}

export interface BinanceRelayAck {
    readonly op: 'ack';
    readonly subscribed_all: boolean;
}

export interface BinanceRelayPong {
    readonly op: 'pong';
}

export type BinanceRelayMessage =
    | BinanceRelayTradeEvent
    | BinanceRelayAck
    | BinanceRelayPong;

export interface BinanceFeedConfig {
    /** WebSocket URL for the Binance trade relay. */
    readonly wsUrl?: string;
    /** API key for authentication. */
    readonly apiKey?: string;
    /** Reconnect interval in ms (default: 5000). */
    readonly reconnectIntervalMs?: number;
}

export const BINANCE_RELAY_DEFAULTS = {
    wsUrl: process.env.BINANCE_RELAY_WS_URL || '',
    reconnectIntervalMs: 5000,
} as const;
