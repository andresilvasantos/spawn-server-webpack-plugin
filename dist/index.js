"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const crypto_1 = tslib_1.__importDefault(require("crypto"));
const cluster_1 = tslib_1.__importDefault(require("cluster"));
const path_1 = tslib_1.__importDefault(require("path"));
const exit_hook_1 = tslib_1.__importDefault(require("exit-hook"));
const events_1 = require("events");
const WORKER_FILE = require.resolve("./worker");
const WATCHING_COMPILERS = new WeakSet();
const PLUGIN_NAME = "spawn-server-webpack-plugin";
const EVENT = {
    RESTART: Symbol(),
    LISTENING: "listening",
    CLOSING: "closing",
};
/**
 * Creates a webpack plugin that will automatically run the build in a child process.
 */
class SpawnServerPlugin extends events_1.EventEmitter {
    constructor(_options = {}) {
        super();
        this._options = _options;
        this.listening = true;
        this.address = null;
        this.devServerConfig = {
            proxy: {
                "**": {
                    xfwd: true,
                    target: true,
                    logLevel: "silent",
                    onProxyReq: (proxyRes, req, res) => {
                        res.on('close', () => proxyRes.destroy());
                    },
                    router: () => {
                        if (this.listening)
                            return getAddress(this);
                        return new Promise((resolve) => {
                            this.once("listening", () => {
                                resolve(getAddress(this));
                            });
                        });
                    },
                    onError: (err, req, res) => {
                        if (this.listening) {
                            console.error(err);
                        }
                        else {
                            res.writeHead(200, {
                                Refresh: `0 url=${req.url}`,
                            });
                            res.end();
                        }
                    },
                },
            },
        };
        this._hash = "";
        this._started = false;
        this._worker = null;
        // Loads output from memory into a new node process.
        this._reload = (stats) => {
            const compilation = stats.compilation;
            const compiler = compilation.compiler;
            const options = compiler.options;
            // Only runs in watch mode.
            if (!WATCHING_COMPILERS.has(compiler))
                return;
            // Don't reload if there was errors.
            if (stats.hasErrors())
                return;
            const { assets, hash } = toSources(stats.compilation);
            // For some reason webpack can output a done event twice for the same compilation...
            if (hash === this._hash)
                return;
            this._hash = hash;
            // Kill existing process.
            this._close(() => {
                // Server is started based off files emitted from the main entry.
                // eslint-disable-next-line
                var _a;
                let mainChunk = undefined;
                // eslint-disable-next-line
                const files = (_a = stats.compilation.entrypoints
                    .get(this._options.mainEntry)) === null || _a === void 0 ? void 0 : _a.getRuntimeChunk().files;
                if (files) {
                    // Read the first file using iteration protocol.
                    // webpack 5 uses a Set, while webpack 4 uses an array.
                    // This will work for both and is more efficient.
                    for (mainChunk of files)
                        break;
                }
                if (!mainChunk) {
                    throw new Error(`spawn-server-webpack-plugin: Could not find an output file for the "${this._options.mainEntry || "default"}" entry.`);
                }
                // Update cluster settings to load empty file and use provided args.
                const originalExec = cluster_1.default.settings.exec;
                const originalArgs = cluster_1.default.settings.execArgv;
                cluster_1.default.settings.exec = WORKER_FILE;
                cluster_1.default.settings.execArgv = this._options.args;
                // Start new process.
                this._started = true;
                this._worker = cluster_1.default.fork(Object.assign({ PORT: 0 }, process.env));
                // Send compiled javascript to child process.
                this._worker.send({
                    action: "spawn",
                    assets,
                    entry: path_1.default.isAbsolute(mainChunk)
                        ? mainChunk
                        : path_1.default.join(options.output.path, mainChunk),
                });
                if (this._options.waitForAppReady) {
                    const checkMessage = (data) => {
                        if (data && data.event === "app-ready") {
                            this._onListening(data.address);
                            this._worker.removeListener("message", checkMessage);
                        }
                    };
                    this._worker.on("message", checkMessage);
                }
                else {
                    // Trigger listening event once any server starts.
                    this._worker.once("listening", this._onListening);
                }
                // Reset cluster settings.
                cluster_1.default.settings.exec = originalExec;
                cluster_1.default.settings.execArgv = originalArgs;
            });
        };
        // Kills any running child process.
        this._close = (done) => {
            if (!this._started || !this.canKil) {
                done && done();
                return;
            }
            // Check if we need to close the existing server.
            if (this._worker.isDead()) {
                done && setImmediate(() => this.emit(EVENT.RESTART));
            }
            else if(this._worker.process.pid != this.lastProcessKilledPID) {
                this._worker.once("exit", () => this.emit(EVENT.RESTART));
                this._worker.kill("SIGKILL");

                this.lastProcessKilledPID = this._worker.process.pid;

                this.canKill = false;

                setTimeout(() => {
                    this.canKill = true;
                }, 1000)
            }

            this.listening = false;
            this.emit(EVENT.CLOSING);
            // Ensure that we only start the most recent router.
            this.removeAllListeners(EVENT.RESTART);
            done && this.once(EVENT.RESTART, done);
        };
        /**
         * Called once the spawned process has a server started/listening.
         * Saves the server address.
         */
        this._onListening = (address) => {
            this.canKill = true;
            this.listening = true;
            this.address = address;
            this.emit(EVENT.LISTENING);
        };
        _options.mainEntry = _options.mainEntry || "main";
        _options.args = _options.args || [];
        this._options = _options;
        exit_hook_1.default(this._close);
    }
    // Starts plugin.
    apply(compiler) {
        compiler.hooks.done.tap(PLUGIN_NAME, this._reload);
        compiler.hooks.watchClose.tap(PLUGIN_NAME, this._close);
        compiler.hooks.make.tap(PLUGIN_NAME, () => (this.listening = false)); // Mark the server as not listening while we try to rebuild.
        compiler.hooks.watchRun.tap(PLUGIN_NAME, () => WATCHING_COMPILERS.add(compiler)); // Track watch mode.
    }
}
function getAddress(plugin) {
    return `http://127.0.0.1:${plugin.address.port}`;
}
/**
 * Converts webpack assets into a searchable map.
 */
function toSources(compilation) {
    const { outputPath } = compilation.compiler;
    const fs = compilation.compiler
        .outputFileSystem;
    const assets = {};
    const hash = crypto_1.default.createHash("md5");
    for (const assetPath in compilation.assets) {
        const asset = compilation.assets[assetPath];
        const existsAt = asset.existsAt ||
            (path_1.default.isAbsolute(assetPath)
                ? assetPath
                : path_1.default.join(outputPath, assetPath));
        const source = fs.readFileSync
            ? fs.readFileSync(existsAt, "utf-8")
            : asset.source();
        assets[existsAt] = source;
        hash.update(existsAt).update(source);
    }
    return {
        hash: hash.digest("hex"),
        assets,
    };
}
typeof module === "object" && (module.exports = exports = SpawnServerPlugin);
exports.default = SpawnServerPlugin;
//# sourceMappingURL=index.js.map