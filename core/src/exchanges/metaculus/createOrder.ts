import { AxiosInstance } from "axios";
import { CreateOrderParams, Order, MarketOutcome } from "../../types";
import { AuthenticationError, InvalidOrder, ValidationError } from "../../errors";
import { metaculusErrorMapper } from "./errors";
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// OutcomeId Parsing
// ---------------------------------------------------------------------------

/**
 * Parsed result from a Metaculus outcomeId string.
 *
 * OutcomeId format:
 * - Binary:          `<questionId>-YES` or `<questionId>-NO`
 * - Multiple-choice: `<questionId>-<categoryIndex>` (numeric index)
 * - Continuous:      `<questionId>-HIGHER` or `<questionId>-LOWER` (not tradeable)
 */
export interface ParsedOutcomeId {
    /** The Metaculus question ID (used in the forecast API). */
    questionId: number;
    /** The question type inferred from the suffix. */
    type: "binary" | "multiple_choice" | "continuous";
    /** The raw suffix after the first hyphen (YES, NO, HIGHER, LOWER, or index). */
    suffix: string;
    /** For multiple-choice outcomes, the 0-based category index. */
    categoryIndex?: number;
}

/**
 * Parse a Metaculus outcomeId into its components.
 *
 * @throws {ValidationError} If the outcomeId format is unrecognizable.
 */
export function parseOutcomeId(outcomeId: string): ParsedOutcomeId {
    const dashIdx = outcomeId.indexOf("-");
    if (dashIdx === -1) {
        throw new ValidationError(
            `Invalid Metaculus outcomeId "${outcomeId}". `
            + 'Expected format: "<questionId>-YES", "<questionId>-NO", or "<questionId>-<index>".',
            "Metaculus",
        );
    }

    const idPart = outcomeId.slice(0, dashIdx);
    const suffix = outcomeId.slice(dashIdx + 1);
    const questionId = parseInt(idPart, 10);

    if (isNaN(questionId)) {
        throw new ValidationError(
            `Invalid question ID in outcomeId "${outcomeId}". The part before the hyphen must be a numeric question ID.`,
            "Metaculus",
        );
    }

    const upperSuffix = suffix.toUpperCase();

    if (upperSuffix === "HIGHER" || upperSuffix === "LOWER") {
        return { questionId, type: "continuous", suffix };
    }

    if (upperSuffix === "YES" || upperSuffix === "NO") {
        return { questionId, type: "binary", suffix };
    }

    // Numeric suffix -> multiple-choice category index
    const idx = parseInt(suffix, 10);
    if (!isNaN(idx) && idx >= 0) {
        return { questionId, type: "multiple_choice", suffix, categoryIndex: idx };
    }

    throw new ValidationError(
        `Unrecognized outcomeId suffix "${suffix}" in "${outcomeId}". `
        + 'Expected YES, NO, HIGHER, LOWER, or a numeric category index.',
        "Metaculus",
    );
}

// ---------------------------------------------------------------------------
// Probability Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a probability value is in the open interval (0, 1).
 *
 * Metaculus requires probability_yes to be strictly between 0 and 1.
 * The exact boundaries (0.0 and 1.0) are rejected by the API.
 *
 * @throws {InvalidOrder} If the value is missing or out of range.
 */
export function validateProbability(price: number | undefined): number {
    if (price === undefined || price === null) {
        throw new InvalidOrder(
            "Metaculus createOrder requires `price` (the probability to forecast, between 0 and 1 exclusive).",
            "Metaculus",
        );
    }
    if (typeof price !== "number" || isNaN(price)) {
        throw new InvalidOrder(
            `Invalid price "${price}": must be a number between 0 and 1 exclusive.`,
            "Metaculus",
        );
    }
    if (price <= 0 || price >= 1) {
        throw new InvalidOrder(
            `Probability ${price} is out of range. Metaculus requires a value strictly between 0 and 1 (e.g., 0.01 to 0.99).`,
            "Metaculus",
        );
    }
    return price;
}

// ---------------------------------------------------------------------------
// Multiple-Choice Redistribution
// ---------------------------------------------------------------------------

/**
 * Redistribute multiple-choice probabilities when setting one category.
 *
 * When a user sets category X to probability P, the remaining categories
 * must be adjusted so all probabilities sum to 1.0. This function scales
 * the non-target categories proportionally.
 *
 * @param currentProbabilities  Map of category label -> current probability.
 * @param targetLabel           The category label being set.
 * @param targetProbability     The new probability for the target category.
 * @returns A new map with all probabilities summing to 1.0.
 *
 * @throws {InvalidOrder} If the target category doesn't exist or redistribution
 *                        is impossible (e.g., target = 1.0 with other categories).
 */
