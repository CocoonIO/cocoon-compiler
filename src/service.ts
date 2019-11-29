"use strict";

import * as fse from "fs-extra";
import * as http from "http";
import * as log4js from "log4js";
import * as os from "os";
import * as path from "path";
import * as request from "request";

import * as globals from "./globals";

interface IRegisterData {
    ip: string;
    os: string;
    hostname: string;
}

interface IRegisterServiceData {
    service: string;
}

export interface IGlobalOptions {
    service: boolean;
    env: string;
    logLevel: string;
}

export abstract class CocoonService {

    private static LOOP_INTERVAL: number = 10000;
    private static STOP_INTERVAL: number = 5000;
    private static HEARTBEAT_INTERVAL: number = 60000;

    protected _options: IGlobalOptions;
    protected _env: globals.CocoonEnvironment;
    protected _working: boolean;
    protected _logger: log4js.Logger;

    protected abstract onStart(): void;
    protected abstract onStop(): void;
    protected abstract loop(): void;

    private readonly _id: string;
    private _ipAddress: string;
    private readonly _loopInterval: number;
    private _stopIntervalId: NodeJS.Timer;

    private _loopIntervalId: NodeJS.Timer;

    private _heartbeatIntervalId: NodeJS.Timer;

    protected constructor(id: string, loopInterval?: number, options?: IGlobalOptions) {
        this.config(options);

        this._id = id;
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
            categories: {default: {appenders: ["out"], level: this._options.logLevel}},
        });
        this._logger = log4js.getLogger(this._id);
        this._logger.info("config:\n", this._options);
        this._loopInterval = loopInterval || CocoonService.LOOP_INTERVAL;

        if (this._options.service) {
            process.on("uncaughtException", (err: Error) => {
                this._logger.fatal("Something weird happened: " + err);
                this._logger.fatal(err.stack);
                this.working(false);
            });
            process.on("SIGTERM", () => {
                this.stop();
            });
            process.on("SIGINT", () => {
                this.stop();
            });
        }

        this._loopIntervalId = null;
        this._stopIntervalId = null;
        this.working(false);
    }

    public start(): void {
        if (this._loopIntervalId === null) {
            this._logger.info("start");

            this.onStart();

            globals.getNetworkIP((err: Error, ipAddress: string) => {
                if (err) {
                    this._logger.fatal("cannot get the ip address, avoiding registration", err);
                    this._logger.fatal(err.message);
                    this.stop();
                    return;
                }

                if (this._options.service) {
                    this._ipAddress = ipAddress;
                    this.register();

                    this._loopIntervalId = setInterval(() => {
                        this.loop();
                    }, this._loopInterval);
                    this._heartbeatIntervalId = setInterval(() => {
                        this.register();
                    }, CocoonService.HEARTBEAT_INTERVAL);
                } else {
                    this.loop();
                }
            });

        } else {
            this._logger.warn("already started");
        }
    }

    protected stop(): void {
        this._logger.info("stopping service", this._id);

        if (this._working) {
            clearInterval(this._loopIntervalId);
            this._logger.info("service working, scheduling stop for " + CocoonService.STOP_INTERVAL + " secs");
            if (!this._stopIntervalId) {
                this._stopIntervalId = setInterval(() => {
                    this.stop();
                }, CocoonService.STOP_INTERVAL);
            }
            return;
        }

        this._logger.info("stop");

        this.onStop();

        if (this._options.service) {
            clearInterval(this._loopIntervalId);
            clearInterval(this._heartbeatIntervalId);
        }

        this.working(false);
        this.deregister();

        this._logger.info("service", this._id, "stopped");
        process.exit(0);
    }

    protected working(working: boolean): void {
        this._working = working;

        try {
            const lock = path.join(globals.COMPILER_WORKSPACE_PATH(this._env), this._id + ".lock");
            if (working) {
                fse.closeSync(fse.openSync(lock, "w"));
            } else {
                fse.unlinkSync(lock);
            }
        } catch (ex) {
            this._logger.warn(ex);
        }
    }

    protected isProcessWorking(id: string): boolean {
        try {
            const lock = path.join(globals.COMPILER_WORKSPACE_PATH(this._env), id + ".lock");
            return fse.existsSync(lock);

        } catch (ex) {
            return false;
        }
    }

    private config(options: IGlobalOptions = {env: process.env.NODE_ENV || "develop",
        logLevel: process.env.LOGLEVEL || "debug", service: true}): void {
        this._options = options;

        this._env = globals.stringToEnv(this._options.env);
    }

    private register(): void {
        this._logger.info("register");

        if (this._env === globals.CocoonEnvironment.DEVELOP) {
            this._logger.info("no registration for develop environment");
            return;
        }

        const registerData: IRegisterData = {
            hostname: os.hostname(),
            ip: this._ipAddress,
            os: os.platform(),
        };

        request({
            body: JSON.stringify(registerData),
            headers: {
                "Authorization": "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==",
                "Content-Type": "application/json",
                "Host": globals.envToHost(this._env),
            },
            method: "POST",
            timeout: 10000,
            uri: "https://" + globals.envToHost(this._env) + "/api/v1/compilers",

        }, (error: any, response: http.IncomingMessage): void => {
            if (error) {
                this._logger.error("registration error", error);
                return;
            }

            if (response.statusCode >= 200 && response.statusCode < 400) {
                this._logger.info("registration success");
                this.registerService();

            } else {
                this._logger.error("registration error", response.statusMessage);
            }
        });
    }

    private registerService(): void {
        this._logger.info("register service");

        if (this._env === globals.CocoonEnvironment.DEVELOP) {
            this._logger.info("no service registration for develop environment");
            return;
        }

        const registerServiceData: IRegisterServiceData = {
            service: this._id,
        };

        request({
            body: JSON.stringify(registerServiceData),
            headers: {
                "Authorization": "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==",
                "Content-Type": "application/json",
                "Host": globals.envToHost(this._env),
            },
            method: "POST",
            timeout: 10000,
            uri: "https://" + globals.envToHost(this._env) + "/api/v1/compilers/" + this._ipAddress,

        }, (error: any, response: http.IncomingMessage): void => {
            if (error) {
                this._logger.error("service registration error", error);
                return;
            }

            if (response.statusCode >= 200 && response.statusCode < 400) {
                this._logger.info("service registration success");
                this.heartbeat();

            } else {
                this._logger.error("service registration error", response.statusMessage);
            }
        });
    }

    private heartbeat(): void {
        this._logger.info("heartbeat");

        if (this._env === globals.CocoonEnvironment.DEVELOP) {
            this._logger.info("no heartbeat for develop environment");
            clearInterval(this._heartbeatIntervalId);
            return;
        }

        request({
            headers: {
                Authorization: "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==",
                Host: globals.envToHost(this._env),
            },
            method: "POST",
            timeout: 10000,
            uri: "https://" + globals.envToHost(this._env) + "/api/v1/compilers/" + this._ipAddress +
            "/" + this._id + "/heartbeat",

        }, (error: any, response: http.IncomingMessage): void => {
            if (error) {
                this._logger.error("heartbeat error", error);
                return;
            }

            if (response.statusCode >= 200 && response.statusCode < 400) {
                this._logger.info("heartbeat success");

            } else {
                this._logger.error("heartbeat error", response.statusMessage);
            }
        });
    }

    private deregister() {
        this._logger.info("deregister");

        request({
            headers: {
                Authorization: "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==",
                Host: globals.envToHost(this._env),
            },
            method: "DELETE",
            timeout: 10000,
            uri: "https://" + globals.envToHost(this._env) + "/api/v1/compilers/"
            + this._ipAddress + "/" + this._id,

        }, (error: any, response: http.IncomingMessage): void => {
            if (error) {
                this._logger.error("deregister error", error);
                return;
            }

            if (response.statusCode >= 200 && response.statusCode < 400) {
                this._logger.info("deregister success");

            } else {
                this._logger.error("deregister error", response.statusMessage);
            }
        });
    }
}
