"use strict";

import * as fse from "fs-extra";
import * as http from "http";
import * as mongodb from "mongodb";
import * as os from "os";
import * as path from "path";
import * as request from "request";

import * as compiler from "./compiler";
import * as globals from "./globals";
import * as service from "./service";

import mongoDbQueue = require("mongodb-queue");

export interface INotificationData {
    platform: string;
    code: string;
    starttime: number;
    msg_internal?: string;
    msg_public?: string;
}

interface INotificationPostData {
    platform: string;
    user_error: string;
    staff_error: string;
    machine: string;
}

interface IMongoQueueMessage {
    id: string;
    ack: string;
    payload: INotificationData;
    tries: number;
}

export const ID: string = "cocoon-notifier";
export const MAX_RETRIES_NUMBER: number = 20;

export class Notifier extends service.CocoonService {

    private static NOTIFIER_LOOP_INTERVAL: number = 5000;

    private _queue: any;

    public constructor(options?: service.IGlobalOptions) {
        super(ID, Notifier.NOTIFIER_LOOP_INTERVAL, options);
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

                this._queue = mongoDbQueue(mongoClient.db(), globals.NOTIFICATIONS_QUEUE, {visibility: 1800});
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
        if (this._working) {
            return;
        }

        this.working(true);

        this._queue.get((err: Error, msg: IMongoQueueMessage) => {
            if (err) {
                this.working(false);
                this._logger.error("error getting notification from queue", err.message);
                return;
            }

            if (!msg) {
                this.working(false);
                this._logger.debug("no messages...");
                return;
            }

            if (msg.tries > MAX_RETRIES_NUMBER) {
                this._queue.ack(msg.ack, (error: Error) => {
                    this.working(false);

                    if (error) {
                        this._logger.error("error discarding a notification because it has too many retries",
                            msg.payload.code, error);
                        return;
                    }

                    this.clean(msg.payload);
                    this._logger.info("notification discarded, too many retries");

                });

            } else {

                try {
                    const notification: INotificationData = msg.payload;
                    this._logger.info("found", notification.code);

                    if (!notification.code) {
                        this.working(false);
                        this.clean(notification);
                        this._logger.error("discarding null code notification");
                        return;
                    }

                    this._queue.ping(msg.ack, (pingErr: Error, id: string) => {
                        if (pingErr) {
                            this._logger.error("couldn't ping notification", notification.code);
                            return;
                        }

                        this._logger.info("notification pinged", id);
                    });

                    this.send(notification, (error?: Error) => {
                        if (error) {
                            this.working(false);
                            this._logger.error("send error, will try again later", notification.code, error);

                        } else {
                            this._logger.info("send success", notification.code);

                            this._queue.ack(msg.ack, (ackErr: Error, id: string) => {
                                if (ackErr) {
                                    this.working(false);
                                    this._logger.error("cannot remove notification from queue", ackErr);
                                    return;
                                }

                                this.working(false);
                                this._logger.info("notification removed", id);

                                this._queue.clean();
                                this.clean(notification);
                            });
                        }
                    });

                } catch (ex) {
                    this.working(false);
                    this._logger.error("error", ex.message);
                }
            }
        });
    }

    private send(notification: INotificationData, cb: (error?: Error) => void): void {
        this._logger.info("send ", notification.code);

        if (this._env === globals.CocoonEnvironment.DEVELOP) {
            cb(null);
            return;
        }

        const postData: INotificationPostData = {
            machine: os.hostname(),
            platform: notification.platform,
            staff_error: notification.msg_internal,
            user_error: notification.msg_public,
        };

        const url: string = "https://" + globals.envToHost(this._env) + "/api/v1/compilation/" + notification.code;
        const req = request.post(url, (error: any, response: http.IncomingMessage, body: any) => {
            if (error) {
                cb(error);
                return;

            } else {
                if (response.statusCode >= 200 && response.statusCode < 400) {
                    cb(null);
                    return;

                } else {
                    let errorResponse: compiler.IErrorResponse = {
                        code: -1,
                        description: "An unknown error happened, sorry!",
                        status: "Unknown error",
                    };
                    try {
                        errorResponse = JSON.parse(body);
                    } catch (ex) {
                        this._logger.error(ex.message);
                    }

                    cb(new Error(errorResponse.description));
                    return;
                }
            }
        });
        req.setHeader("Host", globals.envToHost(this._env));
        req.setHeader("Authorization", "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==");

        const form = req.form();

        const outputFile: string = this.getOutputFile(notification);
        if (fse.existsSync(outputFile)) {
            form.append("result", fse.createReadStream(outputFile));
            this._logger.debug("Result of compilation sent");
        }

        const stdout: string = this.getStdout(notification);
        if (fse.existsSync(stdout)) {
            form.append("log", fse.createReadStream(stdout));
            this._logger.debug("Log of compilation sent");
        }

        form.append("data", JSON.stringify(postData));
    }

    private clean(notification: INotificationData): void {
        this._logger.info("clean", notification.code);

        // Clean the sync dir
        if (this._env !== globals.CocoonEnvironment.DEVELOP) {
            try {
                fse.removeSync(path.join(globals.PROJECTS_PATH(this._env),
                    notification.code + "_" + notification.starttime));
                this._logger.info("removed dir: "
                    + path.join(globals.PROJECTS_PATH(this._env), notification.code + "_" + notification.starttime));

            } catch (ex) {
                this._logger.error("cannot clean project dir", ex.message);
            }
        }
    }

    private getOutputFile(notification: INotificationData): string {
        let files: string[] = [];

        try {
            const outputPath: string = path.join(globals.PROJECTS_PATH(this._env),
                notification.code + "_" + notification.starttime, "out");
            files = fse.readdirSync(outputPath);
            files = files.filter((value: string) => {
                return !(value.indexOf(".") === 0 || value.indexOf("..") === 0);
            });
            files = files.map((value: string) => {
                return path.join(globals.PROJECTS_PATH(this._env),
                    notification.code + "_" + notification.starttime, "out", value);
            });

        } catch (ex) {
            this._logger.error("cannot read dir", ex.message);
        }

        return files.pop();
    }

    private getStdout(notification: INotificationData): string {
        return path.join(globals.PROJECTS_PATH(this._env),
            notification.code + "_" + notification.starttime, "stdout.log");
    }
}

new Notifier().start();