export function redistributeProbabilities(
    currentProbabilities: Record<string, number>,
    targetLabel: string,
    targetProbability: number,
): Record<string, number> {
    const labels = Object.keys(currentProbabilities);

    if (!labels.includes(targetLabel)) {
        throw new InvalidOrder(
            `Category "${targetLabel}" not found. Available categories: ${labels.join(", ")}`,
            "Metaculus",
        );
    }

    if (labels.length < 2) {
        return { [targetLabel]: 1.0 };
    }

    const remaining = 1.0 - targetProbability;
    if (remaining <= 0) {
        throw new InvalidOrder(
            `Cannot set probability to ${targetProbability}: other categories would have zero or negative probability. `
            + "Use a value less than 1.0.",
            "Metaculus",
        );
    }

    // Sum of current probabilities for non-target categories
    const otherSum = labels.reduce((sum, label) => {
        return label === targetLabel ? sum : sum + (currentProbabilities[label] ?? 0);
    }, 0);

    const result: Record<string, number> = {};

    if (otherSum <= 0) {
        // All other categories are at zero -- distribute evenly
        const otherCount = labels.length - 1;
        const each = remaining / otherCount;
        for (const label of labels) {
            result[label] = label === targetLabel ? targetProbability : each;
        }
    } else {
        // Proportional redistribution
        const scale = remaining / otherSum;
        for (const label of labels) {
            result[label] = label === targetLabel
                ? targetProbability
                : (currentProbabilities[label] ?? 0) * scale;
        }
    }

    // Normalize to fix floating-point drift: adjust the largest non-target category
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    const drift = sum - 1.0;
    if (Math.abs(drift) > 1e-12) {
        const largest = labels
            .filter((l) => l !== targetLabel)
            .sort((a, b) => result[b] - result[a])[0];
        if (largest) {
            result[largest] -= drift;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Synthetic Order Builder
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Order from forecast parameters.
 *
 * Metaculus forecasts are instant (no pending/open state), so the returned
 * order always has status "filled". The order ID is a generated string
 * since Metaculus doesn't return order IDs.
 */
function buildSyntheticOrder(
    params: CreateOrderParams,
    status: "filled" | "canceled",
): Order {
    return {
        id: `mc-${params.marketId}-${Date.now()}`,
        marketId: params.marketId,
        outcomeId: params.outcomeId,
        side: "buy",
        type: "market",
        price: params.price,
        amount: 1,
        status,
        filled: status === "filled" ? 1 : 0,
        remaining: 0,
        timestamp: Date.now(),
    };
}

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------

/**
 * Parameters for the internal createOrder function.
 *
 * Accepts the exchange's HTTP client and sign function so the trading
 * module doesn't need access to the full exchange instance.
 */
export interface CreateOrderContext {
    /** The exchange's axios instance (with rate limiting and logging). */
    http: AxiosInstance;
    /** Returns auth headers. Throws if no token is configured. */
    getAuthHeaders: () => Record<string, string>;
    /** Base URL for the Metaculus API. */
    baseUrl: string;
    /**
     * Fetch current market outcomes to read multiple-choice probabilities.
     * Only needed for multiple-choice questions.
     */
    fetchOutcomes?: (marketId: string) => Promise<MarketOutcome[]>;
}

/**
 * Submit a forecast on Metaculus, mapped from the unified createOrder interface.
 *
 * ## How the mapping works
 *
 * Metaculus is a reputation-based forecasting platform, not a financial exchange.
 * "Creating an order" means submitting a probability forecast on a question.
 *
 * | CreateOrderParams field | Metaculus meaning |
 * |------------------------|-------------------|
 * | `marketId`             | Post ID (for reference only) |
 * | `outcomeId`            | Encodes the question ID + type (see {@link parseOutcomeId}) |
 * | `price`                | The probability to forecast (0-1 exclusive) |
 * | `side`                 | Ignored -- forecasts are always "buy" (you submit a belief) |
 * | `type`                 | Ignored -- forecasts execute instantly (always "market") |
 * | `amount`               | Ignored -- Metaculus has no stake size |
 *
 * The returned {@link Order} is synthetic: Metaculus doesn't return order IDs
 * or track fill state. The order is always immediately "filled".
 *
 * ## Supported question types
 *
 * - **Binary**: Sets `probability_yes` directly from `price`.
 * - **Multiple-choice**: Sets the target category's probability and
 *   redistributes others proportionally to sum to 1.0.
 * - **Continuous/numeric/date**: NOT supported -- throws {@link InvalidOrder}
 *   because a 201-point CDF cannot be expressed as a single price value.
 *
 * ## Authentication
 *
 * Requires a Metaculus API token. Pass `{ apiToken: "..." }` when constructing
 * the MetaculusExchange. Without a token, this method throws
 * {@link AuthenticationError}.
 *
 * @throws {AuthenticationError} If no API token is configured.
 * @throws {InvalidOrder} If the question type is continuous or the price is invalid.
 * @throws {ValidationError} If the outcomeId format is unrecognizable.
 */
export async function createOrder(
    params: CreateOrderParams,
    ctx: CreateOrderContext,
): Promise<Order> {
    try {
        // 1. Validate auth
        const headers = ctx.getAuthHeaders();
        if (!headers.Authorization) {
            throw new AuthenticationError(
                'Metaculus forecast submission requires authentication. '
                + 'Pass { apiToken: "..." } when constructing MetaculusExchange.',
                "Metaculus",
            );
        }

        // 2. Parse outcomeId to determine question type
        const parsed = parseOutcomeId(params.outcomeId);

        // 3. Continuous questions can't be traded via createOrder
        if (parsed.type === "continuous") {
            throw new InvalidOrder(
                "Continuous/numeric/date questions cannot be traded via createOrder. "
                + "These require a 201-point CDF which cannot be expressed as a single price. "
                + "Use the Metaculus API directly for continuous forecasts.",
                "Metaculus",
            );
        }

        // 4. Validate price
        const probability = validateProbability(params.price);

        // 5. Log warnings for params that don't apply to Metaculus
        if (params.side && params.side !== "buy") {
            logger.warn(
                `Metaculus: Ignoring side="${params.side}" -- Metaculus forecasts are probability submissions, not buy/sell. `
                + "Set the probability via the `price` parameter instead.",
            );
        }
        if (params.type && params.type !== "market") {
            logger.warn(
                `Metaculus: Ignoring type="${params.type}" -- Metaculus forecasts execute instantly (no limit orders).`,
            );
        }

        // 6. Build the forecast payload
        let payload: any[];

        if (parsed.type === "binary") {
            payload = [{ question: parsed.questionId, probability_yes: probability }];
        } else {
            // Multiple-choice: need current probabilities to redistribute
            if (!ctx.fetchOutcomes) {
                throw new InvalidOrder(
                    "Multiple-choice forecast requires market outcome data but fetchOutcomes is not available.",
                    "Metaculus",
                );
            }

            const outcomes = await ctx.fetchOutcomes(params.marketId);
            const mcOutcomes = outcomes.filter(
                (o) => o.metadata?.question_type === "multiple_choice"
                    && o.metadata?.question_id === parsed.questionId,
            );

            if (mcOutcomes.length === 0) {
                throw new InvalidOrder(
                    `No multiple-choice outcomes found for question ${parsed.questionId}. `
                    + "Ensure the market has been fetched and the outcomeId is correct.",
                    "Metaculus",
                );
            }

            // Build current probability map from outcome labels
            const currentProbs: Record<string, number> = {};
            for (const o of mcOutcomes) {
                currentProbs[o.label] = o.price;
            }

            // Find the target category by index
            const targetOutcome = mcOutcomes.find(
                (o) => o.metadata?.choice_index === parsed.categoryIndex,
            );
            if (!targetOutcome) {
                throw new InvalidOrder(
                    `Category index ${parsed.categoryIndex} not found for question ${parsed.questionId}. `
                    + `Available indices: 0-${mcOutcomes.length - 1}.`,
                    "Metaculus",
                );
            }

            const redistributed = redistributeProbabilities(
                currentProbs,
                targetOutcome.label,
                probability,
            );

            payload = [{
                question: parsed.questionId,
                probability_yes_per_category: redistributed,
            }];
        }

        // 7. POST directly to the forecast endpoint.
        // We bypass callApi because the Metaculus forecast API expects an
        // array body, but the implicit API infrastructure always sends objects.
        await ctx.http.request({
            method: "POST",
            url: `${ctx.baseUrl}/questions/forecast/`,
            data: payload,
            headers: { "Content-Type": "application/json", ...headers },
        });

        // 8. Return synthetic order
        return buildSyntheticOrder(params, "filled");
    } catch (error: any) {
        // Re-throw pmxt errors directly; map everything else
        if (error.statusCode) throw error;
        throw metaculusErrorMapper.mapError(error);
    }
}
