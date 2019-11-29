"use strict";

export class BuilderError implements Error {
    public get name(): string {
        return "BuilderError";
    }

    public constructor(public message: string, public msgPublic: string) {}
}
