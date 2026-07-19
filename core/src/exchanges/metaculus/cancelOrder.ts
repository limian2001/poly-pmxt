import { AxiosInstance } from "axios";
import { Order } from "../../types";
import { AuthenticationError, ValidationError } from "../../errors";
import { metaculusErrorMapper } from "./errors";

/**
 * Parameters for the internal cancelOrder function.
 */
export interface CancelOrderContext {
    /** The exchange's axios instance (with rate limiting and logging). */
    http: AxiosInstance;
    /** Returns auth headers. Throws if no token is configured. */
    getAuthHeaders: () => Record<string, string>;
    /** Base URL for the Metaculus API. */
    baseUrl: string;
}

/**
 * Withdraw a forecast on Metaculus, mapped from the unified cancelOrder interface.
 *
 * ## How the mapping works
 *
 * "Cancelling an order" on Metaculus means withdrawing your forecast from a
 * question. After withdrawal, your prediction no longer affects the community
 * aggregate and is not scored.
 *
 * The `orderId` parameter should be the **Metaculus question ID** (the numeric
 * ID used in the forecast API, not the post ID). If you created the forecast
 * via `createOrder`, the question ID is encoded in the returned order's
 * `outcomeId` (the part before the hyphen).
 *
 * ## Authentication
 *
 * Requires a Metaculus API token. Pass `{ apiToken: "..." }` when constructing
 * the MetaculusExchange.
 *
 * @param orderId  The Metaculus question ID to withdraw the forecast from.
 * @param ctx      HTTP client and auth context.
 * @returns A synthetic Order with status "canceled".
 *
 * @throws {AuthenticationError} If no API token is configured.
 * @throws {ValidationError} If the orderId is not a valid numeric question ID.
 */
export async function cancelOrder(
    orderId: string,
    ctx: CancelOrderContext,
): Promise<Order> {
    try {
        // 1. Validate auth
        const headers = ctx.getAuthHeaders();
        if (!headers.Authorization) {
            throw new AuthenticationError(
                'Metaculus forecast withdrawal requires authentication. '
                + 'Pass { apiToken: "..." } when constructing MetaculusExchange.',
                "Metaculus",
            );
        }

        // 2. Parse question ID
        const questionId = parseInt(orderId, 10);
        if (isNaN(questionId)) {
            throw new ValidationError(
                `Invalid orderId "${orderId}": expected a numeric Metaculus question ID. `
                + "Use the question ID from the outcomeId (the part before the hyphen).",
                "Metaculus",
            );
        }

        // 3. POST directly to the withdraw endpoint.
        // Bypasses callApi because the API expects an array body.
        await ctx.http.request({
            method: "POST",
            url: `${ctx.baseUrl}/questions/withdraw/`,
            data: [{ question: questionId }],
            headers: { "Content-Type": "application/json", ...headers },
        });

        // 4. Return synthetic canceled order
        return {
            id: `mc-withdraw-${questionId}-${Date.now()}`,
            marketId: orderId,
            outcomeId: orderId,
            side: "buy",
            type: "market",
            amount: 1,
            status: "canceled",
            filled: 0,
            remaining: 0,
            timestamp: Date.now(),
        };
    } catch (error: any) {
        if (error.statusCode) throw error;
        throw metaculusErrorMapper.mapError(error);
    }
}
