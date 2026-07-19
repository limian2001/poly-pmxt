#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cliRoot = path.resolve(__dirname, "..");
const { HOSTED_URL, LOCAL_URL } = require(path.join(cliRoot, "cli", "constants.js"));
const { ServerManager } = require(path.join(cliRoot, "cli", "server-manager.js"));
const { resolveRuntimeConfig, runVenueMethod } = require(path.join(cliRoot, "cli", "runtime.js"));

const originalFetch = global.fetch;
const originalEnsure = ServerManager.prototype.ensureServerRunning;
const originalPort = ServerManager.prototype.getRunningPort;
const originalToken = ServerManager.prototype.getAccessToken;
const envKeys = [
  "PMXT_API_KEY",
  "PMXT_BASE_URL",
  "PMXT_AUTH_STORE",
  "PMXT_AUTH_STORE_PATH",
  "PMXT_CLI_NO_SUGGEST_HOSTED",
  "FORCE_COLOR",
  "NO_COLOR",
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmxt-cli-runtime-"));
const authStore = path.join(tempDir, "auth.json");
fs.writeFileSync(authStore, "{}\n", { mode: 0o600 });

function cleanEnv(extra = {}) {
  return {
    HOME: tempDir,
    PMXT_AUTH_STORE_PATH: authStore,
    PMXT_CLI_NO_SUGGEST_HOSTED: "1",
    ...extra,
  };
}

function resetProcessEnv(extra = {}) {
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, cleanEnv(extra));
}

function okResponse(data = []) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({ success: true, data }),
  };
}

async function verifyRuntimeModes() {
  assert.deepEqual(
    {
      mode: resolveRuntimeConfig({}, cleanEnv()).mode,
      baseUrl: resolveRuntimeConfig({}, cleanEnv()).baseUrl,
    },
    { mode: "local", baseUrl: LOCAL_URL },
    "commands without hosted auth should default to local mode",
  );

  assert.deepEqual(
    {
      mode: resolveRuntimeConfig({}, cleanEnv({ PMXT_API_KEY: "pmxt_test" })).mode,
      baseUrl: resolveRuntimeConfig({}, cleanEnv({ PMXT_API_KEY: "pmxt_test" })).baseUrl,
    },
    { mode: "hosted", baseUrl: HOSTED_URL },
    "commands with hosted auth should default to hosted mode",
  );

  assert.throws(
    () => resolveRuntimeConfig({ local: true, hosted: true }, cleanEnv()),
    /Choose either --local or --hosted/,
    "--local and --hosted should be mutually exclusive",
  );

  assert.throws(
    () => resolveRuntimeConfig({ local: true, "base-url": "https://custom.pmxt.test" }, cleanEnv()),
    /Use either --base-url or --local\/--hosted/,
    "--base-url should stay an advanced override instead of mixing with mode flags",
  );
}

async function verifyHostedGuidance() {
  resetProcessEnv();
  await assert.rejects(
    () => runVenueMethod("fetchMarkets", [{ query: "Trump" }], { hosted: true }),
    (error) => {
      assert.match(error.message, /Hosted PMXT needs an API key/);
      assert.match(error.message, /pmxt auth login --api-key <pmxt_api_key>/);
      assert.match(error.message, /PMXT_API_KEY=<pmxt_api_key>/);
      assert.match(error.message, /--pmxt-api-key <pmxt_api_key>/);
      assert.match(error.message, /pmxt <exchange> <command> --local/);
      assert.match(error.message, /npm install -g pmxt-core/);
      assert.match(error.message, /pmxt auth status/);
      return true;
    },
  );
}

