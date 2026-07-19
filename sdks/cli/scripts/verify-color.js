#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cliRoot = path.resolve(__dirname, "..");
const bin = path.join(cliRoot, "bin", "pmxt.js");
const { ANSI_PATTERN, createColorizer, semanticColor, shouldUseColor, stripAnsi } = require(path.join(cliRoot, "cli", "colors.js"));
const { formatAuthStatusMessage, formatExchangeStatusMessage, formatOutcomeMessage } = require(path.join(cliRoot, "cli", "auth-output.js"));
const { formatRootHelp } = require(path.join(cliRoot, "cli", "help.js"));
const { runVenueMethod } = require(path.join(cliRoot, "cli", "runtime.js"));
const { formatServerCommandResult } = require(path.join(cliRoot, "cli", "server.js"));

const tty = { isTTY: true };
const pipe = { isTTY: false };

assert.equal(shouldUseColor({ stream: tty, env: {} }), true, "TTY output should color by default");
assert.equal(shouldUseColor({ stream: pipe, env: {} }), false, "non-TTY output should not color by default");
assert.equal(shouldUseColor({ json: true, stream: tty, env: { FORCE_COLOR: "1" } }), false, "--json should never color");
assert.equal(shouldUseColor({ flags: { json: true }, stream: tty, env: { FORCE_COLOR: "1" } }), false, "flags.json should never color");
assert.equal(shouldUseColor({ stream: tty, env: { NO_COLOR: "" } }), false, "NO_COLOR should disable color");
assert.equal(shouldUseColor({ stream: pipe, env: { FORCE_COLOR: "1" } }), true, "FORCE_COLOR should enable color on non-TTY");
assert.equal(shouldUseColor({ stream: pipe, env: { FORCE_COLOR: "" } }), true, "empty FORCE_COLOR should enable color");
assert.equal(shouldUseColor({ stream: tty, env: { FORCE_COLOR: "0" } }), false, "FORCE_COLOR=0 should disable color");
assert.equal(shouldUseColor({ stream: pipe, env: { NO_COLOR: "", FORCE_COLOR: "1" } }), false, "NO_COLOR should win over FORCE_COLOR");

const color = createColorizer({ stream: tty, env: {} });
assert.equal(color.error("bad"), "\x1b[31mbad\x1b[39m");
assert.equal(color.warning("careful"), "\x1b[33mcareful\x1b[39m");
assert.equal(color.success("ok"), "\x1b[32mok\x1b[39m");
assert.equal(color.command("pmxt auth status"), "\x1b[36mpmxt auth status\x1b[39m");
assert.equal(color.url("https://api.pmxt.dev"), "\x1b[36mhttps://api.pmxt.dev\x1b[39m");
assert.equal(color.muted("details"), "\x1b[2mdetails\x1b[22m");
assert.equal(semanticColor("unknown", "plain", { stream: tty, env: {} }), "plain");
assert.equal(semanticColor("error", "bad", { stream: pipe, env: {} }), "bad");
assert.equal(stripAnsi(color.error("bad")), "bad");

const plainHelp = formatRootHelp({ stream: pipe, env: {} });
assert.doesNotMatch(plainHelp, ANSI_PATTERN, "root help should not color non-TTY output");
assert.match(plainHelp, /PMXT command-line interface/);

const coloredHelp = formatRootHelp({ stream: pipe, env: { FORCE_COLOR: "1" } });
assert.match(coloredHelp, ANSI_PATTERN, "FORCE_COLOR should color root help on non-TTY output");
assert.equal(stripAnsi(coloredHelp).includes("PMXT command-line interface"), true);

const noColorHelp = formatRootHelp({ stream: tty, env: { NO_COLOR: "" } });
assert.doesNotMatch(noColorHelp, ANSI_PATTERN, "NO_COLOR should keep root help plain");

