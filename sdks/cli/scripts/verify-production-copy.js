#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cliRoot = path.resolve(__dirname, "..");
const roots = [
  path.join(cliRoot, "README.md"),
  path.join(cliRoot, "package.json"),
  path.join(cliRoot, "bin"),
  path.join(cliRoot, "cli"),
  path.join(cliRoot, "commands"),
];
const checkedExtensions = new Set([".js", ".json", ".md"]);

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(target)
    .flatMap((entry) => collectFiles(path.join(target, entry)));
}

const matches = roots
  .flatMap(collectFiles)
  .filter((file) => checkedExtensions.has(path.extname(file)))
  .flatMap((file) => {
    const content = fs.readFileSync(file, "utf8");
    return /sidecar/i.test(content) ? [path.relative(cliRoot, file)] : [];
  });

assert.deepEqual(matches, [], `Production CLI copy must not use sidecar wording: ${matches.join(", ")}`);
console.log("production copy verification passed");
