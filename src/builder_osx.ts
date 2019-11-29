"use strict";

import * as child_process from "child_process";
import * as path from "path";

import { AppleBuilder } from "./builder_apple";
import { ICompilation } from "./compilation";
import * as globals from "./globals";

export interface IOSXBuildJSON {
    osx: {
        release: {
            codeSignIdentity: string,
            provisioningProfile: string,
        },
    };
}

export class OSXBuilder extends AppleBuilder {

    protected get distributionCodeSigningIdentity(): string {
        return "Mac Developer";
    }

    protected get developmentCodeSigningIdentity(): string {
        return "Mac Developer";
    }

    protected get provisioningExtension(): string {
        return ".provisionprofile";
    }

    protected get platform(): string {
        return "osx";
    }

    protected get getJson(): IOSXBuildJSON {
        return {
            osx: {
                release: {
                    codeSignIdentity: this.distributionCodeSigningIdentity,
                    provisioningProfile: this._uuid,
                },
            },
        };
    }

    protected get packageFormat(): string {
        return "pkg";
    }

    protected get findIdentityCommand(): string {
        return "security find-identity -v";
    }

    public constructor(env: globals.CocoonEnvironment, data: ICompilation, configPath: string, logLevel?: string) {
        super(env, data, configPath, logLevel);

        this.name = "OSXBuilder";
    }

    protected getCreateAppCommand(): string {
        const provisioningPath = path.join(globals.getHome(), "Library", "MobileDevice", "Provisioning Profiles",
            this._uuid + this.provisioningExtension);
        const tmpPath: string = path.join(globals.getCertsPath(this.env, this.data.code, this.data.starttime),
            this.data.starttime + "_tmp.plist");
        child_process.execSync("openssl smime -inform der -verify -noverify -in '" + provisioningPath
            + "' > '" + tmpPath + "'").toString().trim();

        const configParser: any = globals.getConfigParser(this.env, this.data.libVersion);
        const cordovaUtil: any = globals.getCordovaUtil(this.env, this.data.libVersion);

        const xml = cordovaUtil.projectConfig(globals.getProjectPath(this.env, this.data.code, this.data.starttime));
        const cfg = new configParser(xml);

        return "/usr/bin/productbuild --component \
            '" + path.join("build", cfg.name() + ".xcarchive", "Products", "Applications", cfg.name() + ".app") + "' \
            /Applications \
            '" + path.join("build", cfg.name() + "." + this.packageFormat) + "'";
    }
}
