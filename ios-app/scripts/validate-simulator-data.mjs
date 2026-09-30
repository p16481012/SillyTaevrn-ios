#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { createDataFixture, legacyConfig, verifyLegacyConfig, createReadClient, verifyReadableFixture } from './simulator-data-fixture.mjs';
import { createTransferClient, runTransferScenario, verifyTransferReopen } from './simulator-transfer-fixture.mjs';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const healthURL = 'http://127.0.0.1:8000/api/ios/health';
const runtimeRelative = 'Library/nodejs/public';
const previousRelative = 'Library/nodejs/public.previous';
const pendingRelative = 'Library/nodejs/public.pending';
const configRelative = 'Documents/SillyTavern/config.yaml';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = data => createHash('sha256').update(data).digest('hex');

export const usage = `Usage: node ios-app/scripts/validate-simulator-data.mjs
  --udid <available iOS Simulator UUID> --app </absolute/App.app>
  --report </absolute/result.json> [--upgrade-app </absolute/UpgradeB.app>]
  [--timeout-ms 180000]

macOS only. Creates a disposable Simulator with the template's device type and
runtime; never changes the template's data. Stops its selected app to free port
8000. Tests reinstall/data preservation and runtime recovery in the disposable
container, then deletes only the Simulator created by this invocation.
Includes real import/export, chat backup and settings snapshot API operations.
Reports backend/file checks, not Files picker UI or physical-device results.`;

export function parseArguments(args) {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    const options = { timeoutMs: 180000 };
    const names = { '--udid': 'udid', '--app': 'app', '--upgrade-app': 'upgradeApp', '--report': 'report', '--timeout-ms': 'timeoutMs' };
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]];
        const value = args[index + 1];
        if (!name || seen.has(name) || !value || value.startsWith('--')) throw new Error(`Invalid CLI option: ${args[index]}`);
        seen.add(name);
        options[name] = name === 'timeoutMs' ? Number(value) : value;
    }
    if (!uuidPattern.test(options.udid ?? '')) throw new Error('--udid must be an explicit Simulator UUID; "booted" is not accepted.');
    if (!path.isAbsolute(options.app ?? '') || !/\.app$/i.test(options.app)) throw new Error('--app must be an absolute built App.app path.');
    if (options.upgradeApp && (!path.isAbsolute(options.upgradeApp) || !/\.app$/i.test(options.upgradeApp))) throw new Error('--upgrade-app must be an absolute built App.app path.');
    if (!path.isAbsolute(options.report ?? '') || !/\.json$/i.test(options.report)) throw new Error('--report must be an absolute JSON file path.');
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 5000 || options.timeoutMs > 360000) throw new Error('--timeout-ms must be between 5000 and 360000.');
    return options;
}

export function selectSimulator(listing, udid) {
    if (!uuidPattern.test(udid)) throw new Error('An explicit Simulator UUID is required.');
    for (const [runtime, devices] of Object.entries(listing.devices ?? {})) {
        const device = devices.find(item => item.udid?.toUpperCase() === udid.toUpperCase());
        if (!device) continue;
        if (!/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[\d-]+$/.test(runtime)
            || device.isAvailable !== true
            || !/^com\.apple\.CoreSimulator\.SimDeviceType\.(iPhone|iPad|iPod)/.test(device.deviceTypeIdentifier ?? '')) {
            throw new Error('The selected UUID is not an available iOS Simulator with a known device type.');
        }
        return { ...device, runtime };
    }
    throw new Error('The selected UUID is absent from simctl Simulator devices. Physical devices are not supported.');
}

