/**
 * Maps polymarket-us SDK errors to PMXT unified error classes.
 *
 * The SDK exposes typed error subclasses (AuthenticationError,
 * BadRequestError, NotFoundError, RateLimitError, InternalServerError,
 * APIError, PolymarketUSError) so we can dispatch on instance rather
 * than inspecting raw HTTP responses.
 */

import {
    AuthenticationError as SdkAuthError,
    BadRequestError as SdkBadRequestError,
    NotFoundError as SdkNotFoundError,
    RateLimitError as SdkRateLimitError,
    InternalServerError as SdkInternalServerError,
    APIError as SdkApiError,
    PolymarketUSError as SdkBaseError,
} from 'polymarket-us';
import {
    AuthenticationError,
    BadRequest,
    BaseError,
    ExchangeNotAvailable,
    InsufficientFunds,
    InvalidOrder,
    MarketNotFound,
    OrderNotFound,
    RateLimitExceeded,
} from '../../errors';

const EXCHANGE_NAME = 'PolymarketUS';

/**
 * Construct a generic PMXT error for cases where no more specific
 * mapping applies. Uses BaseError directly since the project does not
 * yet expose an `ExchangeError` class.
 */
function genericExchangeError(message: string): BaseError {
    return new BaseError(message, 500, 'EXCHANGE_ERROR', false, EXCHANGE_NAME);
}

/**
 * Polymarket US -> PMXT error mapper.
 */
export class PolymarketUSErrorMapper {
    /**
     * Map an unknown error thrown by the polymarket-us SDK (or any
     * other source) to a PMXT error class instance.
     */
    mapError(error: unknown): Error {
        // Already a PMXT error: pass through unchanged so callers can
        // rely on `instanceof` checks (e.g. AuthenticationError thrown
        // by `requireAuth` before any SDK call).
        if (error instanceof BaseError) {
            return error;
        }

        // Authentication
        if (error instanceof SdkAuthError) {
            return new AuthenticationError(error.message, EXCHANGE_NAME);
        }

        // Rate limit
        if (error instanceof SdkRateLimitError) {
            return new RateLimitExceeded(error.message, undefined, EXCHANGE_NAME);
        }

        // Not found - inspect message to discriminate order vs market
        if (error instanceof SdkNotFoundError) {
            const lower = (error.message || '').toLowerCase();
            if (lower.includes('order')) {
                return new OrderNotFound(error.message, EXCHANGE_NAME);
            }
            if (lower.includes('market')) {
                return new MarketNotFound(error.message, EXCHANGE_NAME);
            }
            return genericExchangeError(error.message);
        }

        // Internal server error -> retryable unavailable
        if (error instanceof SdkInternalServerError) {
            return new ExchangeNotAvailable(error.message, EXCHANGE_NAME);
        }

        // Bad request - inspect for known sub-categories
        if (error instanceof SdkBadRequestError) {
            return mapBadRequest(error.message);
        }

        // Generic API error - dispatch on status code
        if (error instanceof SdkApiError) {
            return mapByStatus(error.status, error.message);
        }

        // Catch-all SDK base class
        if (error instanceof SdkBaseError) {
            return genericExchangeError(error.message);
        }

        // Anything else
        const message = String((error as any)?.message ?? error);
        return genericExchangeError(message);
    }
}

function mapBadRequest(message: string): Error {
    const lower = (message || '').toLowerCase();

    if (
        lower.includes('insufficient') ||
        lower.includes('buying power') ||
        lower.includes('balance')
    ) {
        return new InsufficientFunds(message, EXCHANGE_NAME);
    }

    if (
        lower.includes('invalid order') ||
        lower.includes('price') ||
        lower.includes('quantity') ||
        lower.includes('tick') ||
        lower.includes('self-match') ||
        lower.includes('self_match')
    ) {
        return new InvalidOrder(message, EXCHANGE_NAME);
    }

    if (lower.includes('market')) {
        if (lower.includes('not found')) {
            return new MarketNotFound(message, EXCHANGE_NAME);
        }
        if (
            lower.includes('closed') ||
            lower.includes('expired') ||
            lower.includes('halted') ||
            lower.includes('suspended')
        ) {
            return new InvalidOrder(message, EXCHANGE_NAME);
        }
    }

    return new BadRequest(message, EXCHANGE_NAME);
}

function mapByStatus(status: number, message: string): Error {
    if (status === 401) {
        return new AuthenticationError(message, EXCHANGE_NAME);
    }
    if (status === 404) {
        return genericExchangeError(message);
    }
    if (status === 429) {
        return new RateLimitExceeded(message, undefined, EXCHANGE_NAME);
    }
    if (status >= 500 && status < 600) {
        return new ExchangeNotAvailable(message, EXCHANGE_NAME);
    }
    return new BadRequest(message, EXCHANGE_NAME);
}

// Singleton instance for convenience
export const polymarketUSErrorMapper = new PolymarketUSErrorMapper();
