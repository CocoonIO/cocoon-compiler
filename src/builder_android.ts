"use strict";

import * as async from "async";
import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as klawSync from "klaw-sync";
import * as path from "path";

import { Builder, IBuilderCallback, IBuildOptions, IBuildOptionsOpts } from "./builder";
import { BuilderError } from "./builder_error";
import { IAndroidKey, ICompilation } from "./compilation";
import * as globals from "./globals";

export interface IAndroidBuildJSON {
    android: {
        release: {
            keystore: string,
            storePassword: string,
            alias: string,
            password: string,
            keystoreType: string,
        },
    };
}

export class AndroidBuilder extends Builder {

    protected get getJson(): IAndroidBuildJSON {
        const androidKey = this.data.platform.key as IAndroidKey;

        return {
            android: {
                release: {
                    alias: androidKey.alias,
                    keystore: path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
                        this.data.code + ".keystore"),
                    keystoreType: "",
                    password: androidKey.aliaspass,
                    storePassword: androidKey.keystorepass,
                },
            },
        };
    }

    public constructor(env: globals.CocoonEnvironment, data: ICompilation, configPath: string, logLevel?: string) {
        super(env, data, configPath, logLevel);

        this.name = "AndroidBuilder";
    }

    /**
     * Starts the build process.
     * cb {Function} callback function
     */
    protected build(cb: IBuilderCallback): void {
        this.logger.debug("[build]");

        child_process.execSync("yes | " + path.join(globals.SDKS_PATH(this.env), "android-sdks-linux", "tools", "bin", "sdkmanager") + " --licenses");

        const tasks: Array<async.AsyncFunction<any, {} | Error>> = [];

        // If there is a key set we get add signing tasks
        if (this.data.platform.key) {
            tasks.push(
                this.createCertsFolder.bind(this),
                this.keystore.bind(this),
                this.buildJson.bind(this),
            );
        }

        // We compile twice: in debug and release as in debug mode we need to provide
        // both debug and release-unsigned APKs to the user
        if (!this.data.platform.key) {
            tasks.push(async.apply(this.compile.bind(this), this.options(false)));
            tasks.push(async.apply(this.compile.bind(this), this.options(true)));

        } else {
            tasks.push(async.apply(this.compile.bind(this), this.options(true)));
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

    /**
     * Zips the compilation result
     * cb {Function} callback function
     */
    protected pack(cb: IBuilderCallback): void {
        this.logger.debug("[pack]");

        const buildPath: string = globals.getAndroidResultsPath(this.env, this.data.code, this.data.starttime, this.data.libVersion);

        const filterFn = (item: {path: string, stats: object}) => {
            if (this.data.platform.key) {
                return /\/(android|app)(-armv7|-x86)?-release\.apk$/.test(item.path);
            } else {
                return /\/(android|app)(-armv7|-x86)?-(debug|release)(-unsigned)?\.apk$/.test(item.path);
            }
        };
        const files = klawSync(buildPath, {nodir: true}).filter(filterFn);

        if (files.length === 0) {
            cb(new BuilderError(
                "No matching APKs found for packaging",
                "Internal compiler error (code 0200)"));
        }

        this.createOutputZip(files.map((file: any) => file.path), cb);
    }

    protected cleanUp(): void {
        this.stopGradleProcesses();
        super.cleanUp();
    }

    protected removeTmpFiles(): void {
        this.gradleCleanUp();
        super.removeTmpFiles();
    }

    /** Download the keystore and save it to the certs directory as code.keystore
     * cb {Function} callback function
     */
    private keystore(cb: IBuilderCallback): void {
        this.logger.debug("[build] keystore");

        const key: IAndroidKey = this.data.platform.key as IAndroidKey;
        const keystore = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + ".keystore");
        this.getBackendFile(key.keystore, keystore, (error: Error) => {
            if (error) {
                cb(new BuilderError(
                    "Error downloading the keystore: " + error.message,
                    "Internal compiler error (code 0201)",
                ));
                return;
            }

            cb();
        });
    }

    private stopGradleProcesses(): void {
        try {
            this.logger.debug("Starting gradle daemon stopping processes");

            const pathString: string = path.join(globals.getHome(), ".gradle");
            const filterFn = (item: {path: string, stats: object}) => {
                return /([\\\/])gradle$/.test(item.path);
            };
            const files = klawSync(pathString, {nodir: true, filter: filterFn});

            for (const file of files) {
                const gradle = file.path;
                try {
                    this.logger.debug("File: " + gradle + " stdout: " + child_process.execSync(gradle + " --stop"));
                } catch (e) {
                    this.logger.warn("There was an error stopping the gradle daemon: " + e.message
                        + "\n from this file " + gradle);
                }
            }
        } catch (e) {
            this.logger.error("There was an error finding the gradle executables");
        }
    }

    private gradleCleanUp(): void {
        try {
            const gradlePath: string = path.join(globals.getHome(), ".gradle", "caches");
            this.logger.debug("Gradle cache cleanup: " + gradlePath);
            fse.removeSync(gradlePath);
        } catch (e) {
            this.logger.warn("There was an error removing the Gradle cache folder: " + e.message);
        }
    }

    private options(release: boolean): IBuildOptions {
        const opts: IBuildOptionsOpts = {};
        opts.release = release;
        opts.device = true;
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