const forcedPipe = { stream: pipe, env: { FORCE_COLOR: "1" } };
assert.match(formatOutcomeMessage("Logged in to PMXT as pmxt_...1234.", forcedPipe), /\x1b\[32m/, "auth success should be green");
assert.match(formatOutcomeMessage("No stored PMXT API key was found.", forcedPipe), /\x1b\[33m/, "auth missing state should be yellow");
assert.match(formatAuthStatusMessage("PMXT API key: not configured.\nSet PMXT_API_KEY or run pmxt auth login.", forcedPipe), /\x1b\[33m/, "auth not configured should be yellow");
assert.match(formatExchangeStatusMessage("polymarket exchange credentials: configured via store.", forcedPipe), /\x1b\[32m/, "exchange auth configured should be green");
assert.doesNotMatch(formatAuthStatusMessage("PMXT API key: configured.", { ...forcedPipe, flags: { json: true } }), ANSI_PATTERN, "auth formatters should honor flags.json");

const serverStatus = formatServerCommandResult({
  action: "status",
  ok: true,
  running: true,
  pid: 123,
  port: 3847,
  version: "2.46.1",
  uptimeSeconds: 8,
  lockFile: "/tmp/pmxt-server.lock",
}, forcedPipe);
assert.match(serverStatus, /\x1b\[32m/, "server running status should be green");
assert.match(stripAnsi(serverStatus), /Local PMXT instance running/);
assert.match(formatServerCommandResult({ action: "health", ok: false, healthy: false }, forcedPipe), /\x1b\[33m/, "server unhealthy status should be yellow");
assert.doesNotMatch(formatServerCommandResult({ action: "start", ok: true }, { ...forcedPipe, json: true }), ANSI_PATTERN, "server formatter should honor json");

function runCli(args, env) {
  const commandEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(commandEnv)) {
    if (value === undefined) delete commandEnv[key];
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: commandEnv,
  });
  assert.equal(result.status, 0, `pmxt ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function verifyAuthServerCommandColor() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmxt-cli-auth-server-color-"));
  const authStore = path.join(tempDir, "auth.json");
  fs.writeFileSync(authStore, "{}\n", { mode: 0o600 });
  try {
    const baseEnv = {
      HOME: tempDir,
      PMXT_API_KEY: "",
      PMXT_AUTH_STORE_PATH: authStore,
      PMXT_BASE_URL: "",
      PMXT_CLI_NO_SUGGEST_HOSTED: "1",
    };
    const authColor = runCli(["auth", "status", "--auth-store", authStore], { ...baseEnv, FORCE_COLOR: "1", NO_COLOR: undefined });
    assert.match(authColor, ANSI_PATTERN, "auth status should colorize human status when color is forced");
    assert.doesNotMatch(authColor, /sidecar/i);

    const authNoColor = runCli(["auth", "status", "--auth-store", authStore], { ...baseEnv, FORCE_COLOR: undefined, NO_COLOR: "1" });
    assert.doesNotMatch(authNoColor, ANSI_PATTERN, "NO_COLOR should disable auth status color");

    const serverJson = runCli(["server", "status", "--json"], { ...baseEnv, FORCE_COLOR: "1", NO_COLOR: undefined });
    assert.doesNotMatch(serverJson, ANSI_PATTERN, "server --json output should not include ANSI color");
    assert.doesNotThrow(() => JSON.parse(serverJson));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyRuntimeErrorColor() {
  const original = {
    FORCE_COLOR: process.env.FORCE_COLOR,
    NO_COLOR: process.env.NO_COLOR,
    PMXT_API_KEY: process.env.PMXT_API_KEY,
    PMXT_AUTH_STORE: process.env.PMXT_AUTH_STORE,
    PMXT_AUTH_STORE_PATH: process.env.PMXT_AUTH_STORE_PATH,
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmxt-cli-color-"));
  const authStore = path.join(tempDir, "auth.json");
  fs.writeFileSync(authStore, "{}\n", { mode: 0o600 });
  try {
    delete process.env.NO_COLOR;
    delete process.env.PMXT_API_KEY;
    delete process.env.PMXT_AUTH_STORE;
    process.env.PMXT_AUTH_STORE_PATH = authStore;
    process.env.FORCE_COLOR = "1";
    await assert.rejects(
      () => runVenueMethod("fetchMarkets", [], { hosted: true }),
      (error) => {
        assert.match(error.message, ANSI_PATTERN, "FORCE_COLOR should color hosted auth guidance");
        assert.match(stripAnsi(error.message), /Hosted PMXT needs an API key/);
        return true;
      },
    );

    await assert.rejects(
      () => runVenueMethod("fetchMarkets", [], { hosted: true, json: true }),
      (error) => {
        assert.doesNotMatch(error.message, ANSI_PATTERN, "--json should never color errors");
        assert.match(error.message, /Hosted PMXT needs an API key/);
        return true;
      },
    );

    process.env.NO_COLOR = "";
    await assert.rejects(
      () => runVenueMethod("fetchMarkets", [], { hosted: true }),
      (error) => {
        assert.doesNotMatch(error.message, ANSI_PATTERN, "NO_COLOR should keep errors plain");
        return true;
      },
    );
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

Promise.resolve()
  .then(verifyAuthServerCommandColor)
  .then(verifyRuntimeErrorColor)
  .then(() => {
    console.log("color verification passed");
  })
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
