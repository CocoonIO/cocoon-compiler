"use strict";

import * as async from "async";
import * as bodyParser from "body-parser";
import * as child_process from "child_process";
import * as express from "express";
import * as fse from "fs-extra";
import * as https from "https";
import * as passport from "passport";
import * as path from "path";

import * as globals from "./globals";
import * as services from "./service";

import httpHeaderToken = require("passport-http-header-token");
import pm2 = require("pm2");

interface IErrorResponse {
    code: number;
    message: string;
    description: string;
}

interface IServiceResponse {
    name: string;
    started: boolean;
    working: boolean;
    cpu: number;
    memory: number;
    version: string;
}

const errorToErrorResponse = (err: Error): IErrorResponse => {
    return {
        code: 404,
        description: err.message,
        message: err.name,
    };
};

export const ID: string = "cocoon-api";

class API extends services.CocoonService {

    private static TOKEN: string = "YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==";

    private _app: express.Express;
    private readonly _router: express.Router;

    public constructor(options?: services.IGlobalOptions) {
        super(ID, 0, options);

        this._app = express();
        this._router = express.Router();
    }

    protected loop(): void {
        return;
    }

    protected onStart(): void {
        this._router.use(this.root);

        this._router
            .get("/", this.getRoot);

        this._router.route("/services")
            .get(this.getServices.bind(this));

        this._router.route("/services/:service_id")
            .get(this.getService.bind(this));

        this._router.route("/services/:service_id/log")
            .get(this.getServiceLog.bind(this));

        passport.use(new httpHeaderToken.Strategy({},
            (token: string, done: (error?: Error, token?: string) => void) => {
                process.nextTick(() => {
                    if (token === API.TOKEN) {
                        done(null, token);

                    } else {
                        return done(new Error("Unauthorized"));
                    }
                });
            }));

        this._app.use(bodyParser.urlencoded({extended: true}));
        this._app.use(bodyParser.json());
        this._app.use(passport.initialize());
        this._app.use(passport.session());
        this._app.use("/api", this._router);

        https.createServer({
            cert: fse.readFileSync(path.join(path.dirname(require.main.filename), "..", "certs", "cert.pem")),
            key: fse.readFileSync(path.join(path.dirname(require.main.filename), "..", "certs", "key.pem")),
        }, this._app).listen(55555);
    }

    protected onStop(): void {
        return;
    }

    private root(req: express.Request, res: express.Response, next: express.NextFunction): void {
        passport.authenticate("http-header-token", (err: Error, user: any, info: any) => {
            if (err) {
                return next(err.message);
            }

            if (!user) {
                return next(info.message);
            }

            next();
        })(req, res, next);
    }

    private getRoot(req: express.Request, res: express.Response): void {
        res.json({message: "Cocoon Compiler API"});
    }

    private serviceStatus(status: any, callback: (err?: Error, result?: IServiceResponse) => void): void {
        const response: IServiceResponse = {
            cpu: 0,
            memory: 0,
            name: status.name,
            started: false,
            version: globals.getVersion(),
            working: false,
        };

        response.working = this.isProcessWorking(status.name);
        response.started = status.pm2_env.status === "online";
        response.cpu = status.monit.cpu;
        response.memory = status.monit.memory;

        callback(null, response);
    }

    private getServices(req: express.Request, res: express.Response): void {
        pm2.connect((err: Error) => {
            if (err) {
                res.status(500).json(errorToErrorResponse(err));
                pm2.disconnect();
                return;
            }

            const functions: Array<async.AsyncFunction<any, {} | Error>> = [];
            pm2.list((listErr: Error, list: any[]) => {
                if (listErr) {
                    res.status(500).json(errorToErrorResponse(listErr));
                    pm2.disconnect();
                    return;
                }

                for (const item of list) {
                    functions.push(async.apply(this.serviceStatus.bind(this), item));
                }

                // Type definitions are outdated: https://caolan.github.io/async/docs.html#parallel
                async.parallel(functions,
                    (asyncErr: Error, results: IServiceResponse[]) => {
                        if (asyncErr) {
                            res.status(500).json(errorToErrorResponse(asyncErr));
                        } else {
                            res.json(results);
                        }

                        pm2.disconnect();
                    });
            });
        });
    }

    private getService(req: express.Request, res: express.Response): void {
        pm2.connect((err: Error) => {
            if (err) {
                res.status(500).json(errorToErrorResponse(err));
                pm2.disconnect();
                return;
            }

            pm2.describe(req.params.service_id, (pm2Err: Error, list: any[]) => {
                if (pm2Err) {
                    res.status(500).json(errorToErrorResponse(pm2Err));
                    pm2.disconnect();
                    return;
                }

                const service: any = list.pop();
                if (!service) {
                    res.status(404).send(null);
                    pm2.disconnect();
                    return;
                }

                this.serviceStatus(service, (serviceErr?: Error, result?: IServiceResponse) => {
                    if (serviceErr) {
                        res.status(500).json(errorToErrorResponse(serviceErr));
                    } else {
                        res.json(result);
                    }

                    pm2.disconnect();
                });
            });
        });
    }

    private getServiceLog(req: express.Request, res: express.Response): void {
        pm2.connect((err: Error) => {
            if (err) {
                res.status(500).json(errorToErrorResponse(err));
                pm2.disconnect();
                return;
            }

            pm2.describe(req.params.service_id, (pm2Err: Error, list: any[]) => {
                if (pm2Err) {
                    res.status(500).json(errorToErrorResponse(pm2Err));
                    pm2.disconnect();
                    return;
                }

                const service: any = list.pop();
                if (!service) {
                    res.status(404).send(null);
                    pm2.disconnect();
                    return;
                }

                res.setHeader("content-type", "text/plain");
                if (fse.existsSync(service.pm2_env.pm_out_log_path)) {
                    const output = child_process.execSync("tail -n 100 " + service.pm2_env.pm_out_log_path).toString();
                    res.send(output);

                } else {
                    res.status(404).send(null);
                }

                pm2.disconnect();

            });
        });
    }
}

new API().start();
