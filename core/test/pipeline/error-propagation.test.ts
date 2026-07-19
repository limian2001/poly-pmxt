/**
 * Pipeline contract test: verifies that errors propagate correctly through the
 * PMXT server and that the server remains stable after encountering bad input.
 *
 * All tests run against an in-memory HTTP server started with createApp() so
 * no real exchange credentials are required and no network calls are made.
 */

import http from 'http';
import { createApp } from '../../src/server/app';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
    const app = createApp({ accessToken: undefined });
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
        server.listen(0, () => resolve());
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawResponse {
    status: number;
    body: unknown;
}

async function get(path: string): Promise<RawResponse> {
    const res = await fetch(`${baseUrl}${path}`);
    const body = await res.json();
    return { status: res.status, body };
}

async function post(path: string, payload: unknown): Promise<RawResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = await res.json();
    return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Error propagation: unknown exchange', () => {
    test('GET /api/nonexistent/fetchMarkets returns a non-success response with status >= 400', async () => {
        const { status, body } = await get('/api/nonexistent/fetchMarkets');

        expect(status).toBeGreaterThanOrEqual(400);
        expect((body as any).success).toBe(false);
    });

    test('error message mentions the unknown exchange name', async () => {
        const { body } = await get('/api/nonexistent/fetchMarkets');

        // The error field may be a string or an object with a message property.
        const errorText = JSON.stringify((body as any).error);
        expect(errorText).toMatch(/nonexistent/i);
    });
});

describe('Error propagation: unknown method via GET', () => {
    test('GET /api/mock/nonExistentMethod returns 404 or 405', async () => {
        const { status } = await get('/api/mock/nonExistentMethod');
        expect([404, 405]).toContain(status);
    });

    test('error body has success: false and a non-empty error message', async () => {
        const { body } = await get('/api/mock/nonExistentMethod');
        expect((body as any).success).toBe(false);

        const errorText = JSON.stringify((body as any).error);
        expect(errorText.length).toBeGreaterThan(0);
    });
});

describe('Error propagation: unknown method via POST', () => {
    test('POST /api/mock/nonExistentMethod returns 404', async () => {
        const { status } = await post('/api/mock/nonExistentMethod', { args: [] });
        expect(status).toBe(404);
    });

    test('POST unknown method body has success: false', async () => {
        const { body } = await post('/api/mock/nonExistentMethod', { args: [] });
        expect((body as any).success).toBe(false);
    });
});

describe('Resilience: invalid query params do not crash the server', () => {
    test('GET /api/mock/fetchMarkets?limit=notanumber returns a response (not a crash)', async () => {
        // The server may handle the bad param gracefully (return data) or
        // return an error — either is acceptable. What must NOT happen is an
        // unhandled exception that leaves the connection open forever or
        // returns no HTTP response at all.
        const { status } = await get('/api/mock/fetchMarkets?limit=notanumber');
        expect(status).toBeGreaterThanOrEqual(200);
        expect(status).toBeLessThan(600);
    });

    test('server is still responsive after bad query params', async () => {
        // Fire the bad request first, then confirm a known-good request works.
        await get('/api/mock/fetchMarkets?limit=notanumber');

        const { status, body } = await get('/api/mock/fetchMarkets?limit=3');
        expect(status).toBe(200);
        expect((body as any).success).toBe(true);
        expect(Array.isArray((body as any).data)).toBe(true);
    });
});

describe('Health check', () => {
    test('GET /health returns { status: "ok" }', async () => {
        const { status, body } = await get('/health');
        expect(status).toBe(200);
        expect((body as any).status).toBe('ok');
    });

    test('GET /health response does not require authentication', async () => {
        // createApp was started without an accessToken, so this just
        // verifies the endpoint is always public.
        const res = await fetch(`${baseUrl}/health`);
        expect(res.ok).toBe(true);
    });
});

describe('POST with credentials body', () => {
    test('POST /api/mock/fetchMarkets with empty credentials object returns market data', async () => {
        const { status, body } = await post('/api/mock/fetchMarkets', { args: [{}] });
        expect(status).toBe(200);
        expect((body as any).success).toBe(true);
        expect(Array.isArray((body as any).data)).toBe(true);
        expect((body as any).data.length).toBeGreaterThan(0);
    });
});

describe('GET method accessible via POST (backward compat)', () => {
    test('POST /api/mock/fetchMarkets with limit arg returns data', async () => {
        const { status, body } = await post('/api/mock/fetchMarkets', {
            args: [{ limit: 5 }],
        });
        expect(status).toBe(200);
        expect((body as any).success).toBe(true);
        expect(Array.isArray((body as any).data)).toBe(true);
        expect((body as any).data.length).toBeGreaterThan(0);
    });

    test('each market in POST response has required fields', async () => {
        const { body } = await post('/api/mock/fetchMarkets', {
            args: [{ limit: 5 }],
        });
        const markets: any[] = (body as any).data;
        for (const market of markets) {
            expect(typeof market.marketId).toBe('string');
            expect(typeof market.title).toBe('string');
            expect(Array.isArray(market.outcomes)).toBe(true);
        }
    });
});

describe('Write method blocked via GET', () => {
    test('GET /api/mock/createOrder returns 405', async () => {
        // createOrder is classified as "post" in method-verbs.json so the GET
        // handler must reject it with Method Not Allowed.
        const { status } = await get('/api/mock/createOrder');
        expect(status).toBe(405);
    });

    test('GET /api/mock/createOrder body has success: false', async () => {
        const { body } = await get('/api/mock/createOrder');
        expect((body as any).success).toBe(false);
    });

    test('GET /api/mock/createOrder error message mentions GET or POST', async () => {
        const { body } = await get('/api/mock/createOrder');
        const errorText = JSON.stringify((body as any).error);
        // The server message says "Use POST /api/:exchange/createOrder instead"
        expect(errorText).toMatch(/POST|GET/i);
    });
});
