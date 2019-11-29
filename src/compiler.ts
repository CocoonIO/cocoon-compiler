"use strict";

import * as async from "async";
import * as child_process from "child_process";
import * as program from "commander";
import * as fse from "fs-extra";
import * as http from "http";
import * as mongodb from "mongodb";
import * as os from "os";
import * as path from "path";
import * as request from "request";

import { BuilderError } from "./builder_error";
import { ICompilation } from "./compilation";
import * as globals from "./globals";
import { INotificationData } from "./notifier";
import * as service from "./service";

import mongoDbQueue = require("mongodb-queue");

export interface IErrorResponse {
    status: string;
    description: string;
    code: number;
}

export interface IConfigJson {
    code: string;
    platforms: Array<{
        name: string,
        icon?: {
            url: string,
        },
        splash?: {
            url: string,
        },
    }>;
    config: string;
    source: string;
    libVersion: string;
}

interface ICompilerPostData {
    platforms: string[];
}

interface ICompilerOptions extends service.IGlobalOptions {
    path: string;
}

const CONFIG_JSON: string = "config.json";

export const ID: string = "cocoon-compiler";

export class Compiler extends service.CocoonService {

    private static COMPILER_LOOP_INTERVAL: number = 5000;
    private static COMPILER_WATCHDOG_INTERVAL: number = 2700000;

    private _queue: any;
    private _watchdogTimer: NodeJS.Timer;

    private get path(): string {
        const tools: string = path.join(this.androidHome, "tools");
        const platformTools: string = path.join(this.androidHome, "platform-tools");

        return process.env.PATH + path.delimiter + tools + path.delimiter + platformTools;
    }

    private get androidHome(): string {
        return path.join(globals.SDKS_PATH(this._env), "android-sdks-" + os.platform());
    }

    public constructor(options?: service.IGlobalOptions) {
        super(ID, Compiler.COMPILER_LOOP_INTERVAL, options);

        this._watchdogTimer = null;
    }

    protected onStart(): void {
        const connection = "mongodb://localhost:27017/" + globals.getMongoDBName(this._env);

        mongodb.MongoClient.connect(connection, {})
            .then((mongoClient: mongodb.MongoClient) => {
                mongoClient.db().on("close", (error: Error) => {
                    this._logger.fatal("connection to mongodb closed, stopping...", error);
                    this.stop();
                    return;
                });

                this._queue = mongoDbQueue(mongoClient.db(), globals.NOTIFICATIONS_QUEUE);
            })
            .catch((err: mongodb.MongoError) => {
                this._logger.fatal("cannot connect to the notifications queue, stopping...", err);
                this.stop();
                return;
            });
    }

    protected onStop(): void {
        return;
    }

    protected loop(): void {
        // Check if the updater data folder has been initialized
        const ready = path.join(globals.COMPILER_DATA_PATH(this._env), "ready.lock");
        if (!fse.existsSync(ready)) {
            this._logger.info("skipping compilation, products not ready yet");
            return;
        }

        if (this._working) {
            return;
        }

        this.working(true);

        async.waterfall([

            this.init.bind(this),
            this.fetch.bind(this),
            this.build.bind(this),

        ], (err: BuilderError, data?: ICompilation) => {
            if (err) {
                this._logger.error("compilation finished: " + err.message);
            } else {
                this._logger.info("compilation finished: " + data.code);
            }

            if (data) {
                const notification: INotificationData = {
                    code: data.code,
                    platform: data.platform.name,
                    starttime: data.starttime,
                };

                if (err) {
                    notification.msg_internal = err.message;
                    notification.msg_public = err.msgPublic;
                }

                if (this._options.service) {
                    this.notify(notification, (error: Error) => {
                        if (error) {
                            this._logger.error(error.message);
                        }
                    });
                }
            }

            this.working(false);

            if (!this._options.service) {
                if (err) {
                    process.exit(-1);

                } else {
                    process.exit(0);
                }
            }
        });
    }

    protected init(cb: (error?: Error) => void): void {
        this._logger.info("init");

        fse.ensureDir(globals.PROJECTS_PATH(this._env), (err: any) => {
            if (err) {
                this._logger.fatal("cannot create workspace folder");
                cb(new Error(err));
                return;
            }

            cb();
        });
    }

    private fetch(cb: (error?: Error, result?: any) => void): void {
        this._logger.info("fetch");

        const processData = (configJson: string) => {
            const json: IConfigJson = JSON.parse(configJson);

            if (!json.code || !json.platforms || !json.config || !json.source || !json.libVersion) {
                cb(new Error("Malformed config.json"));
                return;
            }

            if (json) {
                const timestamp: number = new Date().getTime();
                const data: ICompilation = {
                    code: json.code,
                    config: json.config,
                    libVersion: json.libVersion,
                    platform: json.platforms[0],
                    source: json.source,
                    starttime: timestamp,
                };

                try {
                    fse.outputFileSync(globals.getConfigJsonPath(this._env, data.code, data.starttime),
                        JSON.stringify(json, null, " "));
                    this._logger.debug(CONFIG_JSON, JSON.stringify(json, null, " "));
                    cb(null, data);
                    return;

                } catch (ex) {
                    cb(new Error(ex.message));
                    return;
                }
            }
        };

        const options: ICompilerOptions = this._options as ICompilerOptions;
        if (!options.service) {
            const configJson: string = path.join(options.path, CONFIG_JSON);
            processData(fse.readFileSync(configJson, "UTF8"));

        } else {
            const postData: ICompilerPostData = {
                platforms: globals.getLocalPlatforms(),
            };

            request({
                body: JSON.stringify(postData),
                headers: {
                    "Authorization": "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==",
                    "Content-Type": "application/json",
                    "Host": globals.envToHost(this._env),
                },
                method: "POST",
                timeout: 10000,
                uri: "https://" + globals.envToHost(this._env) + "/api/v1/compilation",

            }, (error: any, response: http.IncomingMessage, body: any): void => {
                if (error) {
                    cb(error);
                    return;
                }

                if (response.statusCode >= 200 && response.statusCode < 400) {
                    processData(body);

                } else {
                    if (body) {
                        const errorResponse: IErrorResponse = JSON.parse(body);
                        cb(new Error(errorResponse.description));

                    } else {
                        cb(new Error("Cannot read response from server"));
                    }
                }
            });
        }
    }

