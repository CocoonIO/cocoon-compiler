"use strict";

import * as async from "async";
import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as plist from "plist";

import { Builder, IBuilderCallback } from "./builder";
import { BuilderError } from "./builder_error";
import { IIOSBuildJSON } from "./builder_ios";
import { IOSXBuildJSON } from "./builder_osx";
import { IAppleKey, ICompilation } from "./compilation";
import * as globals from "./globals";

export abstract class AppleBuilder extends Builder {

    protected _uuid: string = null;

    protected abstract get distributionCodeSigningIdentity(): string;

    protected abstract get developmentCodeSigningIdentity(): string;

    protected abstract get provisioningExtension(): string;

    protected abstract get platform(): string;

    protected abstract get getJson(): IIOSBuildJSON|IOSXBuildJSON;

    protected abstract get packageFormat(): string;

    protected abstract get findIdentityCommand(): string;

    protected abstract getCreateAppCommand(): string;

    private DO_NOT_CODESIGN: string = "";

    protected constructor(env: globals.CocoonEnvironment, data: ICompilation, configPath: string, logLevel?: string) {
        super(env, data, configPath, logLevel);
    }

    protected build(cb: IBuilderCallback): void {
        this.logger.debug("[build]");

        const tasks: Array<async.AsyncFunction<any, {} | Error>> = [];

        // If there is a key set we get add signing tasks
        if (this.data.platform.key) {
            tasks.push(
                this.createCertsFolder.bind(this),
                this.p12.bind(this),
                this.provisioning.bind(this),
                this.removeKeychain.bind(this),
                this.addKeychain.bind(this),
                this.installProvisioningProfile.bind(this),
                this.buildJson.bind(this),
            );
        }

        tasks.push(
            this.buildPrepare.bind(this),
            this.buildArchive.bind(this),
        );

        if (this.data.platform.key) {
            tasks.push(
                this.buildApp.bind(this),
                this.uninstallProvisioningProfile.bind(this),
            );
        }

        // Start building tasks sequence execution
        async.waterfall(tasks, (err?: BuilderError) => {
            this.logger.debug("[build] clean");

            try {
                if (os.platform() === "darwin") {
                    this.removeKeychain();

                    if (this.env !== globals.CocoonEnvironment.DEVELOP) {
                        fse.removeSync(path.join(globals.getHome(), "Library", "Developer", "Xcode", "DerivedData"));
                    }
                }
            } catch (ex) {
                this.logger.error(ex.message);
            }

            if (err) {
                cb(err);
                return;
            }

            cb();
        });
    }

    protected pack(cb: IBuilderCallback): void {
        this.logger.debug("[pack]");

        let buildPath = path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
            "platforms", this.platform, "build");
        let buildPathContents: string[] = fse.readdirSync(buildPath);

        let appRegex: RegExp = /^.*\.xcarchive/;
        if (this.data.platform.key) {
            appRegex = new RegExp("^.*\." + this.packageFormat);
            const filesAux: string[] = buildPathContents.filter((item) => {
                return appRegex.test(item);
            });
            buildPath = path.join(buildPath, filesAux.pop());
            buildPathContents = fse.readdirSync(buildPath);
        }

        const files: string[] = buildPathContents.filter((item) => {
            return appRegex.test(item);
        });
        const filePaths: string[] = files.map((value: string) => {
            return path.join(buildPath, value);
        });

