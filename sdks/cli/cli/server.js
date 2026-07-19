"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeServerCommand = executeServerCommand;
exports.formatServerCommandResult = formatServerCommandResult;
// @ts-nocheck
const color_js_1 = require("./colors.js");
const server_manager_js_1 = require("./server-manager.js");
async function executeServerCommand(action, options = {}) {
    const manager = options.manager ?? new server_manager_js_1.ServerManager();
    switch (action) {
        case "start":
            await manager.start();
            return { action, ok: true };
        case "stop":
            await manager.stop();
            return { action, ok: true };
        case "restart":
            await manager.restart();
            return { action, ok: true };
        case "status": {
            const status = await manager.status();
            return { action, ok: true, ...status };
        }
        case "health": {
            const healthy = await manager.health();
            return { action, ok: healthy, healthy };
        }
        case "logs": {
            const requestedLines = options.lines ?? 50;
            const lines = manager.logs(requestedLines);
            return { action, ok: true, count: lines.length, lines };
        }
    }
}
function formatServerCommandResult(result, options = {}) {
    const color = (0, color_js_1.createColor)({
        env: options.env,
        json: Boolean(options.json),
        stream: options.stream ?? process.stdout,
    });
    switch (result.action) {
        case "start":
            return color.success("Local PMXT instance started");
        case "stop":
            return color.success("Local PMXT instance stopped");
        case "restart":
            return color.success("Local PMXT instance restarted");
        case "status":
            return formatStatus(result, color);
        case "health":
            return result.healthy
                ? color.success("Local PMXT instance healthy")
                : color.warning("Local PMXT instance unhealthy");
        case "logs":
            return result.lines.length > 0
                ? result.lines.join("\n")
                : color.warning("No local PMXT logs found");
    }
}
function formatStatus(status, color) {
    const state = status.running ? color.success("running") : color.warning("stopped");
    const lines = [`Local PMXT instance ${state}`];
    if (status.pid !== null)
        lines.push(`${color.dim("pid")}: ${status.pid}`);
    if (status.port !== null)
        lines.push(`${color.dim("port")}: ${status.port}`);
    if (status.version !== null)
        lines.push(`${color.dim("version")}: ${status.version}`);
    if (status.uptimeSeconds !== null) {
        lines.push(`${color.dim("uptime")}: ${formatDuration(status.uptimeSeconds)}`);
    }
    lines.push(`${color.dim("lock")}: ${status.lockFile}`);
    return lines.join("\n");
}
function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}h ${minutes}m ${remainingSeconds}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${remainingSeconds}s`;
    }
    return `${remainingSeconds}s`;
}
