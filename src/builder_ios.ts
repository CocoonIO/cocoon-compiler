"use strict";

import * as child_process from "child_process";
import * as fse from "fs-extra";
import * as path from "path";

import { AppleBuilder } from "./builder_apple";
import { ICompilation } from "./compilation";
import * as globals from "./globals";

export interface IIOSBuildJSON {
    ios: {
        release: {
            codeSignIdentity: string,
            provisioningProfile: string,
        },
    };
}

export class IOSBuilder extends AppleBuilder {

    protected get distributionCodeSigningIdentity(): string {
        return "iPhone Distribution";
    }

    protected get developmentCodeSigningIdentity(): string {
        return "iPhone Developer";
    }

    protected get provisioningExtension(): string {
        return ".mobileprovision";
    }

    protected get platform(): string {
        return "ios";
    }

    protected get getJson(): IIOSBuildJSON {
        return {
            ios: {
                release: {
                    codeSignIdentity: this.distributionCodeSigningIdentity,
                    provisioningProfile: this._uuid,
                },
            },
        };
    }

    protected get packageFormat(): string {
        return "ipa";
    }

    protected get findIdentityCommand(): string {
        return "security find-identity -v -p codesigning";
    }

    public constructor(env: globals.CocoonEnvironment, data: ICompilation, configPath: string, logLevel?: string) {
        super(env, data, configPath, logLevel);

        this.name = "IOSBuilder";
    }

    protected getCreateAppCommand(): string {
        const provisioningPath = path.join(globals.getHome(), "Library", "MobileDevice", "Provisioning Profiles",
            this._uuid + this.provisioningExtension);
        const provisionedStrings = child_process.execSync("strings '" + provisioningPath + "'").toString();
        const method = (provisionedStrings.includes("ProvisionedDevices")) ? "ad-hoc" : "app-store";

        const tmpPath: string = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.starttime + "_tmp.plist");
        child_process.execSync("openssl smime -inform der -verify -noverify -in '" + provisioningPath
            + "' > '" + tmpPath + "'").toString().trim();
        const profileID = child_process.execSync("/usr/libexec/PlistBuddy -c 'Print :UUID' '" + tmpPath + "'")
            .toString().trim();

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        const keychain = this.data.code + ".keychain-db";
        const output = child_process.execSync(this.findIdentityCommand + " '" + keychain
            + "' | grep '" + this.distributionCodeSigningIdentity + "'").toString().trim();
        const certIdentity = output.match(/\) *(.+) "/)[1];
        const teamIdentity = output.match(/"[^"]+\((.+)\)"/)[1];

        this.generateExportOptionsPlist(method, cfg.packageName(), certIdentity, teamIdentity, profileID);

        return "xcodebuild \
            -exportArchive \
            -exportOptionsPlist '" +
            path.join(globals.getCordovaProjectTmpPath(this.env, this.data.code, this.data.starttime) +
                "export_options.plist") + "' \
            -archivePath '" + path.join("build", cfg.name() + ".xcarchive") + "' \
            -exportPath '" + path.join("build", cfg.name() + "." + this.packageFormat) + "'";
    }

    private generateExportOptionsPlist(method: string, bundleId: string, certIdentity: string, teamIdentity: string,
                                       profileName: string): void {
        const templatePlistFile = fse.readFileSync(path.join(path.dirname(require.main.filename), "..", "assets",
            this.platform, "export_options.plist"), {encoding: "UTF8"});

        const result = templatePlistFile.replace(/__METHOD__/g, method)
        .replace(/__APP_BUNDLE_ID__/g, bundleId)
        .replace(/__CERT_ID__/g, certIdentity)
        .replace(/__TEAM_ID__/g, teamIdentity)
        .replace(/__PROFILE_UUID__/g, profileName);

        fse.writeFileSync(path.join(globals.getCordovaProjectTmpPath(this.env, this.data.code, this.data.starttime)
            + "export_options.plist"), result, {encoding: "UTF8"});

    }
}
