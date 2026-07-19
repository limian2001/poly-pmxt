#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cliRoot = path.resolve(__dirname, "..");
const bin = path.join(cliRoot, "bin", "pmxt.js");

function run(args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, PMXT_API_KEY: "", PMXT_BASE_URL: "" },
  });
  assert.equal(result.status, 0, `pmxt ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

for (const args of [[], ["--help"], ["help"]]) {
  const output = run(args);
  assert.match(output, /QUICK START/, "root help should show onboarding first");
  assert.match(output, /pmxt auth login --api-key <pmxt_api_key>/, "root help should show auth setup");
  assert.match(output, /Hosted PMXT is used when an API key is configured/, "root help should explain auto mode");
  assert.match(output, /Without hosted auth, commands use a local PMXT instance/, "root help should explain local fallback");
  assert.match(output, /pmxt <exchange> markets/, "root help should show exchange-first usage");
  assert.match(output, /--local/, "root help should show local mode");
  assert.match(output, /--hosted/, "root help should show hosted mode");
  assert.match(output, /pmxt polymarket markets --local/, "root help should show explicit local example");
  assert.match(output, /pmxt polymarket markets --hosted/, "root help should show explicit hosted example");
  assert.match(output, /Manage a local PMXT instance/, "root help should use local PMXT instance wording");
  assert.match(output, /Advanced PMXT API base URL override/, "root help should mark base-url as advanced");
  assert.doesNotMatch(output, /v0-matched-markets/, "root help should hide low-level aliases");
  assert.doesNotMatch(output, /fetch-all-orders/, "root help should hide duplicate fetch aliases");
  assert.doesNotMatch(output, /sidecar/i, "root help should not use sidecar wording");
}

console.log("root help verification passed");
