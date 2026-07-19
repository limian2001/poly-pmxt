"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.ROOT_HELP = void 0;
exports.formatRootHelp = formatRootHelp;
exports.shouldShowRootHelp = shouldShowRootHelp;
const color_js_1 = require("./colors.js");

exports.ROOT_HELP = `PMXT command-line interface

USAGE
  pmxt <exchange> <command> [flags]
  pmxt <command> --exchange <exchange> [flags]

QUICK START
  pmxt auth login --api-key <pmxt_api_key>
  pmxt polymarket markets --query Trump --limit 5
  PMXT_API_KEY=<pmxt_api_key> pmxt kalshi events --query election --limit 5

MODES
  Hosted PMXT is used when an API key is configured.
  Without hosted auth, commands use a local PMXT instance.
  Use --hosted or --local to force a mode.

COMMON COMMANDS
  pmxt <exchange> markets             Search markets
  pmxt <exchange> events              Search events
  pmxt <exchange> market              Fetch one market
  pmxt <exchange> event               Fetch one event
  pmxt <exchange> orderbook           Fetch an order book
  pmxt <exchange> trades              Fetch public trades
  pmxt <exchange> positions           Fetch authenticated positions
  pmxt <exchange> balance             Fetch authenticated balances

GROUPS
  pmxt auth                           Manage PMXT API keys and venue credentials
  pmxt order                          Build, create, submit, cancel, or get orders
  pmxt orders                         Fetch open, closed, all, or user trade history
  pmxt router                         Find matching markets and events across venues
  pmxt feed                           Fetch data-feed tickers, candles, books, and streams
  pmxt watch                          Stream venue order books and trades as JSONL
  pmxt enterprise                     Run Enterprise matched-market and SQL commands
  pmxt server                         Manage a local PMXT instance

FLAGS
  --pmxt-api-key <key>                One-shot hosted PMXT API key
  --local                             Use a local PMXT instance
  --hosted                            Use the hosted PMXT API
  --base-url <url>                    Advanced PMXT API base URL override
  --json                              Print raw JSON
  --help                              Show command help

EXAMPLES
  pmxt polymarket markets --query Trump --limit 5
  pmxt polymarket markets --local --query Trump --limit 5
  pmxt polymarket markets --hosted --query Trump --limit 5
  pmxt kalshi events --query "NBA" --limit 5 --json
  pmxt polymarket orderbook <outcome-id> --limit 20
  pmxt router market-matches --market-id <market-id>
  pmxt feed fetchTicker polymarket <symbol>

Run "pmxt <command> --help" for command flags.
Run "pmxt <exchange>" for exchange-scoped examples.`;

function shouldShowRootHelp(args) {
  return args.length === 0
    || (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help"));
}

function formatRootHelp(options = {}) {
  const color = (0, color_js_1.createColorizer)({
    env: options.env,
    stream: options.stream ?? process.stdout,
  });
  return exports.ROOT_HELP.split("\n").map((line) => {
    if (line === "PMXT command-line interface")
      return color.bold(line);
    if (/^[A-Z][A-Z ]+$/.test(line))
      return color.bold(line);
    if (/^  (pmxt|PMXT_API_KEY=)/.test(line))
      return line.replace(/^(  )(.+?)(\s{2,}.+)?$/, (_match, indent, command, suffix = "") => `${indent}${color.command(command)}${suffix}`);
    if (/^  --/.test(line))
      return line.replace(/^(  )(--[^\s]+)/, (_match, indent, flag) => `${indent}${color.flag(flag)}`);
    return line;
  }).join("\n");
}
