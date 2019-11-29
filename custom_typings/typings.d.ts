declare module "external-ip" {
    const getIP: (options: object) => (callback: (error: Error, ip: string) => void) => void;
    export = getIP;
}

declare module "intercept-stdout" {
    const intercept: (callback: (logLine: string) => void) => () => void;
    export = intercept;
}

declare module "klaw-sync" {
    import * as fs from "fs";

    interface Item {
        path: string;
        stats: fs.Stats;
    }

    interface IOptions {
        /**
         *  any paths or `micromatch` patterns to ignore.
         *
         * For more information on micromatch patterns: https://github.com/jonschlinkert/micromatch#features
         */
        ignore?: string | string[];
        /**
         * True to only return files (ignore directories).
         *
         * Defaults to false if not specified.
         */
        nodir?: boolean;
        /**
         * True to only return directories (ignore files).
         *
         * Defaults to false if not specified.
         */
        nofile?: boolean;
        filter?: (item: {path: string, stats: object}) => boolean;
    }

    /**
     * Lists all files and directories inside a directory recursively and returns an array of items.
     * Each item has two properties: 'path' and 'stats'.
     * 'path' is the full path of the file or directory and 'stats' is an instance of fs.Stats.
     */
    const klawSync: (directory: string, options?: IOptions) => ReadonlyArray<Item>;
    export = klawSync;
}

declare module "mongodb-queue" {
    const whatEver: any;
    export = whatEver;
}

declare module "passport-http-header-token" {
    const whatEver: any;
    export = whatEver;
}

declare module "plist" {
    export function parse(file: string | Buffer): any;

    export function build(json: any[]): string;
}

declare module "pm2" {
    const whatEver: any;
    export = whatEver;
}
