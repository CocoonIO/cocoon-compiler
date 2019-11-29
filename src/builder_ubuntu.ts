"use strict";

import * as async from "async";
import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as path from "path";

import { Builder, IBuilderCallback } from "./builder";
import { BuilderError } from "./builder_error";
import { ICompilation } from "./compilation";
import * as globals from "./globals";

export class UbuntuBuilder extends Builder {

    protected get getJson(): null {
        return null;
    }

    public constructor(env: globals.CocoonEnvironment, data: ICompilation, configPath: string, logLevel?: string) {
        super(env, data, configPath, logLevel);

        this.name = "UbuntuBuilder";
    }

    protected build(cb: IBuilderCallback): void {
        this.logger.debug("[build]");

        const tasks: Array<async.AsyncFunction<any, {} | Error>> = [];

        // If there is a key set we get add signing tasks
        if (this.data.platform.key) {
            tasks.push(
                this.createCertsFolder.bind(this),
                this.buildJson.bind(this),
            );
        }

        tasks.push(
            async.apply(this.compile.bind(this), {}),
            this.archive.bind(this),
        );

        // Start building tasks sequence execution
        async.waterfall(tasks, (err: BuilderError) => {
            if (err) {
                cb(err);
                return;
            }

            cb();
        });
    }

    protected pack(cb: IBuilderCallback): void {
        this.logger.debug("[pack]");

        const buildPath = path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
            "platforms", "ubuntu", "native");
        const buildPathContents: string[] = fse.readdirSync(buildPath);
        const files: string[] = buildPathContents.filter((item) => {
            return /^.*\.deb$/.test(item);
        });
        const filePaths: string[] = files.map((value: string) => {
            return path.join(buildPath, value);
        });

        this.createOutputZip(filePaths, cb);
    }

    protected buildJson(cb: IBuilderCallback): void {
        this.logger.debug("[build] create build.json");

        cb();
    }

    private archive(cb: IBuilderCallback): void {
        this.logger.debug("[build] create .deb");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        let cmd: string = "debuild";
        if (!this.data.platform.key) {
            cmd = "debuild -i -us -uc -b";
        }

        let log: string = "";
        const debuild: child_process.ChildProcess = child_process.exec(cmd,
            {
                cwd: path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
                    "platforms", "ubuntu", "native", cfg.packageName()),
                maxBuffer: 52428800, // 20MB
            });
        debuild.stdout.on("data", (buffer: Buffer) => {
            log = log.concat(buffer.toString());
            this.logger.info(buffer.toString("UTF8").trim());
        });
        debuild.stderr.on("data", (buffer: Buffer) => {
            log = log.concat(buffer.toString());
            this.logger.error(buffer.toString("UTF8").trim());
        });
        debuild.on("error", (err: Error) => {
            cb(new BuilderError(
                "Error calling debuild: " + err.message,
                "Internal compiler error (code 0500)",
            ));
        });
        debuild.on("exit", (code: number) => {
            if (code !== 0) {
                cb(new BuilderError(
                    log,
                    log,
                ));
                return;
            }

            cb();
        });
    }
}
