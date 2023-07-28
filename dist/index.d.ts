/// <reference types="node" />
import type { AddressInfo } from "net";
import type { IncomingMessage, ServerResponse } from "http";
import type { Compiler } from "webpack";
import { EventEmitter } from "events";
/**
 * Creates a webpack plugin that will automatically run the build in a child process.
 */
declare class SpawnServerPlugin extends EventEmitter {
    private _options;
    listening: boolean;
    address: null | AddressInfo;
    devServerConfig: {
        proxy: {
            "**": {
                xfwd: boolean;
                target: boolean;
                logLevel: string;
                router: () => string | Promise<string>;
                onError: (err: Error, req: IncomingMessage, res: ServerResponse) => void;
            };
        };
    };
    private _hash;
    private _started;
    private _worker;
    constructor(_options?: {
        waitForAppReady?: boolean;
        mainEntry?: string;
        args?: string[];
    });
    apply(compiler: Compiler): void;
    private _reload;
    private _close;
    /**
     * Called once the spawned process has a server started/listening.
     * Saves the server address.
     */
    private _onListening;
}
export default SpawnServerPlugin;
