"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const core_1 = require("@oclif/core");
const server_js_1 = require("../../cli/server.js");
class ServerHealth extends core_1.Command {
    static enableJsonFlag = true;
    static summary = "Check local PMXT instance health";
    static description = "Check whether the local PMXT instance is healthy without starting it.";
    async run() {
        const { flags } = await this.parse(ServerHealth);
        const result = await (0, server_js_1.executeServerCommand)("health");
        this.log((0, server_js_1.formatServerCommandResult)(result, { json: flags.json }));
        if (result.action === "health" && !result.healthy)
            process.exitCode = 1;
        return result;
    }
}
exports.default = ServerHealth;
