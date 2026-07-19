"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.ANSI_PATTERN = void 0;
exports.shouldUseColor = shouldUseColor;
exports.createColorizer = createColorizer;
exports.createColor = createColor;
exports.semanticColor = semanticColor;
exports.colorize = semanticColor;
exports.stripAnsi = stripAnsi;

exports.ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const ANSI = {
  bold: ["\x1b[1m", "\x1b[22m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  red: ["\x1b[31m", "\x1b[39m"],
  green: ["\x1b[32m", "\x1b[39m"],
  yellow: ["\x1b[33m", "\x1b[39m"],
  blue: ["\x1b[34m", "\x1b[39m"],
  cyan: ["\x1b[36m", "\x1b[39m"],
};

const SEMANTIC = {
  command: "cyan",
  error: "red",
  info: "cyan",
  label: "yellow",
  muted: "dim",
  success: "green",
  url: "cyan",
  warning: "yellow",
};

function envHas(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function forcedColor(env) {
  if (!envHas(env, "FORCE_COLOR")) return undefined;
  const value = String(env.FORCE_COLOR ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no") return false;
  return true;
}

function shouldUseColor(options = {}) {
  if (typeof options === "boolean") return options;
  if (options.json || options.flags?.json || options.enabled === false) return false;
  const env = options.env ?? process.env;
  if (envHas(env, "NO_COLOR")) return false;
  const forced = forcedColor(env);
  if (forced !== undefined) return forced;
  const stream = options.stream ?? process.stdout;
  return Boolean(stream?.isTTY);
}

function wrap(enabled, pair, value) {
  const text = String(value);
  return enabled ? `${pair[0]}${text}${pair[1]}` : text;
}

function createColorizer(options = {}) {
  const enabled = shouldUseColor(options);
  const color = {
    enabled,
    bold: (value) => wrap(enabled, ANSI.bold, value),
    dim: (value) => wrap(enabled, ANSI.dim, value),
    red: (value) => wrap(enabled, ANSI.red, value),
    green: (value) => wrap(enabled, ANSI.green, value),
    yellow: (value) => wrap(enabled, ANSI.yellow, value),
    blue: (value) => wrap(enabled, ANSI.blue, value),
    cyan: (value) => wrap(enabled, ANSI.cyan, value),
  };
  return {
    ...color,
    command: color.cyan,
    error: color.red,
    info: color.cyan,
    label: color.yellow,
    flag: color.yellow,
    muted: color.dim,
    success: color.green,
    url: color.cyan,
    warning: color.yellow,
  };
}

function createColor(options = {}) {
  return createColorizer(options);
}

function semanticColor(kind, value, options = {}) {
  const color = createColorizer(options);
  const method = SEMANTIC[kind];
  return method ? color[method](value) : String(value);
}

function stripAnsi(value) {
  return String(value).replace(exports.ANSI_PATTERN, "");
}
