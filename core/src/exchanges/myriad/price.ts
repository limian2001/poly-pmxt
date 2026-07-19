export function resolveMyriadPrice(event: any): number {
  const shares = Math.max(Number(event.shares || 1), 1);
  return Number(event.value || 0) / shares;
}
