"use strict";

import * as async from "async";
import * as aws from "aws-sdk";
import * as child_process from "child_process";
import * as program from "commander";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";

import * as globals from "./globals";
import * as service from "./service";

interface IS3BucketData {
    CommonPrefixes: string[];
    Contents: IS3ContentData[];
    IsTruncated: boolean;
    Marker: string;
    MaxKeys: number;
}

interface IS3ContentData {
    Key: string;
    LastModified: Date;
    ETag: string;
    Size: string;
    StorageClass: string;
    Owner: {
        DisplayName: string,
        ID: string,
    };
}

enum SyncStatus {
    IGNORE,
    DOWNLOAD,
    DELETE,
}

export const ID: string = "cocoon-updater";

export class Updater extends service.CocoonService {

    private static UPDATER_LOOP_INTERVAL: number = 60000;
    private static AWS_ACCESS_KEY: string = "AKIAI7HG2VCCXLJKQCKA";
    private static SECRET_ACCESS_KEY: string = "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";

    private _s3: any;

    constructor(options?: service.IGlobalOptions) {
        super(ID, Updater.UPDATER_LOOP_INTERVAL, options);

        aws.config.update({
            credentials: new aws.Credentials(Updater.AWS_ACCESS_KEY, Updater.SECRET_ACCESS_KEY),
        });
        this._s3 = new aws.S3();
    }

    protected onStart(): void {
        this._logger.info("updater data folder: " + globals.COMPILER_DATA_PATH(this._env));

        this.loop();
    }

    protected onStop(): void {
        return;
    }

    protected loop(): void {
        if (this._working) {
            return;
        }

        this.working(true);

        async.waterfall([

            this.init.bind(this),
            this.dataFolder.bind(this),
            this.syncFolder.bind(this),
            this.list.bind(this),
            this.sync.bind(this),
            this.purge.bind(this),
            this.save.bind(this),

        ], (err: Error, status: IS3BucketData) => {
            if (err) {
                this._logger.error("update finished: " + err.message);

            } else {
                this._logger.info("update finished");
            }

            // Clean the sync dir
            fse.removeSync(globals.SYNC_PATH(this._env));

            // Write ready.lock so we know that the data folder has been initialized with some data
            // The compiler won't compile until this file is present
            if (!err && status && status.Contents.length > 0) {
                const lock = path.join(globals.COMPILER_DATA_PATH(this._env), "ready.lock");
                fse.closeSync(fse.openSync(lock, "w"));
            }

            this.working(false);

            if (!this._options.service) {
                if (err) {
                    process.exit(-1);

                } else {
                    process.exit(0);
                }
            }
        });
    }

    private init(cb: (err?: Error) => void): void {
        this._logger.info("init");
        cb();
    }

    /**
     * Create the data folder in case it doesn't exist
     */
    private dataFolder(cb: (err?: Error) => void): void {
        this._logger.info("data folder");

        fse.ensureDir(globals.COMPILER_DATA_PATH(this._env), (error: any) => {
            if (error) {
                this._logger.fatal("cannot create compiler data folder");
                cb(new Error(error));
                return;
            }

            cb();
        });
    }

    /**
     * Recreate the temporary sync folder to store the S3 files
     */
    private syncFolder(cb: (err?: Error) => void): void {
        this._logger.info("sync folder");

        try {
            fse.emptyDir(globals.SYNC_PATH(this._env), (error: any) => {
                if (error) {
                    this._logger.fatal("cannot create sync temp folder");
                    cb(new Error(error));
                    return;
                }

                cb();
            });

        } catch (ex) {
            cb(new Error(ex.message));
        }
    }

    /**
     * Get the list of files from S3
     */
    private list(cb: (err?: Error) => void): void {
        this._logger.info("list");

        try {
            this._s3.listObjects({
                Bucket: globals.BUCKET(this._env),
            }, cb);

        } catch (ex) {
            cb(new Error(ex.message));
        }
    }

