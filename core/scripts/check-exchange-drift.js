#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-exchange-drift.js
//
// Walks core/src/exchanges/ to find every concrete exchange implementation
// and asserts that each one is exposed by EVERY layer that a consumer can
// see it through:
//   1. The openapi `enum` of source_exchange values in generate-openapi.js
//   2. The TypeScript SDK class definitions at sdks/typescript/pmxt/client.ts
//   3. The TypeScript package entry point at sdks/typescript/index.ts
//      (re-export allowlist + the `pmxt` default export object)
//   4. The Python SDK class definitions at sdks/python/pmxt/_exchanges.py
//   5. The Python package entry point at sdks/python/pmxt/__init__.py
//      (the `from ._exchanges import ...` line and the `__all__` list)
//
// Exits non-zero with a per-layer table of missing entries if anything has
// drifted. The point is to make it impossible to merge a new exchange that
// doesn't reach the consumer SDKs — and impossible to add an SDK class
// that doesn't get re-exported from the package entry point.
//
// Run from repo root: `node core/scripts/check-exchange-drift.js`
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PATHS = {
    coreExchangesDir: path.join(REPO_ROOT, 'core', 'src', 'exchanges'),
    openapiGenerator: path.join(REPO_ROOT, 'core', 'scripts', 'generate-openapi.js'),
    tsClient: path.join(REPO_ROOT, 'sdks', 'typescript', 'pmxt', 'client.ts'),
    tsIndex: path.join(REPO_ROOT, 'sdks', 'typescript', 'index.ts'),
    pyExchanges: path.join(REPO_ROOT, 'sdks', 'python', 'pmxt', '_exchanges.py'),
    pyInit: path.join(REPO_ROOT, 'sdks', 'python', 'pmxt', '__init__.py'),
};

// Tolerant slug compare: lowercase and strip - / _ so kebab/snake/Pascal
// variants of the same name collapse to one canonical form.
function canonical(slug) {
    return String(slug).toLowerCase().replace(/[-_]/g, '');
}

function discoverCoreExchanges() {
    const entries = fs.readdirSync(PATHS.coreExchangesDir, { withFileTypes: true });
    const exchanges = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const indexPath = path.join(PATHS.coreExchangesDir, entry.name, 'index.ts');
        if (!fs.existsSync(indexPath)) continue;
        const source = fs.readFileSync(indexPath, 'utf8');
        // Match `export class FooExchange extends PredictionMarketExchange`
        // or `extends KalshiExchange` (kalshi-demo subclasses kalshi).
        const m = source.match(
            /export\s+class\s+([A-Z][A-Za-z0-9]*Exchange)\s+extends\s+(PredictionMarketExchange|KalshiExchange)/
        );
        if (!m) continue;
        exchanges.push({
            dir: entry.name,
            className: m[1],
        });
    }
    return exchanges.sort((a, b) => a.dir.localeCompare(b.dir));
}

function readOpenapiEnum() {
    const source = fs.readFileSync(PATHS.openapiGenerator, 'utf8');
    // Find the source_exchange enum line. We accept the first enum that
    // contains 'polymarket' and 'kalshi' to avoid coupling to a specific
    // line number.
    const enumRegex = /enum:\s*\[([^\]]+)\]/g;
    let match;
    while ((match = enumRegex.exec(source)) !== null) {
        const inside = match[1];
        if (inside.includes("'polymarket'") && inside.includes("'kalshi'")) {
            return inside
                .split(',')
                .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter((s) => s.length > 0);
        }
    }
    throw new Error('Could not find source_exchange enum in generate-openapi.js');
}

function readTsClientExchanges() {
    const source = fs.readFileSync(PATHS.tsClient, 'utf8');
    const re = /export\s+class\s+([A-Z][A-Za-z0-9]*)\s+extends\s+Exchange\b/g;
    const out = [];
    let m;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
    return out;
}

function readPythonExchanges() {
    const source = fs.readFileSync(PATHS.pyExchanges, 'utf8');
    const re = /^class\s+([A-Z][A-Za-z0-9]*)\s*\(\s*Exchange\s*\)/gm;
    const out = [];
    let m;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
    return out;
}

