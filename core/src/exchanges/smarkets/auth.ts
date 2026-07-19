
import { ExchangeCredentials } from '../../BaseExchange';

/** Default session TTL in milliseconds (30 minutes). */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Safety margin subtracted from TTL to avoid using an about-to-expire token. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Manages Smarkets session-based authentication.
 *
 * Authentication flow:
 * 1. POST /v3/sessions/ with username (email) and password to obtain a session token.
 * 2. If the response `factor` is 'totp', POST /v3/sessions/verify/ with the TOTP code.
 * 3. Once complete, use the token in the Authorization header as `Session-Token <token>`.
 *
 * This class does NOT make HTTP calls directly. The exchange index.ts handles the
 * async login flow via callApi and calls `setToken()` with the result.
 * `getHeaders()` returns the session token header synchronously.
 */
export class SmarketsAuth {
    private readonly credentials: ExchangeCredentials;
    private sessionToken: string | null = null;
    private tokenExpiry: number = 0;

    constructor(credentials: ExchangeCredentials) {
        this.credentials = credentials;
        this.validateCredentials();
    }

    private validateCredentials(): void {
        if (!this.credentials.apiKey) {
            throw new Error(
                'Smarkets requires an apiKey (email address) for authentication'
            );
        }
        if (!this.credentials.privateKey) {
            throw new Error(
                'Smarkets requires a privateKey (account password) for authentication'
            );
        }
    }

    /**
     * Returns the username (email) used for session creation.
     */
    getUsername(): string {
        if (!this.credentials.apiKey) {
            throw new Error('[smarkets] apiKey (username) is required');
        }
        return this.credentials.apiKey;
    }

    /**
     * Returns the password used for session creation.
     */
    getPassword(): string {
        if (!this.credentials.privateKey) {
            throw new Error('[smarkets] privateKey (password) is required');
        }
        return this.credentials.privateKey;
    }

    /**
     * Stores the session token and its expiry after a successful login.
     *
     * @param token  The session token returned by /v3/sessions/.
     * @param expiry The `stop` datetime string from the API response (ISO 8601).
     */
    setToken(token: string, expiry: string): void {
        this.sessionToken = token;

        const expiryTime = new Date(expiry).getTime();
        if (isNaN(expiryTime)) {
            // Fall back to a 30-minute TTL from now if the expiry cannot be parsed.
            this.tokenExpiry = Date.now() + SESSION_TTL_MS - EXPIRY_MARGIN_MS;
        } else {
            this.tokenExpiry = expiryTime - EXPIRY_MARGIN_MS;
        }
    }

    /**
     * Returns true if the session token is present and has not expired.
     */
    isAuthenticated(): boolean {
        return this.sessionToken !== null && Date.now() < this.tokenExpiry;
    }

    /**
     * Returns true if the token has expired or is about to expire.
     */
    isExpired(): boolean {
        if (this.sessionToken === null) {
            return true;
        }
        return Date.now() >= this.tokenExpiry;
    }

    /**
     * Generates the required headers for an authenticated request.
     *
     * @param _method The HTTP method (unused, kept for interface consistency with sign()).
     * @param _path   The request path (unused, kept for interface consistency with sign()).
     * @returns An object containing the Authorization header with the session token.
     * @throws Error if no valid session token is available.
     */
    getHeaders(_method: string, _path: string): Record<string, string> {
        if (!this.sessionToken) {
            throw new Error(
                'Smarkets session token is not set. Call the login endpoint first.'
            );
        }

        return {
            'Authorization': `Session-Token ${this.sessionToken}`,
            'Content-Type': 'application/json',
        };
    }

    /**
     * Clears the stored session token (e.g. after logout or for testing).
     */
    reset(): void {
        this.sessionToken = null;
        this.tokenExpiry = 0;
    }
}
