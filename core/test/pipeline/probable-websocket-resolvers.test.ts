import fs from 'fs';
import path from 'path';

describe('Probable WebSocket resolver queues', () => {
    it('does not rely on a non-null assertion when queueing order book watchers', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../src/exchanges/probable/websocket.ts'),
            'utf8',
        );

        expect(source).not.toMatch(/orderBookResolvers\.get\([^)]*\)!/);
    });
});
