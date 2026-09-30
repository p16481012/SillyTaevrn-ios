/**
 * iOS esbuild entry point.
 * Export the startup promise so the native bootstrap observes asynchronous
 * initialization failures. Keep this entry free of top-level await.
 */
import { CommandLineParser } from './src/command-line.js';
import { serverDirectory } from './src/server-directory.js';

const _t0 = Date.now();
const _el = () => `+${((Date.now() - _t0) / 1000).toFixed(1)}s`;

console.log(`[bundle ${_el()}] server-ios-entry.js — Node ${process.version}`);
console.log(`[bundle ${_el()}] serverDirectory: ${serverDirectory}`);

const cliArgs = new CommandLineParser().parse(process.argv);
globalThis.DATA_ROOT = cliArgs.dataRoot;
globalThis.COMMAND_LINE_ARGS = cliArgs;
process.chdir(serverDirectory);
console.log(`[bundle ${_el()}] CLI parsed — dataRoot: ${cliArgs.dataRoot}`);

export const startup = (async () => {
    const server = await import('./src/server-main.js');
    await server.serverReady;
})();
