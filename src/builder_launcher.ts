"use strict";

import * as program from "commander";
import * as log4js from "log4js";
import * as os from "os";

import { Builder } from "./builder";
import { AndroidBuilder } from "./builder_android";
import { BuilderError } from "./builder_error";
import { IOSBuilder } from "./builder_ios";
import { OSXBuilder } from "./builder_osx";
import { UbuntuBuilder } from "./builder_ubuntu";
import { WindowsBuilder } from "./builder_windows";
import { ICompilation } from "./compilation";
import * as globals from "./globals";

program
    .version(globals.getVersion())
    .option("-e, --env <env>", "Environment", /^(develop|testing|production)$/i, "develop")
    .option("-j, --json <json>", "Compilation data json")
    .option("-l, --logLevel <level>", "Log level", /^(all|trace|debug|info|warn|error|fatal|mark|off)$/i, "info")
    .option("-p, --path <path>", "Config path (where config.json is)")
    .parse(process.argv);

if (!program.env) {
    if (process.send) {
        process.send({ error: new Error("Parameter env not available"), data: null });
    } else {
        console.error("Parameter env not available");
    }

    process.exit(-1);
}

if (!program.json) {
    if (process.send) {
        process.send({ error: new Error("Parameter json not available"), data: null });
    } else {
        console.error("Parameter json not available");
    }

    process.exit(-1);
}

const env: globals.CocoonEnvironment = globals.stringToEnv(program.env);
const data: ICompilation = JSON.parse(program.json);
const configPath: string = program.path;
const logLevel: string = program.logLevel;

log4js.configure({
    appenders: {
        out: {
            layout: {
                pattern: "%[%d{yyyyMMddThhmmss} [%p] %c -%] %m",
                type: "pattern",
            },
            type: "stdout",
        },
    },
    categories: {default: {appenders: ["out"], level: logLevel}},
});
const logger: log4js.Logger = log4js.getLogger("Launcher");

logger.debug("Host: ", os.hostname());
logger.debug("Env: ", globals.envToString(env));
logger.debug("Config path:", configPath);
logger.debug("LogLevel: ", logLevel);
logger.debug("Json:", data);

let builder: Builder;
if (data.platform.name === "android") {
    builder = new AndroidBuilder(env, data, configPath, logLevel);

} else if (data.platform.name === "ios") {
    builder = new IOSBuilder(env, data, configPath, logLevel);

} else if (data.platform.name === "osx") {
    builder = new OSXBuilder(env, data, configPath, logLevel);

} else if (data.platform.name === "windows") {
    builder = new WindowsBuilder(env, data, configPath, logLevel);

} else if (data.platform.name === "ubuntu") {
    builder = new UbuntuBuilder(env, data, configPath, logLevel);
}

if (!builder) {
    if (process.send) { // If it's invoked by another process
        process.send({ error: new Error("Builder not available"), data: null });
        process.exit(0);

    } else { // If it's invoked from the console
        logger.error("Builder not available");
        process.exit(-1);
    }
}

builder.start((err: BuilderError) => {
    if (err) {
        if (process.send) { // If it's invoked by another process
            process.send(err);
            process.exit(0);

        } else { // If it's invoked from the console
            logger.error(JSON.stringify(err));
            process.exit(-1);
        }

    } else {
        if (process.send) {
            process.send(null);
        }

        process.exit(0);
    }
});
