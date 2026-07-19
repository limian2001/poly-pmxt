/**
 * Schema drift test: verifies that field names in the TypeScript SDK models
 * and Python SDK models match the source-of-truth interfaces in core/src/types.ts.
 *
 * If a field is added to types.ts but not to an SDK, this test fails with
 * the exact field name and which SDK is missing it.
 *
 * Parses source files with regex — intentionally simple and fast. Does not
 * need a TypeScript compiler or Python AST parser.
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Parsers: extract field names from source files
// ---------------------------------------------------------------------------

/**
 * Extract field names from a TypeScript interface block.
 * Matches lines like: `fieldName: Type` or `fieldName?: Type`
 */
function extractTsInterfaceFields(source: string, interfaceName: string): string[] {
    // Match `interface Foo {` ... `}`
    const interfaceRe = new RegExp(
        `interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`,
    );
    const match = source.match(interfaceRe);
    if (!match) throw new Error(`Interface ${interfaceName} not found`);
    const body = match[1]!;

    const fields: string[] = [];
    const fieldRe = /^\s+(\w+)\??:\s/gm;
    let m;
    while ((m = fieldRe.exec(body)) !== null) {
        fields.push(m[1]!);
    }
    return fields;
}

/**
 * Extract field names from a Python dataclass.
 * Matches lines like: `field_name: Type` or `field_name: Optional[Type] = None`
 */
function extractPyDataclassFields(source: string, className: string): string[] {
    // Find class block — from `class Foo:` to the next `class ` or `def ` at column 0
    const classRe = new RegExp(
        `class\\s+${className}[^:]*:[\\s\\S]*?(?=\\nclass\\s|\\ndef\\s|$)`,
    );
    const match = source.match(classRe);
    if (!match) throw new Error(`Class ${className} not found`);
    const body = match[0];

    const fields: string[] = [];
    // Match `    field_name: Type` (4-space indented, not a method/decorator)
    const fieldRe = /^ {4}(\w+)\s*:/gm;
    let m;
    while ((m = fieldRe.exec(body)) !== null) {
        const name = m[1]!;
        // Skip dunder fields, decorators, methods
        if (name.startsWith('_')) continue;
        fields.push(name);
    }
    return fields;
}

// ---------------------------------------------------------------------------
// camelCase <-> snake_case conversion for cross-language comparison
// ---------------------------------------------------------------------------

/** Convert camelCase to snake_case. Handles special cases like volume24h. */
function camelToSnake(name: string): string {
    // Special cases that the simple algorithm gets wrong
    const SPECIAL: Record<string, string> = {
        volume24h: 'volume_24h',
        priceChange24h: 'price_change_24h',
        unrealizedPnL: 'unrealized_pnl',
        realizedPnL: 'realized_pnl',
    };
    if (SPECIAL[name]) return SPECIAL[name];

    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
}

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------

const TYPES_TS = path.join(__dirname, '../../src/types.ts');
const TS_SDK_MODELS = path.join(__dirname, '../../../sdks/typescript/pmxt/models.ts');
const PY_SDK_MODELS = path.join(__dirname, '../../../sdks/python/pmxt/models.py');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Schema drift: types.ts vs SDK models', () => {
    const typesSource = fs.readFileSync(TYPES_TS, 'utf8');
    const tsSDKSource = fs.readFileSync(TS_SDK_MODELS, 'utf8');
    const pySDKSource = fs.readFileSync(PY_SDK_MODELS, 'utf8');

    // --- UnifiedMarket ---

    const coreMarketFields = extractTsInterfaceFields(typesSource, 'UnifiedMarket');
    const tsSDKMarketFields = extractTsInterfaceFields(tsSDKSource, 'UnifiedMarket');
    const pySDKMarketFields = extractPyDataclassFields(pySDKSource, 'UnifiedMarket');

    test('core UnifiedMarket has fields (sanity check)', () => {
        expect(coreMarketFields.length).toBeGreaterThan(10);
    });

    test('TS SDK UnifiedMarket has every field from types.ts', () => {
        const missing = coreMarketFields.filter(f => !tsSDKMarketFields.includes(f));
        expect(missing).toEqual([]);
    });

    test('Python SDK UnifiedMarket has every field from types.ts', () => {
        const coreAsSnake = coreMarketFields.map(f => camelToSnake(f));
        const missing = coreAsSnake.filter(f => !pySDKMarketFields.includes(f));
        expect(missing).toEqual([]);
    });

    // --- MarketOutcome ---

    const coreOutcomeFields = extractTsInterfaceFields(typesSource, 'MarketOutcome');
    const tsSDKOutcomeFields = extractTsInterfaceFields(tsSDKSource, 'MarketOutcome');
    const pySDKOutcomeFields = extractPyDataclassFields(pySDKSource, 'MarketOutcome');

    test('TS SDK MarketOutcome has every field from types.ts', () => {
        const missing = coreOutcomeFields.filter(f => !tsSDKOutcomeFields.includes(f));
        expect(missing).toEqual([]);
    });

    test('Python SDK MarketOutcome has every field from types.ts', () => {
        const coreAsSnake = coreOutcomeFields.map(f => camelToSnake(f));
        const missing = coreAsSnake.filter(f => !pySDKOutcomeFields.includes(f));
        expect(missing).toEqual([]);
    });

    // --- UnifiedEvent ---

    const coreEventFields = extractTsInterfaceFields(typesSource, 'UnifiedEvent');
    const tsSDKEventFields = extractTsInterfaceFields(tsSDKSource, 'UnifiedEvent');
    const pySDKEventFields = extractPyDataclassFields(pySDKSource, 'UnifiedEvent');

    test('TS SDK UnifiedEvent has every field from types.ts', () => {
        const missing = coreEventFields.filter(f => !tsSDKEventFields.includes(f));
        expect(missing).toEqual([]);
    });

    test('Python SDK UnifiedEvent has every field from types.ts', () => {
        const coreAsSnake = coreEventFields.map(f => camelToSnake(f));
        const missing = coreAsSnake.filter(f => !pySDKEventFields.includes(f));
        expect(missing).toEqual([]);
    });

    // --- Reverse check: SDK fields not in core (detect orphaned fields) ---

    test('TS SDK UnifiedMarket has no orphaned fields vs types.ts', () => {
        const extra = tsSDKMarketFields.filter(f => !coreMarketFields.includes(f));
        expect(extra).toEqual([]);
    });

    test('Python SDK UnifiedMarket has no orphaned fields vs types.ts', () => {
        const coreAsSnake = new Set(coreMarketFields.map(f => camelToSnake(f)));
        const extra = pySDKMarketFields.filter(f => !coreAsSnake.has(f));
        expect(extra).toEqual([]);
    });
});
