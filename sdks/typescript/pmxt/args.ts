export function buildArgsWithOptionalOptions<T>(primary?: T): T[] {
    return primary !== undefined ? [primary] : [];
}
