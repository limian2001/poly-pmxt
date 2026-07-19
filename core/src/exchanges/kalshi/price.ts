export function fromKalshiCents(priceInCents: number): number {
  return priceInCents / 100;
}

export function invertKalshiCents(priceInCents: number): number {
  return 1 - priceInCents / 100;
}

export function invertKalshiUnified(price: number): number {
  return 1 - price;
}
