"use strict";

import * as async from "async";
import * as child_process from "child_process";
import * as diskUsage from "diskusage";
import * as fse from "fs-extra";
import * as http from "http";
import * as JSZip from "jszip";
import * as klaw from "klaw";
import * as klawSync from "klaw-sync";
import * as log4js from "log4js";
import * as os from "os";
import * as path from "path";
import * as request from "request";
import * as url from "url";

import { IAndroidBuildJSON } from "./builder_android";
import { BuilderError } from "./builder_error";
import { IIOSBuildJSON } from "./builder_ios";
import { IOSXBuildJSON } from "./builder_osx";
import { IWindowsBuildJSON } from "./builder_windows";
import { ICompilation } from "./compilation";
import * as globals from "./globals";

import intercept = require("intercept-stdout");

interface ICocoonElement {
    name: string;
    version: string;
    params?: Array<{
        name: string;
        value: string;
    }>;
}

interface ICordovaPlugin {
    name: string;
    spec: string;
}

interface ICordovaPluginVariables {
    name: string;
    value: string;
}

export interface IBuildOptionsOpts {
    debug?: boolean;
    release?: boolean;
    device?: boolean;
    emulator?: boolean;
    nobuild?: boolean;
    list?: string;
    buildConfig?: string;
    target?: string;
    archs?: string;
}

export interface IBuildOptions {
    verbose?: boolean;
    platforms?: string[];
    options?: IBuildOptionsOpts;
}

export type IBuilderCallback = (error?: BuilderError) => void;

export abstract class Builder {

    protected abstract get getJson(): IAndroidBuildJSON|IIOSBuildJSON|IOSXBuildJSON|IWindowsBuildJSON;

    protected abstract build(cb: IBuilderCallback): void;

    /**
     * Zips the compilation result
     * cb {Function} callback function
     */
    protected abstract pack(cb: IBuilderCallback): void;

    protected name: string;
    protected logger: log4js.Logger;
    private unhookIntercept: () => void;

    protected constructor(protected env: globals.CocoonEnvironment,
                          protected data: ICompilation,
                          protected configPath: string,
                          protected logLevel: string) {
    }