    /**
     * Sync the files that have been modified
     */
    private sync(data: IS3BucketData, cb: (err?: Error, result?: IS3BucketData) => void): void {
        this._logger.info("sync");

        // Purge from the list all the files tha are not for this platform (darwin, linux, etc)
        const purgedContents: IS3ContentData[] = [];
        for (const dataContent of data.Contents) {
            if (!this.isPlatformFile(dataContent)) {
                this._logger.info("Ignoring non platform file: " + dataContent.Key);
                continue;
            }

            purgedContents.push(dataContent);
        }
        data.Contents = purgedContents;

        // Process all the bucket files
        async.forEachOfSeries(data.Contents,
            (contentData: IS3ContentData, key: number, callback: async.ErrorCallback<Error>) => {
            let syncObject: SyncStatus = SyncStatus.DOWNLOAD;

            if (fse.existsSync(globals.S3_STRUCTURE_FILE_PATH(this._env))) {
                try {
                    const structure = JSON.parse(fse.readFileSync(globals.S3_STRUCTURE_FILE_PATH(this._env), "UTF8"));
                    if (structure) {
                        syncObject = this.getSyncStatus(structure, contentData);
                    }

                } catch (ex) {
                    this._logger.debug("sync file empty", ex.message);
                }
            }

            if (syncObject === SyncStatus.DOWNLOAD) {
                this._logger.debug("syncing file " + contentData.Key);

                // Save the file to disk
                const fileName: string = path.basename(contentData.Key);
                const filePath: string = path.join(globals.SYNC_PATH(this._env), fileName);
                const fileStream: fse.WriteStream = fse.createWriteStream(filePath);
                fileStream.once("close", () => {
                    // Get the file output directory
                    const outDir: string = this.getOutputDir(contentData);
                    if (outDir === null) {
                        callback();
                        return;
                    }

                    // Ensure there is an empty output directory
                    fse.emptyDirSync(outDir);

                    // Decompress the file
                    this._logger.debug("decompressing " + contentData.Key + " to " + outDir);
                    let command: string = "tar -jxf " + filePath;
                    if (os.platform() === "win32") {
                        command = "bsdtar -xf " + filePath;
                    }
                    child_process.exec(
                        command,
                        {
                            cwd: outDir,
                            maxBuffer: 52428800, // 20MB
                        },
                        (error: Error) => {
                            if (error !== null) {
                                this._logger.error(error.message);
                                callback(error);
                                return;
                            }

                            this._logger.debug("file " + contentData.Key + " synced! (added)");
                            callback();
                        });
                });
                fileStream.once("error", (error: Error) => {
                    this._logger.error("error getting object from s3", error);
                    callback(error);
                });

                this._s3.getObject({
                    Bucket: globals.BUCKET(this._env),
                    Key: contentData.Key,
                }).createReadStream().pipe(fileStream);

            } else {
                callback();
            }

        }, (err) => {
            cb(err, data);
        });
    }

    /**
     * Clean the removed files from S3
     */
    private purge(data: IS3BucketData, cb: (err?: Error, result?: IS3BucketData) => void): void {
        this._logger.info("purge");

        if (fse.existsSync(globals.S3_STRUCTURE_FILE_PATH(this._env))) {
            try {
                const structure = JSON.parse(fse.readFileSync(globals.S3_STRUCTURE_FILE_PATH(this._env), "UTF8"));
                if (structure) {
                    for (const localItem of structure) {
                        let exists = false;
                        for (const remoteItem of data.Contents) {
                            if (localItem.Key === remoteItem.Key) {
                                exists = true;
                                break;
                            }
                        }

                        if (!exists) {
                            const file: string = this.getOutputDir(localItem);
                            if (fse.existsSync(file)) {
                                fse.removeSync(file);
                                this._logger.debug("file " + localItem.Key + " synced! (removed)");
                            }
                        }
                    }
                }

            } catch (ex) {
                this._logger.debug("sync file empty", ex.message);
            }
        }

        cb(null, data);
    }

    /**
     * Persist the bucket structure in a local file
     */
    private save(data: IS3BucketData, cb: (err?: Error, result?: IS3BucketData) => void): void {
        this._logger.info("save");

        fse.removeSync(globals.SYNC_PATH(this._env));

        if (data) {
            try {
                fse.writeFile(globals.S3_STRUCTURE_FILE_PATH(this._env), JSON.stringify(data.Contents, null, " "),
                    (err: NodeJS.ErrnoException) => {
                    cb(err, data);
                });

            } catch (ex) {
                this._logger.info("error saving bucket data", ex.message);
            }

        } else {
            cb(null, data);
        }
    }

