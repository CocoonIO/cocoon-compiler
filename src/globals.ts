"use strict";

import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";

import compareVersions = require("compare-versions");
import extIP = require("external-ip");

const getIP = extIP({
    getIP: "parallel",
    timeout: 10000,
});

export const NOTIFICATIONS_QUEUE: string = "notifications";

export const HOST_DEVELOP = "admin-testing.cocoon.io";
export const HOST_TESTING = "admin-testing.cocoon.io";
export const HOST_PRODUCTION = "admin.cocoon.io";

export enum CocoonEnvironment {
    DEVELOP,
    TESTING,
    PRODUCTION,
}

export const stringToEnv = (env: string) => {
    switch (env) {
        case "develop":
            return CocoonEnvironment.DEVELOP;

        case "testing":
            return CocoonEnvironment.TESTING;

        case "production":
            return CocoonEnvironment.PRODUCTION;

        default:
            return CocoonEnvironment.DEVELOP;
    }
};

export const envToString = (env: CocoonEnvironment) => {
    switch (env) {
        case CocoonEnvironment.DEVELOP:
            return "develop";

        case CocoonEnvironment.TESTING:
            return "testing";

        case CocoonEnvironment.PRODUCTION:
            return "production";

        default:
            return "invalid";
    }
};

export const envToHost = (env: CocoonEnvironment) => {
    switch (env) {
        case CocoonEnvironment.DEVELOP:
            return HOST_DEVELOP;

        case CocoonEnvironment.TESTING:
            return HOST_TESTING;

        case CocoonEnvironment.PRODUCTION:
            return HOST_PRODUCTION;

        default:
            return HOST_DEVELOP;
    }
};

export function COMPILER_WORKSPACE_PATH(env: CocoonEnvironment): string {
    return path.join(getHome(), "opt", "cocoon_compiler", "workspace", envToString(env));
}

const COMPILER_DATA_FOLDER: string = "data";
export function COMPILER_DATA_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_WORKSPACE_PATH(env), COMPILER_DATA_FOLDER);
}

export const CORDOVA_COMPILERS_FOLDER: string = "compilers";
export function CORDOVA_COMPILERS_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_DATA_PATH(env), CORDOVA_COMPILERS_FOLDER);
}

export const CORDOVA_PLATFORMS_FOLDER: string = "platforms";
export function CORDOVA_PLATFORMS_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_DATA_PATH(env), CORDOVA_PLATFORMS_FOLDER);
}

export const CORDOVA_PLUGINS_FOLDER: string = "plugins";
export function CORDOVA_PLUGINS_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_DATA_PATH(env), CORDOVA_PLUGINS_FOLDER);
}

export const CORDOVA_LIBS_FOLDER: string = "libs";
export function CORDOVA_LIBS_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_DATA_PATH(env), CORDOVA_LIBS_FOLDER);
}

export const SDKS_FOLDER: string = "sdks";
export function SDKS_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_DATA_PATH(env), SDKS_FOLDER);
}

const PROJECTS_FOLDER: string = "projects";
export function PROJECTS_PATH(env: CocoonEnvironment): string {
    // Hack to overcome the Windows path 240 chars limit WTF!?
    if (os.platform() === "win32") {
        return path.join(getHome(), envToString(env));
    }

    return path.join(COMPILER_WORKSPACE_PATH(env), PROJECTS_FOLDER);
}

const BUCKET_NAME: string = "cocoon-compiler-data";
export function BUCKET(env: CocoonEnvironment): string {
    if (env === CocoonEnvironment.DEVELOP) {
        return BUCKET_NAME + "-" + envToString(CocoonEnvironment.TESTING);
    }
    return BUCKET_NAME + "-" + envToString(env);
}

const SYNC_FOLDER: string = "sync";
export function SYNC_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_WORKSPACE_PATH(env), SYNC_FOLDER);
}

const S3_STRUCTURE_FILE: string = "s3_structure.json";
export function S3_STRUCTURE_FILE_PATH(env: CocoonEnvironment): string {
    return path.join(COMPILER_WORKSPACE_PATH(env), S3_STRUCTURE_FILE);
}

export function getNetworkIP(callback: (error: Error, ip: string) => void): void {
    getIP((err: Error, ip: string) => {
        if (err) {
            callback(err, null);
            return;
        }
        callback(null, ip);
    });
}

export function getHome(): string {
    return process.env[(os.platform() === "win32") ? "USERPROFILE" : "HOME"];
}

export function getJavaHome(): string {
    const osType: string = os.platform();

    let javaHome: string = null;

    if (osType === "darwin") {
        javaHome = child_process.execSync("/usr/libexec/java_home -v 1.8").toString().trim();
    } else if (osType === "linux") {
        javaHome = process.env.JAVA_HOME;
        if (!javaHome && fse.existsSync("/usr/lib/jvm/default-java")) {
            javaHome = "/usr/lib/jvm/default-java";
        }
    } else if (osType === "win32") {
        const javaHomeAux = path.join(process.cwd().split(path.sep)[0], "Program Files", "Java", "jdk");
        if (fse.existsSync(javaHomeAux)) {
            javaHome = javaHomeAux;
        }
    }

    return javaHome;
}