    private build(data: ICompilation, cb: (error?: Error, result?: any) => void): void {
        this._logger.info("compile");

        const workspace = path.join(globals.PROJECTS_PATH(this._env), data.code + "_" + data.starttime);

        const environment: { [key: string]: string } = {};
        environment.HOME = globals.getHome();
        environment.PATH = this.path;
        if (data.platform.name === "android") {
            environment.ANDROID_HOME = this.androidHome;
            environment.JAVA_HOME = globals.getJavaHome();
        }

        const regex = new RegExp(workspace.replace(/\\/g, "\\\\")
            + "|" + globals.getHome().replace(/\\/g, "\\\\"), "g");
        const stdout = fse.createWriteStream(path.join(workspace, "stdout.log"));
        const builder: child_process.ChildProcess = child_process.fork(
            path.join(path.dirname(require.main.filename), "builder_launcher.js"),
            [
                "-l", this._options.logLevel,
                "-j", JSON.stringify(data),
                "-p", globals.getConfigJsonPath(this._env, data.code, data.starttime),
                "-e", globals.envToString(this._env),
            ],
            {
                cwd: process.cwd(),
                env: environment,
                execArgv: [],
                silent: true,
            },
        );

        let cbCalled = false;
        const finishBuild = (error?: Error, result?: any) => {
            stdout.close();
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;

            if (!cbCalled) {
                cbCalled = true;
                cb(error, result);
            }
        };

        builder.stdout.on("data", (buffer: Buffer) => {
            stdout.write(buffer.toString("UTF8").replace(regex, ""));
            console.log(buffer.toString("UTF8").trim());
        });
        builder.stderr.on("data", (buffer: Buffer) => {
            stdout.write(buffer.toString("UTF8").replace(regex, ""));
            console.error(buffer.toString("UTF8").trim());
        });
        builder.on("message", (error: BuilderError) => {
            if (error) {
                let log: string = "No log available";
                if (fse.existsSync(path.join(workspace, "cordova.log"))) {
                    log = fse.readFileSync(path.join(workspace, "cordova.log")).toString().replace(regex, "");
                }

                if (error.msgPublic) {
                    error.msgPublic = "COMPILER ERROR: \n\n" + error.msgPublic.replace(regex, "")
                        + "\n\nCORDOVA LOG: \n\n" + log.slice(-10000);
                } else {
                    error.msgPublic = "CORDOVA LOG: \n\n" + log;
                }

                if (!error.message) {
                    error.message = fse.readFileSync(path.join(workspace, "stdout.log")).toString();
                }

                finishBuild(error, data);
                return;
            }

            finishBuild(null, data);
            return;
        });

        builder.on("exit", (code: number, signal: string) => {
            if (code !== 0) {
                stdout.write("Process exited abnormally (" + signal + "): " + code);
                finishBuild(new Error("Process exited abnormally (" + signal + "): " + code), data);
                return;
            }

            // If the process finishes without error it should be because we have received a finish message.
            // This is here only for the case were something weird happens and we don't get a message but the process
            // exits without a signal and the return code is 0.
            this._logger.info("Process exited. (signal: " + signal + ") (code: " + code + ")");
            try {
                finishBuild(null, data);
                return;
            } catch (e) {
                this._logger.debug(e);
            }
        });

        builder.on("error", (err: Error) => {
            this._logger.error("Process exited with error(" + err.name + "): " + err.message + "\n" + err.stack);

            finishBuild(err, data);
            return;
        });

        clearInterval(this._watchdogTimer);

        this._watchdogTimer = setInterval(() => {
            builder.kill("SIGKILL");

            finishBuild(new BuilderError(
                "Compilation took too long, killing...",
                "The compilation exceed the designated time."),
                data);
            return;
        }, Compiler.COMPILER_WATCHDOG_INTERVAL);
    }

    private notify(notification: INotificationData, cb: (error: Error) => void): void {
        this._logger.info("notify", notification.code);

        this._queue.add(notification, (err: Error, id: string) => {
            if (err) {
                this._logger.error("cannot add notification to queue", err);
                cb(err);
                return;
            }

            this._logger.info("notification added", id);
            cb(null);
        });
    }
}

program
    .version(globals.getVersion())
    .option("-c, --console", "Console mode")
    .option("-e, --env <env>", "Environment", /^(develop|testing|production)$/i, "develop")
    .option("-l, --logLevel <level>", "Log level", /^(all|trace|debug|info|warn|error|fatal|mark|off)$/i, "info")
    .option("-p, --path <path>", "Cloud project path containing the config.json")
    .parse(process.argv);

if (program.console) {
    const options: ICompilerOptions = {
        env: program.env,
        logLevel: program.logLevel,
        path: program.path,
        service: false,
    };

    new Compiler(options).start();

} else {
    new Compiler().start();
}
