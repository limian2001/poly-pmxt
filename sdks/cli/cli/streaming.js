"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.exchangeCredentialFlags = exports.feedHttpFlags = exports.streamControlFlags = exports.pmxtCredentialFlags = void 0;
exports.parseCommaList = parseCommaList;
exports.parseJsonObject = parseJsonObject;
exports.writeJson = writeJson;
exports.getAuthStorePath = getAuthStorePath;
exports.readAuthStore = readAuthStore;
exports.resolveCliCredentials = resolveCliCredentials;
exports.fetchPmxtData = fetchPmxtData;
exports.streamJsonl = streamJsonl;
exports.buildWebSocketUrl = buildWebSocketUrl;
// @ts-nocheck
const core_1 = require("@oclif/core");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
const ws_1 = __importDefault(require("ws"));
const color_js_1 = require("./colors.js");
const constants_js_1 = require("./constants.js");
const runtime_js_1 = require("./runtime.js");
const server_manager_js_1 = require("./server-manager.js");
const CREDENTIAL_KEYS = [
    "apiKey",
    "apiSecret",
    "apiToken",
    "passphrase",
    "privateKey",
    "proxyAddress",
    "signatureType",
];
exports.pmxtCredentialFlags = {
    "auth-profile": core_1.Flags.string({
        description: "Auth store profile to read after flags and environment variables",
    }),
    "auth-store": core_1.Flags.string({
        description: "Path to a PMXT CLI auth store JSON file",
    }),
    "base-url": core_1.Flags.string({
        description: "Advanced: override the PMXT API base URL",
        env: constants_js_1.ENV.BASE_URL,
    }),
    local: core_1.Flags.boolean({
        description: "Use a local PMXT instance",
    }),
    hosted: core_1.Flags.boolean({
        description: "Use the hosted PMXT API",
    }),
    "pmxt-api-key": core_1.Flags.string({
        description: "Hosted PMXT API key",
        env: constants_js_1.ENV.API_KEY,
    }),
    "no-suggest-hosted": core_1.Flags.boolean({
        description: "Do not show hosted PMXT suggestions when using local mode",
    }),
};
exports.feedHttpFlags = {
    ...exports.pmxtCredentialFlags,
    json: core_1.Flags.boolean({
        description: "Output raw response data as JSON.",
    }),
};
exports.streamControlFlags = {
    "max-messages": core_1.Flags.integer({
        description: "Stop after this many data messages.",
    }),
    "timeout-ms": core_1.Flags.integer({
        description: "Fail if no data message arrives within this many milliseconds.",
    }),
};
exports.exchangeCredentialFlags = {
    "api-key": core_1.Flags.string({
        description: "Exchange API key",
    }),
    "api-secret": core_1.Flags.string({
        description: "Exchange API secret",
    }),
    "api-token": core_1.Flags.string({
        description: "Exchange API token",
    }),
    credentials: core_1.Flags.string({
        description: "Exchange credentials as a JSON object",
    }),
    "funder-address": core_1.Flags.string({
        description: "Exchange funder address",
    }),
    passphrase: core_1.Flags.string({
        description: "Exchange API passphrase",
    }),
    "private-key": core_1.Flags.string({
        description: "Exchange private key",
    }),
    "proxy-address": core_1.Flags.string({
        description: "Alias for --funder-address",
    }),
    "signature-type": core_1.Flags.integer({
        description: "Exchange signature type",
    }),
    "venue-base-url": core_1.Flags.string({
        description: "Venue-native API base URL credential override",
    }),
    "wallet-address": core_1.Flags.string({
        description: "Exchange wallet address",
    }),
};
function parseCommaList(value) {
    if (!value)
        return undefined;
    const parsed = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return parsed.length > 0 ? parsed : undefined;
}
function parseJsonObject(value) {
    if (!value)
        return {};
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected params to be a JSON object");
    }
    return parsed;
}
function writeJson(value, stdout = process.stdout) {
    stdout.write(`${JSON.stringify(value)}\n`);
}
function getAuthStorePath(env = process.env) {
    return env.PMXT_AUTH_STORE_PATH || env.PMXT_AUTH_STORE || path_1.default.join(env.HOME || (0, os_1.homedir)(), ".pmxt", "cli-auth.json");
}
function readAuthStore(env = process.env) {
    const file = getAuthStorePath(env);
    if (!(0, fs_1.existsSync)(file))
        return {};
    try {
        return JSON.parse((0, fs_1.readFileSync)(file, "utf8"));
    }
    catch {
        return {};
    }
}
function resolveCliCredentials(flags, options = {}) {
    const env = options.env ?? process.env;
    const runtimeEnv = normalizeRuntimeEnv(env, options.targetName);
    const runtime = (0, runtime_js_1.resolveRuntimeConfig)(flags, runtimeEnv, options.targetKind === "exchange" ? options.targetName : "polymarket");
    return {
        baseUrl: runtime.baseUrl,
        color: (0, color_js_1.createColor)({ env, json: Boolean(flags.json), stream: process.stderr }),
        mode: runtime.mode,
        noSuggestHosted: Boolean(flags["no-suggest-hosted"]),
        ...(runtime.pmxtApiKey ? { pmxtApiKey: runtime.pmxtApiKey } : {}),
        ...(options.targetKind === "exchange" && runtime.credentials ? { exchangeCredentials: runtime.credentials } : {}),
    };
}
async function fetchPmxtData(pathname, credentials, query = {}) {
    let resolved = (0, constants_js_1.resolvePmxtBaseUrl)({
        baseUrl: credentials.baseUrl,
        pmxtApiKey: credentials.pmxtApiKey,
    });
    let localAccessToken;
    if (credentials.mode === "hosted" && resolved.isHosted && !resolved.pmxtApiKey) {
        throw new Error(authErrorMessage("missing api key", resolved.baseUrl, credentials.mode, credentials.color));
    }
    if (resolved.baseUrl === constants_js_1.LOCAL_URL || credentials.mode === "local") {
        const manager = new server_manager_js_1.ServerManager();
        try {
            await manager.ensureServerRunning();
        }
        catch (error) {
            throw new Error(localUnavailableMessage(error, credentials.color));
        }
        resolved = {
            ...resolved,
            baseUrl: `http://localhost:${manager.getRunningPort()}`,
            isHosted: false,
        };
        localAccessToken = manager.getAccessToken();
    }
    const url = new URL(pathname, ensureTrailingSlash(resolved.baseUrl));
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null)
            continue;
        url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
        headers: {
            ...(shouldSendHostedAuth(resolved, credentials.mode) ? { Authorization: `Bearer ${resolved.pmxtApiKey}` } : {}),
            ...(localAccessToken ? { "x-pmxt-access-token": localAccessToken } : {}),
        },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 401 || response.status === 403) {
            throw new Error(authErrorMessage(errorMessage(body) || response.statusText, resolved.baseUrl, credentials.mode, credentials.color));
        }
        throw new Error(errorMessage(body) || response.statusText);
    }
    const body = await response.json();
    if (body.success === false) {
        throw new Error(errorMessage(body) || "PMXT request failed");
    }
    return body.data;
}
async function streamJsonl(options) {
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const prepared = await prepareWebSocket(options.credentials);
    const id = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const message = {
        id,
        action: "subscribe",
        method: options.method,
        args: options.args,
        ...options.target,
        ...(options.credentials.exchangeCredentials ? { credentials: options.credentials.exchangeCredentials } : {}),
    };
    await new Promise((resolve, reject) => {
        const ws = new ws_1.default(prepared.url);
        let settled = false;
        let lines = 0;
        let timeout;
        const clearDataTimeout = () => {
            if (timeout)
                clearTimeout(timeout);
            timeout = undefined;
        };
        const armDataTimeout = () => {
            clearDataTimeout();
            if (options.timeoutMs === undefined)
                return;
            timeout = setTimeout(() => {
                finish(new Error(`Timed out after ${options.timeoutMs}ms waiting for streaming data`));
            }, options.timeoutMs);
        };
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearDataTimeout();
            process.off("SIGINT", onInterrupt);
            try {
                if (ws.readyState === ws_1.default.OPEN) {
                    ws.send(JSON.stringify({ ...message, action: "unsubscribe" }));
                    ws.close(1000, "client_done");
                }
            }
            catch {
                // ignore close failures
            }
            if (error)
                reject(error);
            else
                resolve();
        };
        const onInterrupt = () => finish();
        process.once("SIGINT", onInterrupt);
        ws.on("open", () => {
            ws.send(JSON.stringify(message));
            armDataTimeout();
        });
        ws.on("message", (raw) => {
            let parsed;
            try {
                parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
            }
            catch {
                return;
            }
            if (parsed.event === "error") {
                const text = errorMessage(parsed) || "Streaming error";
                stderr.write(`${text}\n`);
                finish(new Error(text));
                return;
            }
            if (parsed.event !== "data")
                return;
            writeJson(parsed, stdout);
            lines += 1;
            armDataTimeout();
            if (options.maxMessages !== undefined && lines >= options.maxMessages) {
                finish();
            }
        });
        ws.on("error", (error) => {
            finish(error instanceof Error ? error : new Error(String(error)));
        });
        ws.on("close", () => {
            finish();
        });
    });
}
function buildWebSocketUrl(baseUrl, auth) {
    const url = new URL("ws", ensureTrailingSlash(baseUrl));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (auth?.value) {
        url.searchParams.set(auth.name, auth.value);
    }
    return url.toString();
}
async function prepareWebSocket(credentials) {
    const resolved = (0, constants_js_1.resolvePmxtBaseUrl)({
        baseUrl: credentials.baseUrl,
        pmxtApiKey: credentials.pmxtApiKey,
    });
    if (resolved.isHosted) {
        if (!resolved.pmxtApiKey) {
            throw new Error(authErrorMessage("missing api key", resolved.baseUrl, credentials.mode, credentials.color));
        }
        return {
            url: buildWebSocketUrl(resolved.baseUrl, resolved.pmxtApiKey ? { name: "apiKey", value: resolved.pmxtApiKey } : undefined),
        };
    }
    if (resolved.baseUrl === constants_js_1.LOCAL_URL || credentials.mode === "local") {
        const manager = new server_manager_js_1.ServerManager();
        try {
            await manager.ensureServerRunning();
        }
        catch (error) {
            throw new Error(localUnavailableMessage(error, credentials.color));
        }
        const token = manager.getAccessToken();
        const baseUrl = `http://localhost:${manager.getRunningPort()}`;
        return {
            url: buildWebSocketUrl(baseUrl, token ? { name: "token", value: token } : undefined),
        };
    }
    return {
        url: buildWebSocketUrl(resolved.baseUrl, shouldSendHostedAuth(resolved, credentials.mode)
            ? { name: "apiKey", value: resolved.pmxtApiKey }
            : undefined),
    };
}
function clean(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function ensureTrailingSlash(value) {
    return value.endsWith("/") ? value : `${value}/`;
}
function isLoopbackUrl(baseUrl) {
    try {
        const parsed = new URL(baseUrl);
        return parsed.protocol === "http:"
            && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1");
    }
    catch {
        return false;
    }
}
function shouldSendHostedAuth(resolved, mode) {
    if (!resolved.pmxtApiKey || mode === "local")
        return false;
    return resolved.isHosted || !isLoopbackUrl(resolved.baseUrl);
}
function envPrefix(value) {
    return (value || "EXCHANGE").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}
function errorMessage(body) {
    const error = body?.error;
    if (typeof error === "string")
        return error;
    if (error && typeof error.message === "string")
        return error.message;
    if (typeof body?.message === "string")
        return body.message;
    return undefined;
}
function commandLine(colors, command) {
    return `  ${colors.command(command)}`;
}
function labeledValue(colors, label, value) {
    return `${colors.label(label)} ${colors.url(value)}`;
}
function authErrorMessage(message, baseUrl, mode = "hosted", colors = (0, color_js_1.createColor)({ enabled: false })) {
    if (mode === "local") {
        return [
            `${colors.error("Local PMXT rejected the request")}: ${message || "missing or invalid local access token"}.`,
            "",
            labeledValue(colors, "Endpoint:", baseUrl),
            "",
            colors.warning("Try restarting the local PMXT instance:"),
            commandLine(colors, "pmxt server restart"),
            "",
            colors.warning("Or use hosted PMXT:"),
            commandLine(colors, "pmxt auth login --api-key <pmxt_api_key>"),
            commandLine(colors, "pmxt <exchange> <command> --hosted"),
        ].join("\n");
    }
    const heading = mode === "hosted" ? "Hosted PMXT needs an API key" : "PMXT endpoint needs authentication";
    return [
        `${colors.error(heading)}: ${message || "the key was missing or rejected"}.`,
        "",
        labeledValue(colors, "Endpoint:", baseUrl),
        "",
        colors.warning("Hosted:"),
        commandLine(colors, "pmxt auth login --api-key <pmxt_api_key>"),
        commandLine(colors, "PMXT_API_KEY=<pmxt_api_key> pmxt <exchange> <command>"),
        commandLine(colors, "pmxt <exchange> <command> --hosted --pmxt-api-key <pmxt_api_key>"),
        "",
        colors.warning("Local:"),
        commandLine(colors, "pmxt <exchange> <command> --local"),
        commandLine(colors, "npm install -g pmxt-core"),
        "",
        `Check auth with: ${colors.command("pmxt auth status")}`,
    ].join("\n");
}
function localUnavailableMessage(error, colors = (0, color_js_1.createColor)({ enabled: false })) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
        colors.error("Local PMXT instance is not available."),
        "",
        colors.dim(detail),
        "",
        colors.warning("Use hosted PMXT instead:"),
        commandLine(colors, "pmxt auth login --api-key <pmxt_api_key>"),
        commandLine(colors, "pmxt <exchange> <command> --hosted"),
        "",
        colors.warning("Hosted PMXT is faster for indexed search, router matches, and enterprise data."),
    ].join("\n");
}
function getStoreBuckets(store, profile, options) {
    const buckets = [];
    const targetName = options.targetName;
    const plural = options.targetKind ? `${options.targetKind}s` : undefined;
    if (profile) {
        const profileStore = readNestedValue(store, `profiles.${profile}`);
        buckets.push(readNestedValue(profileStore, `${plural}.${targetName}`));
        buckets.push(readNestedValue(profileStore, targetName || ""));
        buckets.push(profileStore);
    }
    buckets.push(readNestedValue(store, `${plural}.${targetName}`));
    buckets.push(readNestedValue(store, `${options.targetKind}.${targetName}`));
    buckets.push(readNestedValue(store, targetName || ""));
    buckets.push(readNestedValue(store, "default"));
    buckets.push(readNestedValue(store, "credentials"));
    buckets.push(store);
    return buckets.filter((bucket) => {
        return !!bucket && typeof bucket === "object" && !Array.isArray(bucket);
    });
}
function parseOptionalNumber(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function normalizeRuntimeEnv(env, targetName) {
    const normalized = env.PMXT_AUTH_STORE_PATH && !env.PMXT_AUTH_STORE
        ? { ...env, PMXT_AUTH_STORE: env.PMXT_AUTH_STORE_PATH }
        : { ...env };
    if (!targetName)
        return normalized;
    const prefix = envPrefix(targetName);
    for (const suffix of [
        "API_KEY",
        "API_SECRET",
        "PASSPHRASE",
        "API_TOKEN",
        "PRIVATE_KEY",
        "SIGNATURE_TYPE",
        "FUNDER_ADDRESS",
        "PROXY_ADDRESS",
        "WALLET_ADDRESS",
        "BASE_URL",
    ]) {
        const scoped = `PMXT_${prefix}_${suffix}`;
        const runtime = `${prefix}_${suffix}`;
        if (normalized[scoped] && !normalized[runtime]) {
            normalized[runtime] = normalized[scoped];
        }
    }
    return normalized;
}
function readNestedValue(obj, key) {
    if (!obj || typeof obj !== "object" || !key)
        return undefined;
    let current = obj;
    for (const part of key.split(".")) {
        if (!current || typeof current !== "object")
            return undefined;
        current = current[part];
    }
    return current;
}