    /**
     * Starts building an app.
     * @param cb Callback executed when the building finishes. With success or error.
     */
    public start(cb: IBuilderCallback): void {
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
            categories: {default: {appenders: ["out"], level: this.logLevel}},
        });
        this.logger = log4js.getLogger(this.name);

        async.waterfall([

            this.init.bind(this),
            this.create.bind(this),
            this.prepare.bind(this),
            this.build.bind(this),
            this.pack.bind(this),

        ], (err: BuilderError) => {
            process.chdir(globals.getProjectPath(this.env, this.data.code, this.data.starttime));

            try {
                this.unhookIntercept();
            } catch (ex) {
                this.logger.warn(ex.message);
            }

            if (this.env !== globals.CocoonEnvironment.DEVELOP) {
                this.cleanUp();
            }

            if (err) {
                this.logger.debug("Builder error", err);
            }

            cb(err);
        });
    }

    /**
     * Helper method to get any file from the backend server
     */
    protected getBackendFile(fileUrl: string, outputPath: string, cb: (err?: Error) => void): void {
        const ws: fse.WriteStream = fse.createWriteStream(outputPath);
        ws.on("error", (err: Error) => {
            cb(err);
        });
        ws.on("close", (ex: Error) => {
            if (ex) {
                cb(new BuilderError(ex.message, "Internal compiler error (code 0100)"));
                return;
            }
            cb();
        });

        const parsedUrl: url.Url = url.parse(fileUrl);
        if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
            const req: request.Request = request({
                headers: {
                    Authorization: "Basic YWRtaW46ZS8zN2l+ZSVJQUJPMUIqXw==",
                    Host: globals.envToHost(this.env),
                },
                method: "GET",
                timeout: 10000,
                uri: fileUrl,

            })
                .on("error", (error) => {
                    cb(error);
                    return;
                })
                .on("response", (response: http.IncomingMessage) => {
                    if (response.statusCode >= 400) {
                        cb(new Error("Cannot read response from server"));
                    }
                });
            req.pipe(ws);
        } else {
            if (!path.isAbsolute(fileUrl)) {
                fileUrl = path.join(__dirname, "..", this.configPath, fileUrl);
            }

            const rs: fse.ReadStream = fse.createReadStream(fileUrl);
            rs.on("error", (err: Error) => {
                cb(err);
            });
            rs.pipe(ws);
        }
    }

    protected createCertsFolder(cb: IBuilderCallback): void {
        this.logger.debug("[build] create certs folder");

        fse.ensureDir(globals.getCertsPath(this.env, this.data.code, this.data.starttime), (err: any) => {
            if (err) {
                this.logger.error("cannot create certificates folder");
                cb(new BuilderError(err, "Internal compiler error (code 0115)"));
                return;
            }

            cb();
        });
    }

    /**
     * Starts the compilation process.
     * cb {Function} callback function
     */
    protected compile(options: IBuildOptions, cb: IBuilderCallback): void {
        this.logger.debug("[build] call cordova");

        try {
            process.chdir(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime));
            globals.getCordova(this.env, this.data.libVersion).build(options)
                .then(() => {
                    cb();
                })
                .catch((error: Error) => {
                    this.logger.error(error);
                    cb(new BuilderError(error.message, error.message));
                });
        } catch (e) {
            this.logger.error(e);
            cb(new BuilderError(e.message, e.message));
        }
    }

    /**
     * Creates the result Zip file in the "out" folder.
     * files: string[] An array with the paths to the files we need to zip
     * cb: Function The callback function
     */
    protected createOutputZip(files: string[], cb: (error?: Error) => void): void {
        const filename = this.data.code + "_" + this.data.platform.name + "_" + new Date().getTime() + ".zip";
        const outputFolder = path.join(globals.getProjectPath(this.env, this.data.code, this.data.starttime), "out");
        if (!fse.existsSync(outputFolder)) {
            fse.mkdirSync(outputFolder);
        }
        const outputPath: string = path.join(outputFolder, filename);

        const zip = new JSZip();
        for (const file of files) {
            const stat: fse.Stats = fse.statSync(file);
            if (stat.isFile()) {
                const name = file.split("/").pop();
                const input = fse.readFileSync(file);
                zip.file(name, input);
            } else {
                const dir = file.split("/").pop();
                const filesInDir = klawSync(file, {nodir: true});
                for (const fileInDir of filesInDir) {
                    const name = fileInDir.path.substring(file.length);
                    const input = fse.readFileSync(fileInDir.path);
                    zip.folder(dir).file(name, input);
                }
            }
        }
        zip.generateNodeStream({type: "nodebuffer", streamFiles: true})
            .pipe(fse.createWriteStream(outputPath))
            .on("finish", () => {
                cb();
            });
    }

    /**
     * Create a build.json file so Cordova gets the signing parameters from there
     * cb {Function} callback function
     */
    protected buildJson(cb: IBuilderCallback): void {
        this.logger.debug("[build] create build.json");

        try {
            fse.writeFileSync(path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
                "build.json"), JSON.stringify(this.getJson, null, " "), { encoding: "UTF8" });
        } catch (e) {
            cb(new BuilderError(
                "Error writing the build.json: " + e.message,
                "Internal compiler error (code 0120)",
            ));
        } finally {
            cb();
        }
    }

    protected cleanUp(): void {

        const root = os.platform() === "win32" ? "c:" : "/";

        diskUsage.check(root, (rootErr, rootSpc) => {
            if (rootErr) {
                this.logger.warn("There was an error removing the temporary files: " + rootErr.message);
            } else {
                diskUsage.check(globals.getHome(), (homeErr, homeSpc) => {
                    if (homeErr) {
                        this.logger.warn("There was an error removing the temporary files: " + homeErr.message);
                    } else {
                        this.logger.debug("Available space in " + root + " is: " +
                            rootSpc.available + " bytes (" + (rootSpc.available / (1024 ** 3)).toFixed(2) + " GB)");
                        this.logger.debug("Available space in " + globals.getHome() + " is: " +
                            homeSpc.available + " bytes (" + (homeSpc.available / (1024 ** 3)).toFixed(2) + " GB)");

                        if (rootSpc.available < (1 * (1024 ** 3)) || rootSpc.available < (rootSpc.total * 25 / 100) ||
                            homeSpc.available < (10 * (1024 ** 3)) || homeSpc.available < (homeSpc.total * 25 / 100)) {
                            this.logger.debug("Cleaning cache...");

                            try {
                                this.removeTmpFiles();
                            } catch (e) {
                                this.logger.warn("There was an error removing the temporary files: " + e.message);
                            }

                            try {
                                this.logger.debug("NPM cache cleanup: " + path.join(globals.getHome(),
                                    ".cordova", "lib", "npm_cache"));
                                fse.removeSync(path.join(globals.getHome(), ".cordova", "lib", "npm_cache"));

                            } catch (e) {
                                this.logger.warn("There was an error removing the NPM cache folder: " + e.message);
                            }
                        }
                    }
                });
            }
        });
    }

    protected removeTmpFiles(): void {
        let directory: string;
        if (os.platform() !== "win32") {
            directory = os.tmpdir();
        } else {
            directory = path.join("c:", "cygwin64", "tmp");
        }

        this.logger.debug("Temporary files cleanup: " + directory);

        const files: string[] = fse.readdirSync(directory);
        files.forEach((value: string) => {
            try {
                const dir: string = path.join(os.tmpdir(), value);
                const stat: fse.Stats = fse.statSync(dir);
                if (stat.isDirectory()) {
                    if (value.indexOf("npm-") === 0 || value.indexOf("git") === 0) {
                        if (os.platform() === "win32" || stat.uid === process.getuid()) {
                            fse.removeSync(dir);
                        }
                    }
                }
            } catch (e) {
                this.logger.warn(e.message);
            }
        });
    }

    /**
     * Initializes the builder to be ready to build
     * cb {Function} callback function
     */
    private init(cb: IBuilderCallback): void {
        this.logger.debug("[init]");

        async.waterfall([

            this.getXml.bind(this),
            this.getSource.bind(this),
            this.createFolder.bind(this),
            this.getBinaries.bind(this),

        ], cb);
    }

    private create(cb: IBuilderCallback): void {
        this.logger.debug("[create]");

        async.waterfall([

            this.cordovaCreate.bind(this),
            this.copyConfig.bind(this),
            this.extractSource.bind(this),
            this.icon.bind(this),
            this.splash.bind(this),

        ], cb);
    }

    private prepare(cb: IBuilderCallback): void {
        this.logger.debug("[prepare]");

        async.waterfall([

            this.checkPlatforms.bind(this),
            this.checkPlugins.bind(this),
            this.setupLog.bind(this),
            this.cordovaPreparePlatforms.bind(this),
            this.cordovaPreparePlugins.bind(this),
            this.cordovaPrepareRaw.bind(this), // So hooks work properly

        ], cb);
    }

    private getXml(cb: IBuilderCallback): void {
        this.logger.debug("[init] get xml");

        this.getBackendFile(this.data.config,
            globals.getConfigXmlPath(this.env, this.data.code, this.data.starttime), (error: Error) => {
                if (error) {
                    cb(new BuilderError(
                        "Error getting the config.xml file: " + error.message,
                        "Internal compiler error (code 0101)"));
                    return;
                }

                cb();
            });
    }

    private getSource(cb: IBuilderCallback): void {
        this.logger.debug("[init] get source");

        this.getBackendFile(this.data.source,
            globals.getSourcePath(this.env, this.data.code, this.data.starttime), (error: Error) => {
                if (error) {
                    cb(new BuilderError(
                        "Error getting the source.zip file: " + error.message,
                        "Internal compiler error (code 0102)"));
                    return;
                }

                cb();
            });
    }

    /**
     * Creates the folder installing the npm module for the cordova-lib specified in the config.json
     * cb {Function} callback function
     */
    private createFolder(cb: IBuilderCallback): void {
        this.logger.debug("[init] create cordova-lib folder");

        fse.ensureDir(path.join(globals.CORDOVA_LIBS_PATH(this.env), "cordova-lib@" + this.data.libVersion),
            (err: Error) => {
                if (err) {
                    cb(new BuilderError(
                        "Error creating the cordova-lib folder: " + err.message,
                        "Internal compiler error (code 0103)"));
                    return;
                }

                cb();
            });
    }

    /**
     * Installs the npm module for the cordova-lib specified in the config.json
     * cb {Function} callback function
     */
    private getBinaries(cb: IBuilderCallback): void {
        this.logger.debug("[init] get cordova-lib binaries");

        try {
            globals.getCordova(this.env, this.data.libVersion);
            cb();
            return;

        } catch (e) {
            this.logger.debug(e.message);
        }

        const command: string = "npm install --prefix "
            + path.join(globals.CORDOVA_LIBS_PATH(this.env), "cordova-lib@" + this.data.libVersion)
            + " cordova-lib@" + this.data.libVersion;
        console.log(command);
        const npm: child_process.ChildProcess = child_process.exec(command, {
            cwd: path.join(globals.CORDOVA_LIBS_PATH(this.env), "cordova-lib@" + this.data.libVersion),
            env: {
                APPDATA: process.env.APPDATA,
                HOME: globals.getHome(),
                PATH: process.env.PATH,
            },
            maxBuffer: 52428800, // 20MB
        });
        npm.stdout.on("data", (buffer: Buffer) => {
            this.logger.debug(buffer.toString("UTF8").trim());
        });
        npm.stderr.on("data", (buffer: Buffer) => {
            this.logger.error(buffer.toString("UTF8").trim());
        });
        npm.on("error", (err: Error) => {
            cb(new BuilderError(
                "Error calling npm install: " + err.message,
                "Internal compiler error (code 0104)"));
        });
        npm.on("exit", (code: number, signal: string) => {
            if (code !== 0) {
                cb(new BuilderError(
                    "Error calling npm install: process exited abnormally (" + signal + "): " + code,
                    "Internal compiler error (code 0105)"));
                return;
            }

            cb();
        });
    }

    /**
     * Creates the cordova project.
     * cb {Function} callback function
     */
    private cordovaCreate(cb: IBuilderCallback): void {
        this.logger.debug("[create] cordova");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        const options: any = {
            lib: {
                www: {
                    template: true,
                    url: path.join(globals.CORDOVA_LIBS_PATH(this.env), "cordova-lib@" + this.data.libVersion,
                        "node_modules", "cordova-app-hello-world"),
                    version: "",
                },
            },
        };
        try {
            globals.getCordova(this.env, this.data.libVersion).create(
                globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime), // Dir for the project
                cfg.packageName(this.data.platform),       // App id
                cfg.name(),                                 // App name
                options,                                    // Options
            ).then(() => {
                cb();
            }).catch((error: Error) => {
                cb(new BuilderError(error.message, error.message));
            });

        } catch (e) {
            cb(new BuilderError(e.message, e.message));
        }
    }

    /**
     * Copies the config.xml from the project directory to the Cordova workspace
     * cb {Function} callback function
     */
    private copyConfig(cb: IBuilderCallback): void {
        this.logger.debug("[create] copy config.xml");

        const xml = globals.getCordovaUtil(this.env, this.data.libVersion)
            .projectConfig(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime));
        const rs = fse.createReadStream(globals.getConfigXmlPath(this.env, this.data.code, this.data.starttime));
        rs.on("error", (err: Error) => {
            cb(new BuilderError(
                "Error copying the config.xml file: " + err.message,
                "Internal compiler error (code 0106)"));
        });
        const ws = fse.createWriteStream(xml);
        ws.on("error", (err: Error) => {
            cb(new BuilderError(
                "Error copying the config.xml file: " + err.message,
                "Internal compiler error  (code 0107)"));
        });
        ws.on("close", (ex: Error) => {
            if (ex) {
                cb(new BuilderError(
                    "Error copying the config.xml file: " + ex.message,
                    "Internal compiler error (code 0108)"));
                return;
            }

            cb();
        });
        rs.pipe(ws);
    }

    /**
     * Copies the source.zip content from the project directory to the Cordova workspace www folder
     * cb {Function} callback function
     */
    private extractSource(cb: IBuilderCallback): void {
        this.logger.debug("[create] extract source.zip");

        const dst = path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime), "www");
        try {
            fse.removeSync(dst);
            fse.mkdirSync(dst);

        } catch (e) {
            cb(new BuilderError(
                "Error creating the www folder: " + e.message,
                "Internal compiler error (code 0109)"));
        }

        try {
            fse.mkdirsSync(globals.getCordovaProjectTmpPath(this.env, this.data.code, this.data.starttime));

        } catch (e) {
            cb(new BuilderError(
                "Error creating the tmp folder: " + e.message,
                "Internal compiler error (code 0110)"));
        }

        try {
            fse.readFile(globals.getSourcePath(this.env, this.data.code, this.data.starttime), (error, data) => {
                if (error) {
                    cb(new BuilderError(error.message, "Error extracting the zip contents. Check your zip file."));
                    return;
                }
                JSZip().loadAsync(data)
                    .then((contents) => {
                        const promises = [];
                        for (const filename in contents.files) {
                            if (!contents.files.hasOwnProperty(filename)) {
                                continue;
                            }
                            const file = contents.files[filename];
                            const dest = globals.getCordovaProjectTmpPath(this.env, this.data.code, this.data.starttime)
                                + "/" + filename;
                            if (file.dir) {
                                fse.ensureDirSync(dest);
                            } else {
                                promises.push(file.async("nodebuffer")
                                    .then((content) => {
                                        fse.outputFileSync(dest, content);
                                    }));
                            }
                        }
                        return Promise.all(promises);
                    }).then(() => {
                    const content: string[] = [];
                    klaw(globals.getCordovaProjectTmpPath(this.env, this.data.code, this.data.starttime))
                        .on("data", (item) => {
                            content.push(item.path);
                        })
                        .on("end", () => {
                            const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
                            const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

                            const xml = cordovaUtil.projectConfig(globals.getCordovaProjectPath(this.env,
                                this.data.code, this.data.starttime));
                            const cfg = new configParser(xml);

                            const icons = cfg.getIcons(this.data.platform.name);
                            const splashes = cfg.getSplashScreens(this.data.platform.name);

                            const regExp = /^.*index\.html?$/;
                            let found = false;
                            let src = globals.getCordovaProjectTmpPath(
                                this.env,
                                this.data.code,
                                this.data.starttime);

                            content.forEach((value: string) => {
                                if (!found) {
                                    if (regExp.test(value)) {
                                        src = path.dirname(value);
                                        found = true;
                                    }
                                }

                                for (const icon of icons) {
                                    try {
                                        if (os.platform() === "win32") {
                                            icon.src = icon.src.replace("/", "\\");
                                        }

                                        if (value.indexOf(icon.src) !== -1) {
                                            fse.copySync(value, path.join(globals.getCordovaProjectPath(this.env,
                                                this.data.code, this.data.starttime), icon.src));
                                        }

                                    } catch (e) {
                                        this.logger.debug("Couldn't extract icon: " + icon.src);
                                    }
                                }

                                for (const splash of splashes) {
                                    try {
                                        if (os.platform() === "win32") {
                                            splash.src = splash.src.replace("/", "\\");
                                        }

                                        if (value.indexOf(splash.src) !== -1) {
                                            fse.copySync(value, path.join(globals.getCordovaProjectPath(this.env,
                                                this.data.code, this.data.starttime), splash.src));
                                        }

                                    } catch (e) {
                                        this.logger.debug("Couldn't extract splash: " + splash.src);
                                    }
                                }
                            });

                            try {
                                fse.copySync(src, dst);
                            } catch (e) {
                                cb(new BuilderError(
                                    "Error extracting the zip contents: " + e.message,
                                    "Error extracting the zip contents. Check that your zip file is valid."));
                            }

                            try {
                                const hooksSrc = path.join(globals.getCordovaProjectTmpPath(
                                    this.env,
                                    this.data.code,
                                    this.data.starttime), "hooks");
                                const hooksDest = path.join(globals.getCordovaProjectPath(this.env, this.data.code,
                                    this.data.starttime), "hooks");
                                fse.removeSync(hooksDest);
                                fse.mkdirSync(hooksDest);
                                fse.copySync(hooksSrc, hooksDest);
                            } catch (e) {
                                this.logger.debug("Couldn't extract hooks");
                            }

                            try {
                                const nodeModSrc = path.join(globals.getCordovaProjectTmpPath(
                                    this.env,
                                    this.data.code,
                                    this.data.starttime), "node_modules");
                                const nodeModDest = path.join(globals.getCordovaProjectPath(
                                    this.env,
                                    this.data.code,
                                    this.data.starttime), "node_modules");
                                fse.removeSync(nodeModDest);
                                fse.mkdirSync(nodeModDest);
                                fse.copySync(nodeModSrc, nodeModDest);
                            } catch (e) {
                                this.logger.debug("Couldn't extract node_modules");
                            }

                            cb();
                        });
                }).catch((err) => {
                    cb(new BuilderError(
                        "Error extracting the zip contents: " + err.message,
                        "Error extracting the zip contents. " +
                        "Check that your zip file is valid and filenames do not contain foreign characters"));
                });
            });
        } catch (e) {
            cb(new BuilderError(
                "Error extracting the zip contents: " + e.message,
                "Error extracting the zip contents. Check that your zip file is valid."));
        }
    }

    /**
     * Download the icon
     */
    private icon(cb: IBuilderCallback): void {
        this.logger.debug("[create] icon");

        // Ubuntu only fix, remove when it"s fixed in cordova lib
        if (this.data.platform.name === "ubuntu") {
            if (!fse.existsSync(path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
                    "www", "img", "logo.png"))) {
                try {
                    fse.copySync(
                        path.join(path.dirname(require.main.filename), "..", "assets", "icon.png"),
                        path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
                            "www", "img", "logo.png"));

                } catch (e) {
                    this.logger.debug("Can't copy ubuntu icon: " + e.message);
                }
            }
        }

        if (this.data.platform.icon) {
            fse.ensureDir(globals.getIconsPath(this.env, this.data.code, this.data.starttime), (err: Error) => {
                if (err) {
                    cb(new BuilderError(
                        "Error creating the icons folder: " + err.message,
                        "Internal compiler error (code 0111)"));
                    return;
                }

                const iconPath = path.join(globals.getIconsPath(this.env, this.data.code, this.data.starttime),
                    this.data.platform.name + ".png");
                this.getBackendFile(this.data.platform.icon.url, iconPath, (error: Error) => {
                    if (error) {
                        cb(new BuilderError(
                            "Error downloading the icon: " + error.message,
                            "Internal compiler error (code 0112)"));
                        return;
                    }

                    cb();
                });
            });

        } else {
            cb();
        }
    }

    /**
     * Download the splash
     */
    private splash(cb: IBuilderCallback): void {
        this.logger.debug("[create] splash");

        if (this.data.platform.splash) {
            fse.ensureDir(globals.getSplashesPath(this.env, this.data.code, this.data.starttime), (err: Error) => {
                if (err) {
                    cb(new BuilderError(
                        "Error creating the splash folder: " + err.message,
                        "Internal compiler error (code 0113)"));
                    return;
                }

                const splashPath = path.join(globals.getSplashesPath(this.env, this.data.code, this.data.starttime),
                    this.data.platform.name + ".png");
                this.getBackendFile(this.data.platform.splash.url, splashPath, (error: Error) => {
                    if (error) {
                        cb(new BuilderError(
                            "Error downloading the splash: " + error.message,
                            "Internal compiler error (code 0114)"));
                        return;
                    }

                    cb();
                });
            });

        } else {
            cb();
        }
    }

    /**
     * Setup the Cordova platforms that will be installed in the prepare phase.
     * If the plugin doesn't have a spec with add the "*" one, otherwise the prepare phase won't install it.
     * Note: We currently process also the cocoon:platform tag and transform it into the standard cordova engine tag.
     * This should disappear in the near future
     * cb {Function} callback function
     */
    private checkPlatforms(cb: IBuilderCallback): void {
        this.logger.debug("[prepare] check platforms");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getCordovaProjectPath(this.env, this.data.code,
            this.data.starttime));
        const cfg = new configParser(xml);

        // TODO: Remove this block when engine tag is integrated in the Cocoon backend
        const cocoonPlatforms: any[] = cfg.doc.getroot().findall("cocoon:platform");
        if (cocoonPlatforms.length > 0) {
            // Migrate the cocoon:platform tags to engine
            for (const cocoonPlatform of cocoonPlatforms) {
                const platform: ICocoonElement = cocoonPlatform.attrib;
                cfg.addEngine(platform.name, platform.version ? platform.version : "*");
            }
            // Delete the cocoon:platform tags
            for (const cocoonPlatform of cocoonPlatforms) {
                cfg.doc.getroot().remove(cocoonPlatform);
            }
        }
        // TODO END

        // Check that all the platforms have a version, otherwise set it to "*"
        const platforms: any = cfg.getEngines();
        if (platforms.length === 0) {
            cfg.addEngine(this.data.platform.name, "*");

        } else {
            for (const platform of platforms) {
                if (!platform.spec) {
                    platform.spec = "*";
                }
            }
        }

        cfg.write();

        cb();
    }

    /**
     * Setup the Cordova plugins that will be installed in the prepare phase.
     * If the plugin doesn't have a spec with add the "*" one, otherwise the prepare phase won't install it.
     * Note: We currently process also the cocoon:platform tag and transform it into the standard cordova engine tag.
     * This should disappear in the near future
     * cb {Function} callback function
     */
    private checkPlugins(cb: IBuilderCallback): void {
        this.logger.debug("[prepare] check plugins");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getCordovaProjectPath(this.env, this.data.code,
            this.data.starttime));
        const cfg = new configParser(xml);

        // TODO: Remove this block when plugin tag is integrated in the Cocoon backend
        const cocoonPlugins: any[] = cfg.doc.getroot().findall("cocoon:plugin");
        if (cocoonPlugins.length > 0) {
            // Migrate the cocoon:plugin tags to plugin
            for (const cocoonPlugin of cocoonPlugins) {
                const plugin: ICocoonElement = cocoonPlugin.attrib;
                const cordovaPlugin: ICordovaPlugin = {
                    name: plugin.name,
                    spec: plugin.version ? plugin.version : "*",
                };

                // Migrate the plugin variables
                const variables: ICordovaPluginVariables[] = [];
                for (const child of cocoonPlugin.getchildren()) {
                    if (child.tag === "param") {
                        variables.push({
                            name: child.attrib.name,
                            value: child.attrib.value,
                        });
                    }
                }

                cfg.addPlugin(cordovaPlugin, variables);
            }
            // Delete the cocoon:plugin tags
            for (const cocoonPlugin of cocoonPlugins) {
                cfg.doc.getroot().remove(cocoonPlugin);
            }

            // Install the plugin
        }
        // TODO END

        // Check that all the plugins have a version, otherwise set it to "*"
        const plugins: any = cfg.getPlugins();
        for (const plugin of plugins) {
            if (!plugin.spec) {
                plugin.spec = "*";
            }
        }

        cfg.write();

        cb();
    }

    /**
     * Redirect Cordova logging to our logger
     * cb {Function} callback function
     */
    private setupLog(cb: IBuilderCallback): void {
        this.logger.debug("[prepare] setup log");

        this.unhookIntercept = intercept((log: string) => {
            fse.appendFileSync(globals.getCordovaLogPath(this.env, this.data.code, this.data.starttime), log);
        });

        cb();
    }

    /**
     * Prepare the project to be compile. This will install all the engines defined in the config.xml.
     * cb {Function} callback function
     */
    private cordovaPreparePlatforms(cb: IBuilderCallback): void {
        this.logger.debug("[prepare] cordova restore platforms");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getCordovaProjectPath(this.env, this.data.code,
            this.data.starttime));
        const cfg = new configParser(xml);

        const engines: any[] = cfg.doc.getroot().findall("engine");

        try {
            process.chdir(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime));

            const tasks: Array<async.AsyncFunction<any, {} | Error>> = [];
            for (const engine of engines) {
                if (engine.attrib.name === this.data.platform.name) {
                    tasks.push(async.apply(this.installPlatform.bind(this), engine));
                }
            }

            async.waterfall(tasks, (err: BuilderError) => {
                if (err) {
                    this.logger.debug(err.message);
                    cb(new BuilderError(err.message, err.message));
                    return;
                }

                cb();
            });

        } catch (e) {
            this.logger.debug(e.stack);
            cb(new BuilderError(e.message, e.message));
        }
    }

    private installPlatform(engine: any, cb: IBuilderCallback): void {
        this.logger.debug("[prepare] adding engine " + engine.attrib.name + "@" + (engine.attrib.spec || "latest"));
        // engines MUST use "latest". "x" or "*" don't work

        globals.getCordova(this.env, this.data.libVersion)
            .platform("add", engine.attrib.name + "@" + (engine.attrib.spec || "latest"),
                {
                    fetch: true,
                    searchpath: globals.CORDOVA_PLUGINS_PATH(this.env),
                    verbose: true,
                }).then(() => {
            cb();
        }).catch((error: Error) => {
            this.logger.error(error);
            cb(new BuilderError(error.message, error.message));
        });
    }

    /**
     * Prepare the project to be compile. This will install all the plugins defined in the config.xml.
     * cb {Function} callback function
     */
    private cordovaPreparePlugins(cb: IBuilderCallback): void {
        this.logger.debug("[prepare] cordova restore plugins");

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getCordovaProjectPath(this.env, this.data.code,
            this.data.starttime));
        const cfg = new configParser(xml);

        const plugins: any[] = cfg.doc.getroot().findall("plugin");

        try {
            process.chdir(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime));

            const tasks: Array<async.AsyncFunction<any, {} | Error>> = [];
            for (const plugin of plugins) {
                tasks.push(async.apply(this.installPlugin.bind(this), plugin));
            }

            async.waterfall(tasks, (err: BuilderError) => {
                if (err) {
                    this.logger.error(err);
                    cb(new BuilderError(err.message, err.message));
                    return;
                }

                cb();
            });

        } catch (e) {
            this.logger.error(e);
            cb(new BuilderError(e.message, e.message));
        }
    }

    private installPlugin(plugin: any, cb: IBuilderCallback): void {
        let pluginID = "";
        const regexURL = new RegExp("^(https?:\\/\\/)", "i");
        if (regexURL.test(plugin.attrib.spec)) {
            pluginID = plugin.attrib.spec; // if it"s a URL
        } else if (regexURL.test(plugin.attrib.name)) {
            pluginID = plugin.attrib.name;
        } else {
            pluginID = plugin.attrib.name + "@" + (plugin.attrib.spec || "*");
        } // plugins MUST use "x" or "*". "latest" doesn't work
        this.logger.debug("[prepare] adding plugin " + pluginID);

        const variables = plugin.findall("variable");
        const cliVariables: { [key: string]: string } = {};
        for (const variable of variables) {
            cliVariables[variable.attrib.name] = variable.attrib.value;
        }

        globals.getCordova(this.env, this.data.libVersion).plugin("add", pluginID,
            {
                cli_variables: cliVariables,
                searchpath: globals.CORDOVA_PLUGINS_PATH(this.env),
                verbose: true,
            }).then(() => {
            cb();
        }).catch((error: Error) => {
            this.logger.error(error);
            cb(new BuilderError(error.message, error.message));
        });
    }

    /**
     * Prepare the project to be compile. This will launch the raw prepare from Cordova.
     * cb {Function} callback function
     */
    private cordovaPrepareRaw(cb: IBuilderCallback): void {
        globals.getCordova(this.env, this.data.libVersion).prepare(
            {
                options: {
                    searchpath: globals.CORDOVA_PLUGINS_PATH(this.env),
                },
                platforms: [this.data.platform.name],
            }).then(() => {
            cb();
        }).catch((error: Error) => {
            this.logger.error(error);
            cb(new BuilderError(error.message, error.message));
        });
    }
}