        this.createOutputZip(filePaths, cb);
    }

    /** Download the p12 and save it to the certs directory as code.p12
     * cb {Function} callback function
     */
    private p12(cb: IBuilderCallback): void {
        this.logger.debug("[build] p12");

        const key: IAppleKey = this.data.platform.key as IAppleKey;
        const p12 = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + ".p12");
        this.getBackendFile(key.p12, p12, (error: Error) => {
            if (error) {
                cb(new BuilderError(
                    "Error downloading the p12: " + error.message,
                    "Internal compiler error (code 0300)",
                ));
                return;
            }

            cb();
        });
    }

    /** Download the provisioning and save it to the certs directory as code.getProvisioningExtension()
     * cb {Function} callback function
     */
    private provisioning(cb: IBuilderCallback): void {
        this.logger.debug("[build] provisioning");

        const key: IAppleKey = this.data.platform.key as IAppleKey;
        const provisioning = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + this.provisioningExtension);
        this.getBackendFile(key.provisioning, provisioning, (error: Error) => {
            if (error) {
                cb(new BuilderError(
                    "Error downloading the provisioning profile: " + error.message,
                    "Internal compiler error (code 0301)",
                ));
                return;
            }

            cb();
        });
    }

    /**
     * Remove the keychain.
     * cb {Function} callback function
     */
    private removeKeychain(cb?: IBuilderCallback): void {
        this.logger.debug("[build] remove keychain");

        const keychain: string = this.data.code + ".keychain-db";

        try {
            child_process.execSync("security default-keychain -s login.keychain-db");
            child_process.execSync("security delete-keychain '" + keychain + "'");

        } catch (e) {
            // this._logger.warn(e.message);
        }

        if (cb) {
            cb();
        }
    }

    /**
     * Prepare the user's keychain so it is accessible later during signing
     * cb {Function} callback function
     */
    private addKeychain(cb: IBuilderCallback): void {
        this.logger.debug("[build] add keychain");

        const key = this.data.platform.key as IAppleKey;
        const keychain = this.data.code + ".keychain-db";
        const p12 = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + ".p12");

        try {
            child_process.execSync("security create-keychain -p '" + key.password + "' '" + keychain + "'");
            child_process.execSync("security unlock-keychain -p '" + key.password + "' '" + keychain + "'");
            child_process.execSync("security set-keychain-settings -t 3600 -l '" + keychain + "'");
            child_process.execSync("security default-keychain -s '" + keychain + "'");
            child_process.execSync("security list-keychains -s '" + keychain + "'");
            child_process.execSync("security import " + p12 + " -k '" + keychain
                + "' -P '" + key.password + "' -A -T /usr/bin/codesign");
            child_process.execSync("security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k '"
                + key.password + "' '" + keychain + "'");
            const output = child_process.execSync(this.findIdentityCommand + " '" + keychain
                + "' | grep '" + this.distributionCodeSigningIdentity + "'").toString().trim();
            const identity = output.match(/"([^"]+)"/)[1];
            this.logger.debug("[build] Using identity: " + identity);

        } catch (e) {
            cb(new BuilderError(
                "Error adding the keychain: " + e.message,
                "Signing error",
            ));
            return;
        }

        cb();
    }

    /** Install the provisioning profile in the profiles directory
     * cb {Function} callback function
     */
    private installProvisioningProfile(cb: IBuilderCallback): void {
        this.logger.debug("[build] install provisioning profile");

        const provisioning = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + this.provisioningExtension);
        child_process.exec("grep UUID -A1 -a '" + provisioning + "' | grep -io '[-A-Z0-9]\\{36\\}'",
            (error: Error, stdout: string) => {
                if (error) {
                    cb(new BuilderError(
                        "Error calling grep on the provisioning profile: " + error.message,
                        "Signing error: Can't get UUID from the provisioning profile",
                    ));
                    return;
                }

                this._uuid = stdout.trim();

                const provisioningsPath = path.join(
                    globals.getHome(),
                    "Library",
                    "MobileDevice",
                    "Provisioning Profiles");
                fse.ensureDir(provisioningsPath, (err: Error) => {
                    if (err) {
                        cb(new BuilderError(
                            "Error creating dir for the provisioning profile: " + err.message,
                            "Internal compiler error (code 0302)",
                        ));
                        return;
                    }

                    const ws = fse.createWriteStream(
                        path.join(provisioningsPath, this._uuid + this.provisioningExtension));
                    ws.on("error", (err2: Error) => {
                        cb(new BuilderError(
                            "Error writing the provisioning profile: " + err2.message,
                            "Internal compiler error (code 0303)",
                        ));
                    });
                    ws.on("close", (ex: Error) => {
                        if (ex) {
                            cb(new BuilderError(
                                "Error writing the provisioning profile: " + ex.message,
                                "Internal compiler error (code 0304)",
                            ));
                            return;
                        }

                        cb(null);
                    });
                    const rs: fse.ReadStream = fse.createReadStream(provisioning);
                    rs.on("error", (err2: Error) => {
                        cb(new BuilderError(
                            "Error writing the provisioning profile: " + err2.message,
                            "Internal compiler error (code 0305)",
                        ));
                    });
                    rs.pipe(ws);
                });
            });
    }

    private buildPrepare(cb: IBuilderCallback): void {
        this.logger.debug("[build] prepare build");

        try {
            this.updateXcConfigs();
        } catch (e) {
            cb(new BuilderError(
                "Error creating xcconfig files: " + e.message,
                "Internal compiler error (code 0307)",
            ));
            return;
        }

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        // Create Schema (needed to build the XCArchive)
        const projectPath = path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
            "platforms", this.platform);
        const schemeInputPath = path.join(path.dirname(require.main.filename), "..",
            "assets", this.platform, "__PROJECT_NAME__.xcscheme");
        const schemesPath = path.join(projectPath, cfg.name() + ".xcodeproj", "xcshareddata", "xcschemes");
        const schemeOutputPath = path.join(schemesPath, cfg.name() + ".xcscheme");

        if (cfg.getAttribute(this.platform + "-version")) {
            try {
                // Set ios-CFBundleShortVersionString and osx-CFBundleShortVersionString
                const plistPath = path.join(globals.getCordovaProjectPath(this.env, this.data.code,
                    this.data.starttime), "platforms", this.platform, cfg.name() + "/" + cfg.name() + "-Info.plist");
                const plistFile = plist.parse(fse.readFileSync(plistPath, { encoding: "UTF8" }));
                plistFile.CFBundleShortVersionString = cfg.getAttribute(this.platform + "-version");
                fse.writeFileSync(plistPath, plist.build(plistFile), { encoding: "UTF8" });
            } catch (e) {
                cb(new BuilderError(
                    "Error replacing schema contents: " + e.message,
                    "Internal compiler error (code 0308)",
                ));
                return;
            }
        }

        fse.ensureDir(schemesPath, (err: Error) => {
            if (err) {
                cb(new BuilderError(
                    "Error creating schema path: " + err.message,
                    "Internal compiler error (code 0309)",
                ));
                return;
            }

            try {
                let schemeContent: string = fse.readFileSync(schemeInputPath, { encoding: "UTF8" });
                schemeContent = schemeContent
                    .replace(new RegExp("__PROJECT_NAME__", "g"), cfg.name())
                    .replace(new RegExp("__CLI__", "g"), cfg.name());
                fse.writeFileSync(schemeOutputPath, schemeContent);
                cb();
            } catch (e) {
                cb(new BuilderError(
                    "Error replacing schema contents: " + e.message,
                    "Internal compiler error (code 0310)",
                ));
                return;
            }
        });
    }

    /**
     * Update the xcconfigs and set all the codesign identities to "Don't Code Sign".
     */
    private updateXcConfigs(): void {
        for (const xcConfigFileName of ["build.xcconfig", "build-debug.xcconfig", "build-release.xcconfig"]) {
            const xcconfigPath = path.join(globals.getCordovaProjectPath(this.env, this.data.code,
                this.data.starttime), "platforms", this.platform, "cordova", xcConfigFileName);
            let xcconfig: string = fse.readFileSync(xcconfigPath, { encoding: "UTF8" });

            xcconfig = xcconfig
                // Won't do anything for the release config
                .replace(new RegExp(this.developmentCodeSigningIdentity, "g"), this.DO_NOT_CODESIGN)
                // Won't do anything for the debug config
                .replace(new RegExp(this.distributionCodeSigningIdentity, "g"), this.DO_NOT_CODESIGN)
                .concat("\n\nVALID_ARCHS = $(ARCHS_STANDARD)\n\nCODE_SIGNING_REQUIRED = NO");
            fse.writeFileSync(xcconfigPath, xcconfig);
        }
    }

    private buildArchive(cb: IBuilderCallback): void {
        this.buildXcode(false, cb);
    }

    private buildApp(cb: IBuilderCallback): void {
        this.buildXcode(true, cb);
    }

    private buildXcode(app: boolean, cb: IBuilderCallback): void {
        this.logger.debug("[build] create xcarchive");

        const xcodebuild: child_process.ChildProcess = child_process.exec(
            (app ? this.getCreateAppCommand() : this.getBuildCommand()),
            {
                cwd: path.join(globals.getCordovaProjectPath(this.env, this.data.code, this.data.starttime),
                    "platforms", this.platform),
                maxBuffer: 52428800, // 20MB
            });
        xcodebuild.stdout.on("data", (buffer: Buffer) => {
            this.logger.info(buffer.toString("UTF8").trim());
            fse.appendFileSync(globals.getCordovaLogPath(this.env, this.data.code, this.data.starttime),
                buffer.toString("UTF8").trim());
        });
        xcodebuild.stderr.on("data", (buffer: Buffer) => {
            this.logger.error(buffer.toString("UTF8").trim());
            fse.appendFileSync(globals.getCordovaLogPath(this.env, this.data.code, this.data.starttime),
                buffer.toString("UTF8").trim());
        });
        xcodebuild.on("error", (err: Error) => {
            cb(new BuilderError(
                "Error calling xcodebuild for building an " + (app ? "app" : "xcarchive") + ": " + err.message,
                "Internal compiler error (code 0311)"));
        });
        xcodebuild.on("exit", (code: number, signal: string) => {
            if (code !== 0) {
                cb(new BuilderError(
                    "Error calling xcodebuild for building an " + (app ? "app" : "xcarchive")
                    + ": process exited abnormally (" + signal + "): "
                    + code,
                    "Internal compiler error (code 0312)",
                ));
                return;
            }

            cb();
        });
    }

    /**
     * Uninstall the provisioning profile.
     * cb {Function} callback function
     */
    private uninstallProvisioningProfile(cb: IBuilderCallback): void {
        this.logger.debug("[build] uninstall provisioning profile");

        const provisioning = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.code + this.provisioningExtension);
        child_process.exec("grep UUID -A1 -a '" + provisioning + "' | grep -io '[-A-Z0-9]\\{36\\}'",
            (error: Error, stdout: string) => {
                if (error) {
                    cb(new BuilderError(
                        "Error calling grep on the provisioning profile: " + error.message,
                        "Internal compiler error (code 0313)",
                    ));
                    return;
                }

                const uuid = stdout.trim();
                const provisioningsPath = path.join(
                    globals.getHome(),
                    "Library",
                    "MobileDevice",
                    "Provisioning Profiles",
                    uuid + this.provisioningExtension);
                if (fse.existsSync(provisioningsPath)) {
                    fse.unlinkSync(provisioningsPath);
                }

                cb();
            });
    }

    private getBuildCommand(): string {
        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        let flag: string = "";
        if (fse.existsSync(path.join(cfg.name() + ".xcworkspace"))) {
            flag = "-workspace '" + cfg.name() + ".xcworkspace'";
        } else {
            flag = "-project '" + cfg.name() + ".xcodeproj'";
        }

        return "xcodebuild \
            -IDEBuildOperationMaxNumberOfConcurrentCompileTasks=4 \
            " + flag + " \
            -scheme '" + cfg.name() + "' \
            -xcconfig '" + path.join("cordova", "build.xcconfig") + "' \
            archive -archivePath '" + path.join("build", cfg.name())
            + "' CODE_SIGN_IDENTITY='' CODE_SIGNING_REQUIRED=NO";
    }
}