function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolvedDestination(filename) {
    let current = path.resolve(filename);
    const missing = [];
    while (true) {
        try { return path.join(await fs.realpath(current), ...missing.reverse()); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

async function validateReportPath(filename, app, devicesRoot) {
    if (!path.isAbsolute(filename) || !/\.json$/i.test(filename)) throw new Error('Invalid report path.');
    const target = await resolvedDestination(filename);
    for (const directory of [app, devicesRoot]) {
        const root = await resolvedDestination(directory);
        if (target === root || isWithin(root, target)) throw new Error('Report must be outside Simulator containers and the built app.');
    }
    try {
        if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('Report must not be a symlink.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Refuse aliases, physical-device paths, other Simulators and container symlinks. */
async function validateSimulatorContainer(directory, udid, devicesRoot, bundle = false) {
    if (!path.isAbsolute(directory) || !path.isAbsolute(devicesRoot) || !uuidPattern.test(udid)) throw new Error('Invalid Simulator container path.');
    const root = await fs.realpath(devicesRoot);
    const relative = path.relative(path.resolve(devicesRoot), path.resolve(directory));
    const parts = relative.split(path.sep);
    if (parts.length !== (bundle ? 7 : 6) || parts[0].toUpperCase() !== udid.toUpperCase()
        || parts.slice(1, 5).join('/') !== `data/Containers/${bundle ? 'Bundle' : 'Data'}/Application`
        || !uuidPattern.test(parts[5]) || (bundle && !/\.app$/i.test(parts[6]))) throw new Error('Container is outside the disposable Simulator application directory.');
    let current = path.resolve(devicesRoot);
    for (const part of parts) {
        current = path.join(current, part);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Simulator container path contains a symlink or non-directory.');
    }
    const actual = await fs.realpath(directory);
    if (!isWithin(root, actual)) throw new Error('Resolved container escapes CoreSimulator devices.');
    return actual;
}

export const validateContainerPath = (directory, udid, devicesRoot) => validateSimulatorContainer(directory, udid, devicesRoot);
export const validateBundlePath = (directory, udid, devicesRoot) => validateSimulatorContainer(directory, udid, devicesRoot, true);

export async function checkedContainerChild(container, relative) {
    if (!relative || path.isAbsolute(relative) || /[\\\x00-\x1f\x7f]/.test(relative)
        || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe fixture-relative path.');
    const target = path.resolve(container, relative);
    if (!isWithin(container, target)) throw new Error('Fixture path escapes its Simulator container.');
    let current = container;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        try {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink()) throw new Error('Fixture path contains a symlink.');
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
    return target;
}

function signalCommand(child, signal) {
    if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    child.kill(signal);
}

export async function defaultRunCommand(command, args, timeout = 120000, { signal } = {}) {
    return new Promise((resolve, reject) => {
        let timer;
        let hardTimer;
        let timedOut = false;
        let stopping = false;
        let settled = false;
        let stdoutTail = '';
        let stderrTail = '';
        const finish = (error, stdout, stderr) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(hardTimer);
            signal?.removeEventListener('abort', abort);
            if (error) reject(Object.assign(error, { stdout, stderr, timedOut,
                killed: error.killed === true || child.killed }));
            else resolve({ stdout, stderr });
        };
        const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
            detached: process.platform !== 'win32' }, (error, stdout, stderr) => {
            finish(error, stdout, stderr);
        });
        child.stdout?.on('data', chunk => { stdoutTail = (stdoutTail + chunk).slice(-4096); });
        child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4096); });
        const stop = () => {
            if (stopping || settled) return;
            stopping = true;
            try { signalCommand(child, 'SIGTERM'); }
            catch { child.kill('SIGTERM'); }
            // execFile may wait forever for pipes held open by descendants. Force
            // the process group down and settle even if its callback never runs.
            hardTimer = setTimeout(() => {
                try { signalCommand(child, 'SIGKILL'); }
                catch { child.kill('SIGKILL'); }
                const error = new Error(timedOut ? 'Command did not exit after timeout' : 'Command cancelled');
                error.code = timedOut ? 'ETIMEDOUT' : 'ABORT_ERR';
                error.signal = 'SIGKILL';
                error.killed = true;
                child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
                finish(error, stdoutTail, stderrTail);
            }, 2000);
        };
        const abort = () => { timedOut = signal?.reason?.timedOut === true; stop(); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        // Track this timeout explicitly: SIGTERM alone has other causes.
        timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    });
}

function commandErrorSummary(error, command, args, timeoutMs) {
    return { command, arguments: [...args], timeoutMs, timedOut: error.timedOut === true,
        exitCode: typeof error.code === 'number' ? error.code : null,
        errorCode: typeof error.code === 'string' ? error.code : null,
        signal: error.signal ?? null, killed: error.killed === true,
        stdoutTail: String(error.stdout ?? '').slice(-4096), stderrTail: String(error.stderr ?? '').slice(-4096) };
}

function failureMessage(error) {
    const command = error.commandError;
    if (command?.timedOut) return `Command timed out after ${command.timeoutMs} ms: ${[command.command, ...command.arguments].join(' ')}`;
    return command ? error.message.slice(0, 4096) : error.message;
}

function defaultProcessAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function defaultProbe() {
    try {
        const response = await fetch(healthURL, { signal: AbortSignal.timeout(2000), redirect: 'error', cache: 'no-store' });
        let body;
        try { body = await response.json(); } catch { body = null; }
        return { status: response.status, body };
    } catch (error) {
        // A timeout/redirect is not proof that no listener exists.
        if (error.cause?.code === 'ECONNREFUSED') return null;
        throw error;
    }
}

async function saveReport(filename, report) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    try {
        if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('Report must not be a symlink.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
}

/** Dependency injection is only for host unit tests; CLI uses real simctl/macOS. */
export async function validateSimulatorData(options, dependencies = {}) {
    const startedAtMs = Date.now();
    const timeBudgetMs = dependencies.timeBudgetMs ?? 22 * 60 * 1000;
    if (!Number.isInteger(timeBudgetMs) || timeBudgetMs < 1) throw new Error('Invalid validation time budget.');
    const deadlineMs = startedAtMs + timeBudgetMs;
    const deadlineError = Object.assign(new Error(`Data validation exceeded its ${timeBudgetMs} ms budget`), { timedOut: true });
    const active = new AbortController();
    const deadlineTimer = setTimeout(() => active.abort(deadlineError), timeBudgetMs);
    const relayAbort = () => active.abort(dependencies.signal.reason ?? new Error('Data validation cancelled'));
    if (dependencies.signal?.aborted) relayAbort();
    else dependencies.signal?.addEventListener('abort', relayAbort, { once: true });
    const checkActive = () => {
        if (Date.now() >= deadlineMs && !active.signal.aborted) active.abort(deadlineError);
        if (active.signal.aborted) throw active.signal.reason;
    };
    const writeReport = dependencies.writeReport ?? saveReport;
    const rawRun = dependencies.runCommand ?? defaultRunCommand;
    const run = async (command, args, timeout = 120000) => {
        const creatingFixture = command === 'xcrun' && args[0] === 'simctl' && args[1] === 'create';
        const verifyingCandidate = candidateValidated && !ownershipVerified
            && (active.signal.aborted || Date.now() >= deadlineMs || !!report.checkpointError)
            && command === 'xcrun' && args[0] === 'simctl' && args[1] === 'list';
        if (!cleaningUp && !verifyingCandidate) checkActive();
        const label = command === 'xcrun' && args[0] === 'simctl' ? `simctl ${args[1]}` : command;
        try { await checkpoint('command-start', { command: label }); }
        catch (error) {
            // A successful create may have returned a UUID before ownership was
            // verified. Do not let report I/O prevent the identity lookup.
            if (!cleaningUp && !verifyingCandidate) throw error;
            recordCheckpointFailure(error);
        }
        if (!cleaningUp && !verifyingCandidate) checkActive();
        const remaining = deadlineMs - Date.now();
        const commandTimeout = cleaningUp ? Math.min(timeout, 30000)
            : verifyingCandidate ? Math.min(timeout, 20000) : Math.min(timeout, Math.max(1, remaining));
        const commandStartedAt = Date.now();
        let result;
        try { result = await rawRun(command, args, commandTimeout,
            { signal: cleaningUp || verifyingCandidate ? undefined : active.signal }); }
        catch (error) {
            error.commandError = commandErrorSummary(error, command, args, commandTimeout);
            throw error;
        }
        try { await checkpoint('command-passed', { command: label, durationMs: Date.now() - commandStartedAt }); }
        catch (error) { recordCheckpointFailure(error); }
        // Return a successful create UUID before observing cancellation; the
        // caller must first identify that candidate and then safely clean it.
        if (!cleaningUp && !creatingFixture && !verifyingCandidate) checkActive();
        return result;
    };
    const probe = dependencies.probe ?? defaultProbe;
    const processAlive = dependencies.processAlive ?? defaultProcessAlive;
    const pause = dependencies.pause ?? sleep;
    const devicesRoot = dependencies.devicesRoot ?? path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
    const report = { formatVersion: 2, status: 'failed', startedAt: new Date(startedAtMs).toISOString(),
        deadlineAt: new Date(deadlineMs).toISOString(),
        templateUDID: options.udid, app: options.app, scenarios: [], cleanup: { deletedOwnedSimulator: false },
        coverage: { sameAppReinstall: true, newManifestUpdate: false, representativeData: true, backendReadAPI: true,
            characterImportAPI: true, chatExportImportAPI: true, chatBackupDownloadImportAPI: true,
            settingsSnapshotRestoreAPI: true, fullDataZipExport: true, fullDataZipRestoreAPI: false,
            syntheticLegacy117: true, realLegacyUserExport: false, differentSillyTavernVersions: false,
            frontendReadiness: false, filesPickerUI: false, physicalDevice: false } };
    let fixtureUDID;
    let fixtureName;
    let fixtureDeviceType;
    let fixtureRuntime;
    let ownershipVerified = false;
    let candidateValidated = false;
    let fixturePID;
    let stopped = true;
    let container;
    let expectedConfig;
    let fixtureData;
    let transferState;
    let expectedManifest;
    let expectedBuild;
    let bundleID;
    let reportAllowed = false;
    let cleaningUp = false;
    let activeScenario = null;
    function recordCheckpointFailure(error) {
        report.checkpointError ??= failureMessage(error);
        report.status = 'failed';
        console.error(`[data-validator] Progress report could not be saved: ${report.checkpointError}`);
    }
    async function checkpoint(phase, details = {}) {
        report.progress = { phase, scenario: activeScenario, ...details, at: new Date().toISOString() };
        if (reportAllowed) await writeReport(options.report, report);
        console.log(`[data-validator] ${report.progress.at} ${activeScenario ?? 'setup'} ${phase}${details.command ? ` ${details.command}` : ''}`);
    }
    const simctl = async (...args) => run('xcrun', ['simctl', ...args]);
    const listDevices = async () => JSON.parse((await simctl('list', 'devices', 'available', '--json')).stdout);
    const child = async relative => {
        await validateContainerPath(container, fixtureUDID, devicesRoot);
        return checkedContainerChild(container, relative);
    };
    const writableChild = async relative => {
        if (!stopped) throw new Error('Refusing to mutate app files while its process is running.');
        return child(relative);
    };

    async function waitForOffline() {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            if (!cleaningUp) checkActive();
            if (!await probe()) return;
            await pause(200);
        }
        throw new Error('Port 8000 still has a listener after app termination; refusing to mutate or launch the fixture.');
    }

    async function terminate(udid, pid) {
        try { await simctl('terminate', udid, bundleID); }
        catch (error) {
            if (!/not running|no such process|found no running process|found nothing to terminate/i.test(error.stderr ?? error.message)) throw error;
        }
        if (pid) {
            const deadline = Date.now() + 15000;
            while (processAlive(pid) && Date.now() < deadline) {
                if (!cleaningUp) checkActive();
                await pause(100);
            }
            if (processAlive(pid)) throw new Error('The app process did not exit; fixture files were not changed.');
        }
        await waitForOffline();
    }

    async function stopFixture() {
        if (!stopped) await terminate(fixtureUDID, fixturePID);
        stopped = true;
        fixturePID = undefined;
    }

    async function resolveContainer() {
        const result = await simctl('get_app_container', fixtureUDID, bundleID, 'data');
        container = await validateContainerPath(result.stdout.trim(), fixtureUDID, devicesRoot);
        report.container = container;
    }

    async function assertDataPreserved() {
        const config = await fs.readFile(await child(configRelative));
        if (!config.equals(expectedConfig)) throw new Error('User config bytes changed or the config sentinel was lost.');
        const files = [];
        for (const file of fixtureData.files) {
            const bytes = await fs.readFile(await child(file.path));
            if (!bytes.equals(file.bytes)) throw new Error(`Representative data bytes changed or were lost: ${file.kind}`);
            files.push({ kind: file.kind, path: file.path, size: bytes.length, sha256: digest(bytes), preserved: true });
        }
        for (const file of fixtureData.excludedBackupFiles) {
            const bytes = await fs.readFile(await child(file.path));
            if (!bytes.equals(file.bytes)) throw new Error(`Synthetic secret fixture changed or was lost: ${file.kind}`);
        }
        return { configPreserved: true, userDataPreserved: true, configSHA256: digest(config),
            userFileSHA256: files.find(file => file.kind === 'user-file').sha256,
            syntheticSecretFixturesPreserved: true, files };
    }

    async function seedData(data) {
        fixtureData = data;
        for (const file of [...data.files, ...data.excludedBackupFiles]) {
            const target = await writableChild(file.path);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(await writableChild(file.path), file.bytes);
        }
    }

    async function checkReadAPI() {
        const client = await (dependencies.apiClientFactory ?? createReadClient)();
        return verifyReadableFixture(fixtureData, client);
    }

    async function launchAndCheck() {
        await waitForOffline();
        // simctl may launch the process even if it fails to return a usable PID.
        stopped = false;
        const launched = await simctl('launch', fixtureUDID, bundleID);
        const match = launched.stdout.match(/:\s*(\d+)\s*$/m);
        if (!match || Number(match[1]) <= 0) throw new Error('simctl launch did not provide the app process PID.');
        fixturePID = Number(match[1]);
        const deadline = Date.now() + options.timeoutMs;
        let health;
        while (Date.now() < deadline) {
            checkActive();
            if (!processAlive(fixturePID)) throw new Error('Simulator app exited before backend readiness.');
            try {
                const response = await probe();
                if (response?.status === 200 && response.body?.ready === true) {
                    health = response.body;
                    if (health.version !== expectedManifest.applicationVersion || health.deploymentId !== expectedManifest.deploymentId) {
                        throw new Error('Health belongs to a different deployment than the built App.app.');
                    }
                    break;
                }
                if (response?.body?.error) throw new Error('The native backend reported initialization failure.');
            } catch (error) {
                if (!['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)) throw error;
            }
            await pause(1000);
        }
        if (!health) throw new Error('Native backend did not become ready within the configured timeout.');
        await resolveContainer();
        const appPath = (await simctl('get_app_container', fixtureUDID, bundleID, 'app')).stdout.trim();
        const installedApp = await validateBundlePath(appPath, fixtureUDID, devicesRoot);
        const build = (await run('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', path.join(installedApp, 'Info.plist')])).stdout.trim();
        if (build !== expectedBuild) throw new Error('Installed app build number differs from the expected deployment.');
        const installed = await verifyRuntimeManifest(await child(runtimeRelative));
        if (JSON.stringify(installed) !== JSON.stringify(expectedManifest)) throw new Error('Installed runtime manifest differs from the built application.');
        for (const relative of [pendingRelative, previousRelative]) {
            try { await fs.lstat(await child(relative)); throw new Error(`Interrupted runtime directory was not removed: ${relative}`); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const nativeConfig = JSON.parse(await fs.readFile(await child('Library/Application Support/st_config.json'), 'utf8'));
        if (nativeConfig.deploymentId !== expectedManifest.deploymentId || nativeConfig.applicationVersion !== expectedManifest.applicationVersion
            || await fs.realpath(nativeConfig.documentsPath) !== await fs.realpath(await child('Documents'))) {
            throw new Error('Swift native path configuration does not match the fixture/deployment.');
        }
        return { deploymentId: health.deploymentId, version: health.version, build, runtimeVerified: true, pendingRemoved: true, previousRemoved: true };
    }

    function isInitialLaunchTimeout(error) {
        const command = error.commandError;
        return command?.command === 'xcrun'
            && JSON.stringify(command.arguments) === JSON.stringify(['simctl', 'launch', fixtureUDID, bundleID])
            && command.timeoutMs === 120000 && command.timedOut === true
            && command.killed === true && command.exitCode === null && command.errorCode === null
            && command.signal === 'SIGTERM'
            && command.stdoutTail === '' && command.stderrTail === '';
    }

    async function recoverInitialLaunch(originalError) {
        if (!isInitialLaunchTimeout(originalError)) throw originalError;
        // This path is exclusive to the first launch, before any user-data fixture exists.
        if (!ownershipVerified || !candidateValidated || !uuidPattern.test(fixtureUDID ?? '')
            || fixtureUDID.toUpperCase() === options.udid.toUpperCase()
            || !fixtureName || !fixtureDeviceType || !fixtureRuntime || !bundleID
            || report.scenarios.length !== 0 || activeScenario !== null || fixtureData !== undefined
            || expectedConfig !== undefined || transferState !== undefined || container !== undefined
            || fixturePID !== undefined || stopped) throw originalError;
        checkActive();
        const recovery = { status: 'failed', startedAt: new Date().toISOString(),
            originalError: failureMessage(originalError), originalCommandError: originalError.commandError };
        report.initialLaunchRecovery = recovery;
        try {
            await checkpoint('initial-launch-recovery-start');
            // Only ECONNREFUSED produces null from the real probe. A response,
            // timeout, or other network error is not evidence of an idle port.
            if (await probe() !== null) throw new Error('Port 8000 still has a listener after the initial launch timeout.');
            checkActive();
            recovery.offlineVerified = true;
            await checkpoint('initial-launch-recovery-offline');

            const ownedBooted = async () => {
                const listing = JSON.parse((await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], 20000)).stdout);
                const device = selectSimulator(listing, fixtureUDID);
                if (device.name !== fixtureName || device.deviceTypeIdentifier !== fixtureDeviceType
                    || device.runtime !== fixtureRuntime || device.state !== 'Booted') {
                    throw new Error('Owned Simulator identity or Booted state changed during initial launch recovery.');
                }
            };
            await ownedBooted();
            recovery.ownedBootedBeforeShutdown = true;
            await checkpoint('initial-launch-recovery-owned');
            await run('xcrun', ['simctl', 'shutdown', fixtureUDID], 30000);
            stopped = true;
            fixturePID = undefined;
            await run('xcrun', ['simctl', 'boot', fixtureUDID], 120000);
            await run('xcrun', ['simctl', 'bootstatus', fixtureUDID, '-b'], 300000);
            await ownedBooted();
            recovery.rebootedOwnedSimulator = true;
            await checkpoint('initial-launch-recovery-booted');

            const dataPath = (await run('xcrun', ['simctl', 'get_app_container', fixtureUDID, bundleID, 'data'], 20000)).stdout.trim();
            const appPath = (await run('xcrun', ['simctl', 'get_app_container', fixtureUDID, bundleID, 'app'], 20000)).stdout.trim();
            await validateContainerPath(dataPath, fixtureUDID, devicesRoot);
            await validateBundlePath(appPath, fixtureUDID, devicesRoot);
            recovery.installedContainersVerified = true;
            await checkpoint('initial-launch-recovery-containers');

            const result = await launchAndCheck();
            recovery.status = 'passed';
            recovery.finishedAt = new Date().toISOString();
            await checkpoint('initial-launch-recovery-passed');
            return result;
        } catch (error) {
            recovery.error = failureMessage(error);
            if (error.commandError) recovery.commandError = error.commandError;
            recovery.finishedAt = new Date().toISOString();
            try { await checkpoint('initial-launch-recovery-failed'); }
            catch (checkpointError) { recordCheckpointFailure(checkpointError); }
            if (active.signal.aborted) throw active.signal.reason;
            // Preserve the original timed-out launch as the primary failure when
            // listener absence cannot be established; no reboot was attempted.
            if (!recovery.offlineVerified) throw originalError;
            throw error;
        }
    }

    async function scenario(name, prepare, afterLaunch) {
        const scenarioStartedAt = Date.now();
        const result = { name, status: 'failed', startedAt: new Date(scenarioStartedAt).toISOString(),
            deploymentCheck: 'not-run', dataPreservationCheck: 'not-run', apiReadCheck: 'not-run' };
        report.scenarios.push(result);
        activeScenario = name;
        try {
            await checkpoint('scenario-start');
            await stopFixture();
            await checkpoint('scenario-prepare');
            await prepare();
            result.deploymentCheck = 'failed';
            await checkpoint('scenario-launch');
            Object.assign(result, await launchAndCheck(), { deploymentCheck: 'passed' });
            if (afterLaunch) await checkpoint('scenario-after-launch');
            if (afterLaunch) Object.assign(result, await afterLaunch());
            result.dataPreservationCheck = 'failed';
            await checkpoint('scenario-file-check');
            Object.assign(result, await assertDataPreserved(), { dataPreservationCheck: 'passed' });
            result.apiReadCheck = 'failed';
            await checkpoint('scenario-api-read');
            Object.assign(result, await checkReadAPI());
            // Some read endpoints populate caches; check the tracked user files again.
            result.dataPreservationCheck = 'failed';
            Object.assign(result, await assertDataPreserved(), { dataPreservationCheck: 'passed', status: 'passed' });
        } catch (error) {
            result.error = failureMessage(error);
            if (error.commandError) result.commandError = error.commandError;
            throw error;
        } finally {
            result.finishedAt = new Date().toISOString();
            result.durationMs = Date.now() - scenarioStartedAt;
            try { await checkpoint(result.status === 'passed' ? 'scenario-passed' : 'scenario-failed'); }
            finally { activeScenario = null; }
        }
    }

    async function corrupt(relative) {
        const filename = await writableChild(`${relative}/server-bundle.mjs`);
        const bytes = await fs.readFile(filename);
        if (!bytes.length) throw new Error('Cannot corrupt an empty bundle.');
        bytes[0] ^= 1; // Same size, so successful repair must check SHA-256, not just size.
        await fs.writeFile(filename, bytes);
    }

    async function pending() {
        const directory = await writableChild(pendingRelative);
        await fs.mkdir(directory);
        await fs.writeFile(await writableChild(`${pendingRelative}/runtime-manifest.json`), '{"formatVersion":1,"files":[]}');
        await fs.writeFile(await writableChild(`${pendingRelative}/partial.txt`), 'Incomplete fixture staging; not executable code.');
    }

    try {
        const validated = parseArguments(['--udid', options.udid, '--app', options.app, '--report', options.report, '--timeout-ms', String(options.timeoutMs ?? 180000),
            ...(options.upgradeApp ? ['--upgrade-app', options.upgradeApp] : [])]);
        options = validated;
        await validateReportPath(options.report, options.app, devicesRoot);
        if (options.upgradeApp) await validateReportPath(options.report, options.upgradeApp, devicesRoot);
        reportAllowed = true;
        await checkpoint('preflight');
        if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('This validation runs only on macOS with iOS Simulator.');
        const app = await fs.realpath(options.app);
        if (!(await fs.stat(app)).isDirectory()) throw new Error('Built App.app is not a directory.');
        expectedManifest = await verifyRuntimeManifest(path.join(app, 'public', 'nodejs-project'));
        for (const required of ['server-ios.js', 'server-bundle.mjs', 'config.yaml', 'package.json']) {
            if (!expectedManifest.files.some(file => file.path === required)) throw new Error(`Built runtime is missing ${required}.`);
        }
        const info = path.join(app, 'Info.plist');
        bundleID = (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info])).stdout.trim();
        const platforms = JSON.parse((await run('plutil', ['-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', info])).stdout);
        expectedBuild = (await run('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', info])).stdout.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(bundleID) || !platforms.includes('iPhoneSimulator')) throw new Error('App.app must be built for iPhoneSimulator with a valid bundle identifier.');
        report.bundleID = bundleID;
        report.expectedDeploymentId = expectedManifest.deploymentId;
        report.applicationVersion = expectedManifest.applicationVersion;
        report.initialBuild = expectedBuild;
        let upgrade;
        if (options.upgradeApp) {
            const upgradeApp = await fs.realpath(options.upgradeApp);
            const upgradeInfo = path.join(upgradeApp, 'Info.plist');
            const upgradeBundle = (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', upgradeInfo])).stdout.trim();
            const upgradePlatforms = JSON.parse((await run('plutil', ['-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', upgradeInfo])).stdout);
            const build = (await run('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', upgradeInfo])).stdout.trim();
            const manifest = await verifyRuntimeManifest(path.join(upgradeApp, 'public', 'nodejs-project'));
            if (upgradeBundle !== bundleID || !upgradePlatforms.includes('iPhoneSimulator') || build === expectedBuild || manifest.deploymentId === expectedManifest.deploymentId) {
                throw new Error('Upgrade app must have the same Simulator bundle ID, a distinct build and a distinct deployment manifest.');
            }
            for (const file of ['server-ios.js', 'server-bundle.mjs', 'config.yaml', 'package.json']) {
                if (!manifest.files.some(entry => entry.path === file)) throw new Error(`Upgrade runtime is missing ${file}.`);
            }
            if (manifest.applicationVersion !== expectedManifest.applicationVersion) throw new Error('This validator requires a controlled same-source deployment variant, not a different ST application version.');
            if (manifest.files.length !== expectedManifest.files.length + 1 || expectedManifest.files.some(file => {
                const target = manifest.files.find(entry => entry.path === file.path);
                return !target || target.sha256 !== file.sha256 || target.size !== file.size;
            })) throw new Error('Controlled upgrade must preserve all runtime files and add only its validation marker.');
            const marker = JSON.parse(await fs.readFile(path.join(upgradeApp, 'public', 'nodejs-project', 'validation-deployment-variant.json'), 'utf8'));
            if (marker.classification !== 'controlled-deployment-variant' || marker.sameApplicationSource !== true
                || marker.sourceDeploymentId !== expectedManifest.deploymentId || marker.fromBuild !== expectedBuild || marker.toBuild !== build) {
                throw new Error('Upgrade app must come from create-upgrade-variant.mjs with matching source metadata.');
            }
            upgrade = { app: upgradeApp, manifest, build };
            report.coverage.newManifestUpdate = true;
            report.upgrade = { classification: marker.classification, sameApplicationSource: true, fromDeploymentId: expectedManifest.deploymentId,
                toDeploymentId: manifest.deploymentId, fromBuild: expectedBuild, toBuild: build, differentSillyTavernVersions: false };
        }
        const template = selectSimulator(await listDevices(), options.udid);
        await checkpoint('template-selected');
        if (template.state === 'Booted') await terminate(template.udid);
        else await waitForOffline();
        fixtureName = `ST Data Validation ${randomUUID()}`;
        fixtureDeviceType = template.deviceTypeIdentifier;
        fixtureRuntime = template.runtime;
        fixtureUDID = (await simctl('create', fixtureName, template.deviceTypeIdentifier, template.runtime)).stdout.trim();
        if (!uuidPattern.test(fixtureUDID) || fixtureUDID.toUpperCase() === template.udid.toUpperCase()) throw new Error('simctl did not create a distinct fixture Simulator UUID.');
        candidateValidated = true;
        report.fixtureUDID = fixtureUDID;
        const fixture = selectSimulator(await listDevices(), fixtureUDID);
        if (fixture.name !== fixtureName || fixture.deviceTypeIdentifier !== template.deviceTypeIdentifier || fixture.runtime !== template.runtime) throw new Error('Created Simulator does not match the owned fixture.');
        fixtureDeviceType = fixture.deviceTypeIdentifier;
        fixtureRuntime = fixture.runtime;
        ownershipVerified = true;
        await checkpoint('owned-simulator-verified');
        if (report.checkpointError) throw new Error('Data validation progress checkpoint failed after Simulator creation.');
        checkActive();
        await simctl('boot', fixtureUDID);
        await run('xcrun', ['simctl', 'bootstatus', fixtureUDID, '-b'], 600000);
        await run('xcrun', ['simctl', 'install', fixtureUDID, app], 240000);
        const initialStartedAt = Date.now();
        await checkpoint('initial-launch');
        let first;
        try { first = await launchAndCheck(); }
        catch (error) { first = await recoverInitialLaunch(error); }
        report.scenarios.push({ name: 'initial-install', status: 'passed', startedAt: new Date(initialStartedAt).toISOString(),
            finishedAt: new Date().toISOString(), durationMs: Date.now() - initialStartedAt,
            deploymentCheck: 'passed', dataPreservationCheck: 'not-created', ...first });
        await checkpoint('initial-install-passed');
        await stopFixture();

        await checkpoint('seed-generated-data');
        const id = randomUUID();
        const config = await fs.readFile(await child(configRelative));
        expectedConfig = Buffer.concat([config, Buffer.from(`\nsimulatorDataValidation: "${id}"\n`)]);
        await fs.writeFile(await writableChild(configRelative), expectedConfig);
        const initialSettings = JSON.parse(await fs.readFile(await child('Documents/SillyTavern/default-user/settings.json'), 'utf8'));
        await seedData(createDataFixture(id, initialSettings));
        report.fixtureKinds = fixtureData.files.map(file => file.kind);
        await assertDataPreserved();

        await scenario('same-app-reinstall', async () => { await simctl('install', fixtureUDID, app); await resolveContainer(); });
        await scenario('installed-same-size-corruption', async () => { await corrupt(runtimeRelative); });
        await scenario('interrupted-stale-staging', async () => {
            await fs.cp(await child(runtimeRelative), await writableChild(previousRelative), { recursive: true, errorOnExist: true, force: false });
            await pending();
        });
        await scenario('interrupted-missing-installed', async () => {
            await fs.rename(await writableChild(runtimeRelative), await writableChild(previousRelative));
            await pending();
        });
        await scenario('interrupted-corrupt-installed', async () => {
            await fs.cp(await child(runtimeRelative), await writableChild(previousRelative), { recursive: true, errorOnExist: true, force: false });
            await corrupt(runtimeRelative);
            await pending();
        });
        await scenario('interrupted-unusable-previous', async () => {
            await fs.rename(await writableChild(runtimeRelative), await writableChild(previousRelative));
            await corrupt(previousRelative);
            await pending();
        });
        await scenario('api-import-export-backup-restore', async () => {}, async () => {
            const api = await (dependencies.transferClientFactory ?? createTransferClient)();
            const result = await (dependencies.transferScenario ?? runTransferScenario)(fixtureData,
                { api, readFile: async relative => fs.readFile(await child(relative)) });
            transferState = result.state;
            return { transfer: result.report };
        });
        await scenario('api-transfer-cold-reopen', async () => {}, async () => {
            if (!transferState) throw new Error('Transfer scenario did not establish restore evidence.');
            const api = await (dependencies.transferClientFactory ?? createTransferClient)();
            return { transferColdReopen: await (dependencies.verifyTransferReopen ?? verifyTransferReopen)(
                fixtureData, transferState, { api, readFile: async relative => fs.readFile(await child(relative)) }) };
        });
        if (upgrade) {
            const verifyTransferredDataAfterUpgrade = async () => {
                if (!transferState) throw new Error('Transfer scenario did not establish restore evidence.');
                const api = await (dependencies.transferClientFactory ?? createTransferClient)();
                return { transferAfterUpgrade: await (dependencies.verifyTransferReopen ?? verifyTransferReopen)(
                    fixtureData, transferState, { api, readFile: async relative => fs.readFile(await child(relative)) }) };
            };
            await scenario('changed-manifest-upgrade', async () => {
                await simctl('install', fixtureUDID, upgrade.app);
                expectedManifest = upgrade.manifest;
                expectedBuild = upgrade.build;
                await resolveContainer();
            }, verifyTransferredDataAfterUpgrade);
            await scenario('upgrade-interrupted-old-previous', async () => {
                await fs.cp(path.join(app, 'public', 'nodejs-project'), await writableChild(previousRelative), { recursive: true, force: false, errorOnExist: true });
                await corrupt(runtimeRelative);
                await pending();
            }, verifyTransferredDataAfterUpgrade);
            await scenario('upgrade-interrupted-missing-installed', async () => {
                await fs.rm(await writableChild(runtimeRelative), { recursive: true, force: false });
                await fs.cp(path.join(app, 'public', 'nodejs-project'), await writableChild(previousRelative), { recursive: true, force: false, errorOnExist: true });
                await pending();
            }, verifyTransferredDataAfterUpgrade);
        }
        const legacyID = randomUUID();
        await scenario('synthetic-1.17-config-migration', async () => {
            await fs.writeFile(await writableChild(configRelative), legacyConfig(legacyID));
            await seedData(createDataFixture(legacyID, { firstRun: true, username: 'User', user_avatar: 'user-default.png',
                amount_gen: 350, main_api: 'koboldhorde', power_user: { personas: {}, persona_descriptions: {}, custom_stopping_strings: '' } }, { legacy: true }));
        }, async () => {
            const migrated = await fs.readFile(await child(configRelative));
            const result = verifyLegacyConfig(migrated, legacyID);
            expectedConfig = migrated;
            return { configMigration: result };
        });
        await scenario('synthetic-1.17-second-cold-start', async () => {});
        report.finalDeploymentId = expectedManifest.deploymentId;
        report.finalBuild = expectedBuild;
        if (report.checkpointError) throw new Error('Data validation progress checkpoint failed.');
        report.status = 'passed';
        await checkpoint('all-scenarios-passed');
    } catch (error) {
        report.status = 'failed';
        report.error = failureMessage(error);
        if (error.timedOut || error.commandError?.timedOut) report.timedOut = true;
        if (error.commandError) report.commandError = error.commandError;
        try { await checkpoint('validation-failed'); }
        catch { /* The final save below will still be attempted after cleanup. */ }
    }
    finally {
        cleaningUp = true;
        clearTimeout(deadlineTimer);
        dependencies.signal?.removeEventListener('abort', relayAbort);
        const cleanupErrors = [];
        const cleanupCheckpoint = async phase => {
            try { await checkpoint(phase); }
            catch (error) { cleanupErrors.push(`Progress checkpoint failed: ${failureMessage(error)}`); }
        };
        if (fixtureUDID && (ownershipVerified || candidateValidated)) {
            await cleanupCheckpoint('cleanup-start');
            if (ownershipVerified) {
                try {
                    await stopFixture();
                } catch (error) {
                    cleanupErrors.push(`App termination failed: ${failureMessage(error)}`);
                    if (error.commandError) report.cleanup.commandError = error.commandError;
                }
            }
            const owned = async (requireShutdown = false) => {
                const fixture = selectSimulator(await listDevices(), fixtureUDID);
                if (fixture.name !== fixtureName || fixture.deviceTypeIdentifier !== fixtureDeviceType || fixture.runtime !== fixtureRuntime) {
                    throw new Error('Owned Simulator identity changed; refusing cleanup mutation.');
                }
                if (requireShutdown && fixture.state !== 'Shutdown') {
                    throw new Error('Owned Simulator is not shut down; refusing deletion.');
                }
                return fixture;
            };
            try {
                const fixture = await owned();
                if (fixture.state !== 'Shutdown') await simctl('shutdown', fixtureUDID);
            } catch (error) {
                cleanupErrors.push(`Owned Simulator shutdown failed: ${failureMessage(error)}`);
                if (error.commandError) report.cleanup.commandError = error.commandError;
            }
            try {
                await owned(true);
                await simctl('delete', fixtureUDID);
                report.cleanup.deletedOwnedSimulator = true;
            } catch (error) {
                cleanupErrors.push(`Owned Simulator deletion failed: ${failureMessage(error)}`);
                if (error.commandError) report.cleanup.commandError = error.commandError;
            }
            await cleanupCheckpoint('cleanup-finished');
        }
        if (cleanupErrors.length) {
            report.cleanup.error = cleanupErrors[0];
            report.cleanup.errors = cleanupErrors;
            report.status = 'failed';
        }
        report.finishedAt = new Date().toISOString();
        report.durationMs = Date.now() - startedAtMs;
        if (reportAllowed) {
            await validateReportPath(options.report, options.app, devicesRoot);
            if (options.upgradeApp) await validateReportPath(options.report, options.upgradeApp, devicesRoot);
            await writeReport(options.report, report);
        }
    }
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArguments(process.argv.slice(2));
        if (options.help) console.log(usage);
        else {
            const cancellation = new AbortController();
            const interrupt = () => cancellation.abort(new Error('Data validation interrupted by SIGINT'));
            const terminate = () => cancellation.abort(new Error('Data validation interrupted by SIGTERM'));
            process.once('SIGINT', interrupt);
            process.once('SIGTERM', terminate);
            let report;
            try { report = await validateSimulatorData(options, { signal: cancellation.signal }); }
            finally {
                process.removeListener('SIGINT', interrupt);
                process.removeListener('SIGTERM', terminate);
            }
            for (const scenario of report.scenarios) console.log(`${scenario.status}: ${scenario.name}`);
            console.log(`Simulator data validation ${report.status}; report: ${options.report}`);
            if (report.error) console.error(report.error);
            if (report.commandError) console.error(JSON.stringify(report.commandError, null, 2));
            if (report.cleanup.error) console.error(`Cleanup failed: ${report.cleanup.error}`);
            if (report.cleanup.commandError) console.error(JSON.stringify(report.cleanup.commandError, null, 2));
            process.exitCode = report.status === 'passed' ? 0 : 1;
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