async function verifyRuntimeColorPolicy() {
  resetProcessEnv({ FORCE_COLOR: "1" });
  await assert.rejects(
    () => runVenueMethod("fetchMarkets", [{ query: "Trump" }], { hosted: true }),
    (error) => {
      assert.match(error.message, /\x1b\[31mHosted PMXT needs an API key\x1b\[39m/);
      assert.match(error.message, /\x1b\[33mHosted:\x1b\[39m/);
      assert.match(error.message, /\x1b\[36mpmxt auth login --api-key <pmxt_api_key>\x1b\[39m/);
      return true;
    },
  );

  resetProcessEnv({ FORCE_COLOR: "1" });
  await assert.rejects(
    () => runVenueMethod("fetchMarkets", [{ query: "Trump" }], { hosted: true, json: true }),
    (error) => {
      assert.doesNotMatch(error.message, /\x1b\[/, "--json should disable runtime error color");
      return true;
    },
  );

  resetProcessEnv({ NO_COLOR: "" });
  await assert.rejects(
    () => runVenueMethod("fetchMarkets", [{ query: "Trump" }], { hosted: true }),
    (error) => {
      assert.doesNotMatch(error.message, /\x1b\[/, "NO_COLOR should disable runtime error color");
      return true;
    },
  );
}

async function verifyLocalDefaultRequest() {
  let ensureCalls = 0;
  let requested;
  resetProcessEnv();
  ServerManager.prototype.ensureServerRunning = async () => {
    ensureCalls += 1;
  };
  ServerManager.prototype.getRunningPort = () => 4123;
  ServerManager.prototype.getAccessToken = () => "local-token";
  global.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return okResponse([{ id: "market-1" }]);
  };

  const data = await runVenueMethod("fetchMarkets", [{ query: "Trump" }], {});
  assert.deepEqual(data, [{ id: "market-1" }]);
  assert.equal(ensureCalls, 1);
  assert.equal(requested.url, "http://localhost:4123/api/polymarket/fetchMarkets");
  assert.equal(requested.options.headers.Authorization, undefined);
  assert.equal(requested.options.headers["x-pmxt-access-token"], "local-token");
  assert.deepEqual(JSON.parse(requested.options.body).args, [{ query: "Trump" }]);
}

async function verifyLocalFlagOverridesHostedAuth() {
  let requested;
  resetProcessEnv({ PMXT_API_KEY: "pmxt_test" });
  ServerManager.prototype.getRunningPort = () => 4124;
  ServerManager.prototype.getAccessToken = () => "local-token-2";
  global.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return okResponse();
  };

  await runVenueMethod("fetchMarkets", [], { local: true });
  assert.equal(requested.url, "http://localhost:4124/api/polymarket/fetchMarkets");
  assert.equal(requested.options.headers.Authorization, undefined);
  assert.equal(requested.options.headers["x-pmxt-access-token"], "local-token-2");
}

async function verifyHostedRequest() {
  let requested;
  resetProcessEnv({ PMXT_API_KEY: "pmxt_test" });
  global.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return okResponse();
  };

  await runVenueMethod("fetchMarkets", [], {});
  assert.equal(requested.url, "https://api.pmxt.dev/api/polymarket/fetchMarkets");
  assert.equal(requested.options.headers.Authorization, "Bearer pmxt_test");
  assert.equal(requested.options.headers["x-pmxt-access-token"], undefined);
}

async function verifyCustomBaseUrlDoesNotStartLocal() {
  let ensureCalls = 0;
  let requested;
  resetProcessEnv({ PMXT_API_KEY: "pmxt_test" });
  ServerManager.prototype.ensureServerRunning = async () => {
    ensureCalls += 1;
  };
  global.fetch = async (url, options) => {
    requested = { url: String(url), options };
    return okResponse();
  };

  await runVenueMethod("fetchMarkets", [], { "base-url": "http://localhost:4999" });
  assert.equal(ensureCalls, 0);
  assert.equal(requested.url, "http://localhost:4999/api/polymarket/fetchMarkets");
  assert.equal(requested.options.headers.Authorization, undefined);
  assert.equal(requested.options.headers["x-pmxt-access-token"], undefined);

  await runVenueMethod("fetchMarkets", [], { "base-url": "https://custom.pmxt.test" });
  assert.equal(ensureCalls, 0);
  assert.equal(requested.url, "https://custom.pmxt.test/api/polymarket/fetchMarkets");
  assert.equal(requested.options.headers.Authorization, "Bearer pmxt_test");
  assert.equal(requested.options.headers["x-pmxt-access-token"], undefined);
}

async function main() {
  await verifyRuntimeModes();
  await verifyHostedGuidance();
  await verifyRuntimeColorPolicy();
  await verifyLocalDefaultRequest();
  await verifyLocalFlagOverridesHostedAuth();
  await verifyHostedRequest();
  await verifyCustomBaseUrlDoesNotStartLocal();
}

main()
  .finally(() => {
    global.fetch = originalFetch;
    ServerManager.prototype.ensureServerRunning = originalEnsure;
    ServerManager.prototype.getRunningPort = originalPort;
    ServerManager.prototype.getAccessToken = originalToken;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  })
  .then(() => {
    console.log("runtime error verification passed");
  });
