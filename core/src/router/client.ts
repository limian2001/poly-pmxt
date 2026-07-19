import axios, { AxiosInstance } from 'axios';
import {
    AuthenticationError,
    NotFound,
    RateLimitExceeded,
    NetworkError,
    ExchangeNotAvailable,
    BadRequest,
} from '../errors';
import type { UnifiedMarket, UnifiedEvent } from '../types';
import type {
    FetchMatchesParams,
    FetchMarketMatchesParams,
    FetchEventMatchesParams,
    MatchResult,
    EventMatchResult,
    ArbitrageOpportunity,
    MatchRelation,
    RouterMarketSearchParams,
    RouterEventSearchParams,
} from './types';

// ---------------------------------------------------------------------------
// Raw API response shapes (before Router-level reshaping)
// ---------------------------------------------------------------------------

interface MarketMatchesResponse {
    matches: MatchResult[];
}

interface EventMatchesResponse {
    matches: EventMatchResult[];
}

interface RawMatchedPair {
    marketA: UnifiedMarket;
    marketB: UnifiedMarket;
    relation?: MatchRelation;
    confidence?: number;
    reasoning?: string | null;
}

const DEFAULT_BASE_URL = process.env.PMXT_API_URL || 'https://api.pmxt.dev';

export class PmxtApiClient {
    private readonly http: AxiosInstance;

    constructor(apiKey: string, baseUrl?: string) {
        this.http = axios.create({
            baseURL: baseUrl ?? DEFAULT_BASE_URL,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 30_000,
        });
    }

    async getMarketMatches(params: FetchMatchesParams): Promise<MarketMatchesResponse> {
        const id = params.marketId ?? params.slug ?? params.url;
        if (!id) throw new BadRequest('One of marketId, slug, or url is required', 'Router');

        const query: Record<string, string> = {};
        if (params.relation) query.relation = params.relation;
        if (params.minConfidence !== undefined) query.minConfidence = String(params.minConfidence);
        if (params.limit !== undefined) query.limit = String(params.limit);
        if (params.includePrices) query.includePrices = 'true';

        const res = await this.request<MarketMatchesResponse>('GET', `/v0/markets/${encodeURIComponent(id)}/matches`, query);
        return res.data;
    }

    async getEventMatches(params: FetchEventMatchesParams): Promise<EventMatchesResponse> {
        const id = params.eventId ?? params.slug;
        if (!id) throw new BadRequest('One of eventId or slug is required', 'Router');

        const query: Record<string, string> = {};
        if (params.relation) query.relation = params.relation;
        if (params.minConfidence !== undefined) query.minConfidence = String(params.minConfidence);
        if (params.limit !== undefined) query.limit = String(params.limit);
        if (params.includePrices) query.includePrices = 'true';

        const res = await this.request<EventMatchesResponse>('GET', `/v0/events/${encodeURIComponent(id)}/matches`, query);
        return res.data;
    }

    async browseMarketMatches(params: FetchMarketMatchesParams): Promise<MatchResult[]> {
        const query: Record<string, string> = {};
        if (params.query) query.query = params.query;
        if (params.category) query.category = params.category;
        if (params.relation) query.relation = params.relation;
        if (params.minConfidence !== undefined) query.minConfidence = String(params.minConfidence);
        if (params.limit !== undefined) query.limit = String(params.limit);

        const res = await this.request<RawMatchedPair[]>('GET', '/v0/matched-markets', query);
        // Reshape { marketA, marketB, ... } pairs into MatchResult shape
        const pairs: RawMatchedPair[] = Array.isArray(res.data) ? res.data : [];
        return pairs.map((pair: RawMatchedPair) => ({
            sourceMarket: pair.marketA,
            market: pair.marketB,
            relation: pair.relation || 'identity',
            confidence: pair.confidence || 0,
            reasoning: pair.reasoning || null,
            bestBid: null,
            bestAsk: null,
        }));
    }

    async browseEventMatches(params: FetchEventMatchesParams): Promise<EventMatchResult[]> {
        const query: Record<string, string> = {};
        if (params.query) query.query = params.query;
        if (params.category) query.category = params.category;
        if (params.relation) query.relation = params.relation;
        if (params.minConfidence !== undefined) query.minConfidence = String(params.minConfidence);
        if (params.limit !== undefined) query.limit = String(params.limit);

        const res = await this.request<EventMatchResult[]>('GET', '/v0/events/matches', query);
        return res.data;
    }

    async searchMarkets(params?: RouterMarketSearchParams): Promise<UnifiedMarket[]> {
        const query: Record<string, string> = {};
        if (params?.query) query.q = params.query;
        if (params?.sourceExchange) query.sourceExchange = params.sourceExchange;
        if (params?.category) query.category = params.category;
        if (params?.limit !== undefined) query.limit = String(params.limit);
        if (params?.offset !== undefined) query.offset = String(params.offset);
        if (params?.closed) query.closed = 'true';
        const res = await this.request<UnifiedMarket[]>('GET', '/v0/markets', query);
        return res.data;
    }

    async searchEvents(params?: RouterEventSearchParams): Promise<UnifiedEvent[]> {
        const query: Record<string, string> = {};
        if (params?.query) query.q = params.query;
        if (params?.sourceExchange) query.sourceExchange = params.sourceExchange;
        if (params?.category) query.category = params.category;
        if (params?.limit !== undefined) query.limit = String(params.limit);
        if (params?.offset !== undefined) query.offset = String(params.offset);
        if (params?.closed) query.closed = 'true';
        const res = await this.request<UnifiedEvent[]>('GET', '/v0/events', query);
        return res.data;
    }

    async getArbitrage(query?: Record<string, string>): Promise<ArbitrageOpportunity[]> {
        const res = await this.request<ArbitrageOpportunity[]>('GET', '/v0/arbitrage', query);
        return res.data;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async request<T = unknown>(
        method: string,
        path: string,
        query?: Record<string, string>,
    ): Promise<{ data: T }> {
        try {
            const response = await this.http.request({
                method,
                url: path,
                params: query,
            });
            return response.data;
        } catch (error: unknown) {
            throw this.mapError(error);
        }
    }

    private mapError(error: unknown): Error {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message =
                error.response?.data?.error ??
                error.response?.data?.message ??
                error.message;

            switch (status) {
                case 401:
                    return new AuthenticationError(message, 'Router');
                case 404:
                    return new NotFound(message, 'Router');
                case 429: {
                    const retryAfter = error.response?.headers?.['retry-after'];
                    return new RateLimitExceeded(
                        message,
                        retryAfter ? parseInt(retryAfter, 10) : undefined,
                        'Router',
                    );
                }
                case 400:
                    return new BadRequest(message, 'Router');
                default:
                    if (status && status >= 500) {
                        return new ExchangeNotAvailable(
                            `Router API error (${status}): ${message}`,
                            'Router',
                        );
                    }
                    return new BadRequest(message, 'Router');
            }
        }

        if (error instanceof Error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
                return new NetworkError(`Network error: ${error.message}`, 'Router');
            }
            return error;
        }

        return new Error(String(error));
    }
}
