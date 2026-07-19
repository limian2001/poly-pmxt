import { MarketOutcome } from "../../types";

export function clampBaoziPrice(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function normalizeBaoziOutcomes(outcomes: MarketOutcome[]): void {
  const sum = outcomes.reduce((acc, item) => acc + item.price, 0);
  if (sum <= 0) {
    return;
  }

  for (const outcome of outcomes) {
    outcome.price = outcome.price / sum;
  }
}
