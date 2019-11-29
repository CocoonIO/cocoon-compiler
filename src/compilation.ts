"use strict";

export interface IPlatformCompilation {
    name: string;
    icon?: {
        url: string,
    };
    splash?: {
        url: string,
    };
    key?: IAndroidKey | IAppleKey | IWindowsKey | IUbuntuKey;
    archs?: string;
}

export interface IAndroidKey {
    keystore: string;
    keystorepass: string;
    alias: string;
    aliaspass: string;
}

export interface IAppleKey {
    p12: string;
    provisioning: string;
    password: string;
}

export interface IWindowsKey {
    packageCertificateKeyFile: string;
    password: string;
    packageThumbprint: string;
    publisherId: string;
}

export interface IUbuntuKey {
    sugar: string;
    spice: string;
    everythingNice: any[];
    CHEMICAL_X: object;
}

export interface ICompilation {
    code: string;
    platform: IPlatformCompilation;
    config: string;
    source: string;
    libVersion: string;
    starttime: number;
}
