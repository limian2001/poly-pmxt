import { ExchangeCredentials } from '../../BaseExchange';

export class MyriadAuth {
    private credentials: ExchangeCredentials;

    constructor(credentials: ExchangeCredentials) {
        this.credentials = credentials;
        this.validateCredentials();
    }

    private validateCredentials() {
        if (!this.credentials.apiKey && !this.credentials.privateKey) {
            throw new Error('Myriad requires an apiKey or privateKey for authentication');
        }
    }

    getHeaders(): Record<string, string> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.credentials.apiKey) {
            headers['x-api-key'] = this.credentials.apiKey;
        }
        return headers;
    }

    get walletAddress(): string | undefined {
        return this.credentials.privateKey;
    }
}
