"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatAuthStatusMessage = formatAuthStatusMessage;
exports.formatExchangeStatusMessage = formatExchangeStatusMessage;
exports.formatOutcomeMessage = formatOutcomeMessage;
const color_js_1 = require("./colors.js");
function colorForOptions(options = {}) {
    return (0, color_js_1.createColor)({
        env: options.env,
        json: Boolean(options.flags?.json),
        stream: options.stream ?? process.stdout,
    });
}
function colorFirstLine(message, kind, options = {}) {
    const color = colorForOptions(options);
    const lines = String(message).split("\n");
    lines[0] = color[kind](lines[0]);
    return lines.join("\n");
}
function formatOutcomeMessage(message, options = {}) {
    return /^(No |.*not configured)/i.test(message)
        ? colorFirstLine(message, "warning", options)
        : colorFirstLine(message, "success", options);
}
function formatAuthStatusMessage(message, options = {}) {
    if (/not configured/i.test(message)) {
        const color = colorForOptions(options);
        const lines = String(message).split("\n");
        lines[0] = color.warning(lines[0]);
        if (lines[1])
            lines[1] = color.muted(lines[1]);
        return lines.join("\n");
    }
    return colorFirstLine(message, "success", options);
}
function formatExchangeStatusMessage(message, options = {}) {
    const color = colorForOptions(options);
    const lines = String(message).split("\n");
    if (/not configured/i.test(lines[0] ?? "")) {
        lines[0] = color.warning(lines[0]);
        return lines.join("\n");
    }
    if (/configured via/i.test(lines[0] ?? "")) {
        lines[0] = color.success(lines[0]);
        return lines.join("\n");
    }
    if (/Stored exchange credentials|Environment exchange credential vars/i.test(message)) {
        return lines.map((line) => /^(Stored exchange credentials|Environment exchange credential vars):$/.test(line)
            ? color.info(line)
            : /^none$/.test(line)
                ? color.muted(line)
                : line).join("\n");
    }
    return message;
}