// The TS package entry point has its own re-export allowlist AND a default
// export object literal — both of which silently drop classes that aren't
// listed. We require every concrete exchange class to appear in BOTH.
function readTsIndexExports() {
    const source = fs.readFileSync(PATHS.tsIndex, 'utf8');
    // Pull every identifier from `export { ... } from "./pmxt/client.js"`.
    const exportRe = /export\s*\{([^}]+)\}\s*from\s*["']\.\/pmxt\/client\.js["']/g;
    const exported = new Set();
    let m;
    while ((m = exportRe.exec(source)) !== null) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name) exported.add(name);
        }
    }
    // Also confirm membership in the `const pmxt = { ... }` default export
    // object so `import pmxt from 'pmxtjs'; pmxt.Foo` works.
    const defaultObjMatch = source.match(/const\s+pmxt\s*=\s*\{([\s\S]*?)\};/);
    const inDefault = new Set();
    if (defaultObjMatch) {
        for (const line of defaultObjMatch[1].split(/[,\n]/)) {
            const name = line.trim().replace(/[:].*$/, '').trim();
            if (/^[A-Z][A-Za-z0-9]*$/.test(name)) inDefault.add(name);
        }
    }
    // Only return names present in BOTH so a missing entry in either
    // surface fails the check.
    return Array.from(exported).filter((n) => inDefault.has(n));
}

// The Python package entry point also has two parallel allowlists: the
// `from ._exchanges import ...` line and the `__all__` tuple.
function readPythonInitExports() {
    const source = fs.readFileSync(PATHS.pyInit, 'utf8');
    const importMatch = source.match(/from\s+\._exchanges\s+import\s+([^\n#]+)/);
    const imported = new Set();
    if (importMatch) {
        for (const part of importMatch[1].split(',')) {
            const name = part.trim();
            if (/^[A-Z][A-Za-z0-9]*$/.test(name)) imported.add(name);
        }
    }
    const allMatch = source.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
    const inAll = new Set();
    if (allMatch) {
        const stringRe = /["']([A-Z][A-Za-z0-9]*)["']/g;
        let m;
        while ((m = stringRe.exec(allMatch[1])) !== null) inAll.add(m[1]);
    }
    return Array.from(imported).filter((n) => inAll.has(n));
}

function findMissing(coreExchanges, layerSlugs) {
    const layerCanonical = new Set(layerSlugs.map(canonical));
    return coreExchanges.filter((ex) => !layerCanonical.has(canonical(ex.dir)));
}

function main() {
    const core = discoverCoreExchanges();
    if (core.length === 0) {
        console.error('No exchanges discovered in core/src/exchanges/. Aborting.');
        process.exit(2);
    }

    const openapiEnum = readOpenapiEnum();
    const tsClasses = readTsClientExchanges();
    const tsIndexExports = readTsIndexExports();
    const pyClasses = readPythonExchanges();
    const pyInitExports = readPythonInitExports();

    const layers = [
        { name: 'openapi enum (generate-openapi.js)', slugs: openapiEnum },
        { name: 'TypeScript SDK classes (sdks/typescript/pmxt/client.ts)', slugs: tsClasses },
        { name: 'TypeScript package entry (sdks/typescript/index.ts)', slugs: tsIndexExports },
        { name: 'Python SDK classes (sdks/python/pmxt/_exchanges.py)', slugs: pyClasses },
        { name: 'Python package entry (sdks/python/pmxt/__init__.py)', slugs: pyInitExports },
    ];

    console.log(`Discovered ${core.length} exchanges in core/src/exchanges/:`);
    for (const ex of core) {
        console.log(`  - ${ex.dir} (${ex.className})`);
    }
    console.log('');

    let drifted = false;
    for (const layer of layers) {
        const missing = findMissing(core, layer.slugs);
        if (missing.length === 0) {
            console.log(`OK   ${layer.name}: all ${core.length} exchanges present`);
        } else {
            drifted = true;
            console.log(`FAIL ${layer.name}: missing ${missing.length}`);
            for (const ex of missing) {
                console.log(`       - ${ex.dir} (${ex.className})`);
            }
        }
    }

    if (drifted) {
        console.log('');
        console.log('Exchange drift detected. Every exchange in core/src/exchanges/');
        console.log('must be surfaced through the openapi enum AND both consumer SDKs,');
        console.log('otherwise users of pmxtjs / pmxt-py will silently lose access to it.');
        process.exit(1);
    }

    console.log('');
    console.log('No drift. All layers in sync.');
}

main();