export function getVersion(): string {
    return require(path.join("..", "package.json")).version;
}

export function getLocalPlatforms(): string[] {
    const platforms: string[] = [];

    const osType: string = os.platform();
    if (osType === "darwin") {
        platforms.push("ios", "osx");

    } else if (osType === "linux") {
        platforms.push("ubuntu", "android");

    } else if (osType === "win32") {
        platforms.push("windows");
    }

    return platforms;
}

export function getMongoDBName(env: CocoonEnvironment): string {
    return "cocoon-compiler-" + envToString(env);
}

/**
 * Helper method to get the Cordova lib
 */
export function getCordova(env: CocoonEnvironment, libVersion: string) {
    const common = require(path.join(CORDOVA_LIBS_PATH(env), "cordova-lib@" + libVersion,
        "node_modules", "cordova-lib")).cordova;
    return (compareVersions(libVersion, "8.0.0") < 0) ? common.raw : common;
}

/**
 * Helper method to get the Cordova events class
 */
export function getCordovaEvents(env: CocoonEnvironment, libVersion: string) {
    return require(path.join(CORDOVA_LIBS_PATH(env), "cordova-lib@" + libVersion,
        "node_modules", "cordova-lib")).events;
}

/**
 * Helper method to get the Cordova ConfigParse
 */
export function getConfigParser(env: CocoonEnvironment, libVersion: string) {
    let commonPath = path.join(CORDOVA_LIBS_PATH(env), "cordova-lib@" + libVersion, "node_modules", "cordova-common");
    if (!fse.existsSync(commonPath)) {
        commonPath = path.join(CORDOVA_LIBS_PATH(env), "cordova-lib@" + libVersion,
            "node_modules", "cordova-lib", "node_modules", "cordova-common");
    }
    return require(commonPath).ConfigParser;
}

/**
 * Helper method to get the Cordova CordovaUtil
 */
export function getCordovaUtil(env: CocoonEnvironment, libVersion: string) {
    return require(path.join(CORDOVA_LIBS_PATH(env), "cordova-lib@" + libVersion,
        "node_modules", "cordova-lib", "src", "cordova", "util"));
}

/**
 * Helper method to get the Cordova project path
 */
export function getProjectPath(env: CocoonEnvironment, compilationCode: string, compilationStartTime: number): string {
    return path.join(PROJECTS_PATH(env), compilationCode + "_" + compilationStartTime);
}

/**
 * Helper method to get the Cordova project path
 */
export function getCordovaProjectPath(env: CocoonEnvironment, compilationCode: string,
                                      compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "workspace");
}

/**
 * Helper method to get the Cordova project path
 */
export function getAndroidResultsPath(env: CocoonEnvironment, compilationCode: string,
                                      compilationStartTime: number, libVersion: string): string {
    const common = path.join(getCordovaProjectPath(env, compilationCode, compilationStartTime), "platforms", "android");
    return (compareVersions(libVersion, "8.0.0") < 0) ? path.join(common, "build", "outputs", "apk") : path.join(common, "app", "build", "outputs", "apk");
}

/**
 * Helper method to get the Cordova project tmp dir
 */
export function getCordovaProjectTmpPath(env: CocoonEnvironment, compilationCode: string,
                                         compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "tmp");
}

/**
 * Helper method to get the Cocoon cloud config.json file path
 */
export function getConfigJsonPath(env: CocoonEnvironment, compilationCode: string,
                                  compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "config.json");
}

/**
 * Helper method to get the Cocoon cloud config.xml file path
 */
export function getCordovaLogPath(env: CocoonEnvironment, compilationCode: string,
                                  compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "cordova.log");
}

/**
 * Helper method to get the Cocoon cloud config.xml file path
 */
export function getConfigXmlPath(env: CocoonEnvironment, compilationCode: string,
                                 compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "config.xml");
}

/**
 * Helper method to get the Cocoon cloud source.zip file path
 */
export function getSourcePath(env: CocoonEnvironment, compilationCode: string, compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "source.zip");
}

/**
 * Helper method to get the Cocoon cloud certificates file path
 */
export function getCertsPath(env: CocoonEnvironment, compilationCode: string, compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "certs");
}

/**
 * Helper method to get the Cocoon cloud icon path
 */
export function getIconsPath(env: CocoonEnvironment, compilationCode: string, compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "icons");
}

/**
 * Helper method to get the Cocoon cloud splash path
 */
export function getSplashesPath(env: CocoonEnvironment, compilationCode: string, compilationStartTime: number): string {
    return path.join(getProjectPath(env, compilationCode, compilationStartTime), "splashes");
}