    private isPlatformFile(data: IS3ContentData): boolean {
        const fileName: string = path.basename(data.Key);
        const dirName: string = path.dirname(data.Key);

        if ([globals.CORDOVA_PLATFORMS_FOLDER, globals.CORDOVA_COMPILERS_FOLDER,
            globals.CORDOVA_PLUGINS_FOLDER, globals.CORDOVA_LIBS_FOLDER, globals.SDKS_FOLDER].includes(dirName)) {
            const osType = os.platform();
            if (dirName === globals.CORDOVA_LIBS_FOLDER) {
                const pattern = /cordova-[0-9.]+-([a-zA-Z]+)\.tar\.bz2/i;
                const libOS = fileName.match(pattern)[1];
                if (osType !== libOS) {
                    return false;
                }

            } else if (dirName === globals.SDKS_FOLDER) {
                const pattern = /[a-zA-Z.\-]+-([a-zA-Z0-9]+)\.tar\.bz2/i;
                const libOS = fileName.match(pattern)[1];
                if (osType !== libOS) {
                    return false;
                }
            }
        }

        return true;
    }

    private getSyncStatus(data: IS3ContentData[], contentData: IS3ContentData): SyncStatus {
        let sync: SyncStatus = SyncStatus.IGNORE;

        for (const item of data) {
            const dirName: string = path.dirname(contentData.Key);

            if ([globals.CORDOVA_PLATFORMS_FOLDER, globals.CORDOVA_COMPILERS_FOLDER,
                    globals.CORDOVA_PLUGINS_FOLDER, globals.CORDOVA_LIBS_FOLDER, globals.SDKS_FOLDER].includes(dirName) &&
                item.Key === contentData.Key) {
                // If the local file does not exist, we need to sync
                const outDir: string = this.getOutputDir(contentData);
                if (!fse.existsSync(outDir)) {
                    sync = SyncStatus.DOWNLOAD;
                    break;
                }

                // If the remote date is different that the local date, we do sync
                if (item.LastModified.toString() !== contentData.LastModified.toISOString()) {
                    sync = SyncStatus.DOWNLOAD;
                    break;
                }
            }
        }

        return sync;
    }

    private getOutputDir(contentData: IS3ContentData): string {
        let dir = null;

        const filename: string = path.basename(contentData.Key);
        const dirName: string = path.dirname(contentData.Key);

        if (dirName === globals.CORDOVA_PLATFORMS_FOLDER) {
            const pattern = /([a-zA-Z0-9.\-?]+)\.tar\.bz2/i;
            const name = filename.match(pattern)[1];
            dir = path.join(globals.CORDOVA_PLATFORMS_PATH(this._env), name);
        }

        if (dirName === globals.CORDOVA_COMPILERS_FOLDER) {
            const pattern = /compiler_cordova_([0-9.?]+)\.tar\.bz2/i;
            const name = filename.match(pattern)[1];
            dir = path.join(globals.CORDOVA_COMPILERS_PATH(this._env), name);
        }

        if (dirName === globals.CORDOVA_PLUGINS_FOLDER) {
            const pattern = /([a-zA-Z0-9.\-?]+)\.tar\.bz2/i;
            const name = filename.match(pattern)[1];
            dir = path.join(globals.CORDOVA_PLUGINS_PATH(this._env), name);
        }

        if (dirName === globals.CORDOVA_LIBS_FOLDER) {
            const pattern = /(cordova-[0-9.]+)-[a-zA-Z]+\.tar\.bz2/i;
            const name = filename.match(pattern)[1];
            dir = path.join(globals.CORDOVA_LIBS_PATH(this._env), name);
        }

        if (dirName === globals.SDKS_FOLDER) {
            const pattern = /([a-zA-Z0-9.\-?]+)\.tar\.bz2/i;
            const name = filename.match(pattern)[1];
            dir = path.join(globals.COMPILER_DATA_PATH(this._env), globals.SDKS_FOLDER, name);
        }

        return dir;
    }

}

program
    .version(globals.getVersion())
    .option("-c, --console", "Console mode")
    .option("-e, --env <env>", "Environment", /^(develop|testing|production)$/i, "develop")
    .option("-l, --logLevel <level>", "Log level", /^(all|trace|debug|info|warn|error|fatal|mark|off)$/i, "info")
    .parse(process.argv);

if (program.console) {
    const options: service.IGlobalOptions = {
        env: program.env,
        logLevel: program.logLevel,
        service: false,
    };

    new Updater(options).start();

} else {
    new Updater().start();
}
