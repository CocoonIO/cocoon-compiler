"use strict";

import * as async from "async";
import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as path from "path";

import { Builder, IBuilderCallback, IBuildOptions, IBuildOptionsOpts } from "./builder";
import { BuilderError } from "./builder_error";
import { ICompilation, IPlatformCompilation, IWindowsKey } from "./compilation";
import * as globals from "./globals";

export interface IWindowsBuildJSON {
    windows: {
        release: {
            packageCertificateKeyFile: string,
            packageThumbprint: string,
            publisherId: string,
        },
    };
}

export class WindowsBuilder extends Builder {

    protected get getJson(): IWindowsBuildJSON {
        const windowsKey = this.data.platform.key as IWindowsKey;

        return {
            windows: {
                release: {
                    packageCertificateKeyFile: path.join(
                        globals.getCertsPath(this.env, this.data.code, this.data.starttime), this.data.code + ".pfx"),
                    packageThumbprint: windowsKey.packageThumbprint,
                    publisherId: windowsKey.publisherId,
                },
            },
        };
    }

    public constructor(env: globals.CocoonEnvironment, data: ICompilation, configPath: string, logLevel?: string) {
        super(env, data, configPath, logLevel);

        this.name = "WindowsBuilder";
    }

    protected build(cb: IBuilderCallback): void {
        this.logger.debug("[build]");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);
        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        if (cfg.name().length() > 40) {
            cb(new BuilderError(
                "msbuild.exe doesn't accept application names longer than 40 characters. Cancelling compilation...",
                "Windows compilations can't have names longer than 40 characters. Choose a shorter name.",
            ));
            return;
        }

        const tasks: Array<async.AsyncFunction<any, {} | Error>> = [];

        // If there is a key set we get add signing tasks
        if (this.data.platform.key) {
            tasks.push(
                this.createCertsFolder.bind(this),
                this.pfx.bind(this),
                this.removePfx.bind(this),
                this.installPfx.bind(this),
                this.buildJson.bind(this),
            );
        }

        tasks.push(async.apply(this.compile.bind(this), this.options()));

        if (this.data.platform.key) {
            tasks.push(
                this.removePfx.bind(this),
            );
        }

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

        const apksPath: string = path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
            "platforms", "windows", "AppPackages");
        const dirContents: string[] = fse.readdirSync(apksPath);
        const apks: string[] = dirContents.filter((item) => {
            return /^CordovaApp\.*/.test(item);
        });
        const files: string[] = apks.map((value: string) => {
            return path.join(apksPath, value);
        });

        this.createOutputZip(files, cb);
    }

    /** Download the p12 and save it to the certs directory as code.p12
     * cb {Function} callback function
     */
    private pfx(cb: IBuilderCallback): void {
        this.logger.debug("[build] pfx");

        const key: IWindowsKey = this.data.platform.key as IWindowsKey;
        const pfx = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + ".pfx");
        this.getBackendFile(key.packageCertificateKeyFile, pfx, (error: Error) => {
            if (error) {
                cb(new BuilderError(
                    "Error downloading the .pfx: " + error.message,
                    "Internal compiler error (code 0600)",
                ));
                return;
            }

            cb();
        });
    }

    private removePfx(cb: IBuilderCallback): void {
        this.logger.debug("[build] remove pfx");

        const platform: IPlatformCompilation = this.data.platform;
        const windowsKey: IWindowsKey = platform.key as IWindowsKey;

        child_process.exec("PowerShell.exe -Command \"Remove-Item -Path Cert:\\CurrentUser\\My\\"
            + windowsKey.packageThumbprint + "\"", (error: Error) => {
                if (error) {
                    this.logger.warn(error.message);
                }

                cb();
            });
    }

    private installPfx(cb: IBuilderCallback): void {
        this.logger.debug("[build] install pfx");

        const platform: IPlatformCompilation = this.data.platform;
        const windowsKey: IWindowsKey = platform.key as IWindowsKey;

        const pfx = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + ".pfx");
        child_process.exec("PowerShell.exe -Command \"certutil -user -p "
            + windowsKey.password + " -importPFX " + pfx + " NoRoot\"", (error: Error) => {
                if (error) {
                    cb(new BuilderError(
                        "Error calling certutil: " + error.message,
                        "Internal compiler error (code 0601)",
                    ));
                    return;
                }

                cb();
            });
    }

    private options(): IBuildOptions {
        const opts: IBuildOptionsOpts = {};
        opts.release = !!this.data.platform.key;
        opts.device = true;
        opts.archs = "x86 x64 arm";
        if (this.data.platform.key) {
            opts.buildConfig = path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
                "build.json");
        }

        const options: IBuildOptions = {};
        options.verbose = true;
        options.platforms = [this.data.platform.name];
        options.options = opts;

        return options;
    }
}
