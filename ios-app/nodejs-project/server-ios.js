/** Native bootstrap; host smoke tests supply ST_IOS_CONFIG_PATH explicitly. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createStartupLogger, redirectConsole } from './startup-log.mjs';
import { installRuntimePolyfills } from './runtime-polyfills.mjs';

const filename = fileURLToPath(import.meta.url);
const runtimeDirectory = path.dirname(filename);
let logger;
let bridgeChannel;

function requireAbsolute(value, name) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`Invalid native configuration: ${name}`);
    return value;
}

try {
    // nodejs-mobile pipes may have no reader. Avoid SIGPIPE before any imports log.
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    process.on('SIGPIPE', () => {});

    const configFile = process.env.ST_IOS_CONFIG_PATH ?? (() => {
        if (!process.env.DATADIR) throw new Error('Native DATADIR is missing');
        const container = path.resolve(process.env.DATADIR, '..', '..', '..');
        return path.join(container, 'Library', 'Application Support', 'st_config.json');
    })();
    requireAbsolute(configFile, 'configFile');
    logger = createStartupLogger(path.join(path.dirname(configFile), 'logs'));
    redirectConsole(logger, process.env.ST_IOS_DIAGNOSTICS === '1');
    process.on('exit', () => logger.flush());
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'runtime-manifest.json'), 'utf8'));
    if (manifest.formatVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.deploymentId)
        || config.deploymentId !== manifest.deploymentId) {
        throw new Error('Native configuration does not match the installed runtime manifest');
    }

    const publicDirectory = requireAbsolute(config.bundlePublicPath, 'bundlePublicPath');
    const defaultsDirectory = path.join(requireAbsolute(config.bundleServerRoot, 'bundleServerRoot'), 'default');
    const dataDirectory = path.join(requireAbsolute(config.documentsPath, 'documentsPath'), 'SillyTavern');
    for (const asset of [path.join(publicDirectory, 'index.html'), path.join(publicDirectory, 'lib.js'), path.join(defaultsDirectory, 'config.yaml')]) {
        if (!fs.existsSync(asset)) throw new Error(`Missing bundled asset: ${path.basename(asset)}`);
    }
    fs.mkdirSync(dataDirectory, { recursive: true });
    const userConfigPath = path.join(dataDirectory, 'config.yaml');
    if (!fs.existsSync(userConfigPath)) {
        fs.copyFileSync(path.join(runtimeDirectory, 'config.yaml'), userConfigPath, fs.constants.COPYFILE_EXCL);
    }

    installRuntimePolyfills();

    Object.assign(process.env, {
        ST_IOS: '1',
        ST_SERVER_DIR: runtimeDirectory,
        ST_PUBLIC_DIR: publicDirectory,
        ST_DEFAULTS_DIR: defaultsDirectory,
        ST_TOKENIZERS_DIR: path.join(runtimeDirectory, 'src', 'tokenizers'),
        ST_USER_DATA_DIR: dataDirectory,
        ST_APP_VERSION: manifest.applicationVersion,
        ST_DEPLOYMENT_ID: manifest.deploymentId,
    });
    process.argv = [process.argv[0], filename, '--dataRoot', dataDirectory, '--configPath', userConfigPath,
        '--listen', 'false', '--port', '8000', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--browserLaunchEnabled', 'false', '--disableCsrf', 'false'];
    try {
        // The plugin installs this CommonJS module through NODE_PATH, which the
        // ESM resolver does not search. Loading it also announces APP_CHANNEL ready.
        const bridge = createRequire(import.meta.url)('bridge');
        bridgeChannel = bridge.channel ?? bridge.default?.channel;
    } catch {
        logger.log('Native bridge unavailable; HTTP readiness remains available');
    }

    logger.log(`Starting SillyTavern ${manifest.applicationVersion}; Node ${process.version}; deployment ${manifest.deploymentId}`);
    globalThis.ST_IOS_STARTUP_STATE = 'starting';
    const server = await import('./server-bundle.mjs');
    if (!server.startup || typeof server.startup.then !== 'function') throw new Error('Bundle has no startup promise');
    await server.startup;
    globalThis.ST_IOS_STARTUP_STATE = 'ready';
    logger.log('Server initialization completed');
    logger.flush();
    bridgeChannel?.send('serverReady', { port: 8000, deploymentId: manifest.deploymentId });
} catch (error) {
    globalThis.ST_IOS_STARTUP_STATE = 'failed';
    logger?.log(`STARTUP FAILED: ${error.message}`);
    logger?.flush();
    bridgeChannel?.send('serverError', { message: error.message });
    process.exitCode = 1;
    // Do not call process.exit() here: the native app needs to display the error.
    // If initialization opened a listener, its health and API gate return 503.
}
