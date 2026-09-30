#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { selectSimulator } from './validate-simulator-data.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const uiProfiles = Object.freeze([
    Object.freeze({ name: 'iphone-small-en', language: 'en', family: 'iPhone' }),
    Object.freeze({ name: 'ipad-en', language: 'en', family: 'iPad' }),
    Object.freeze({ name: 'iphone-ko', language: 'ko-kr', family: 'iPhone' }),
]);
export function selectRequestedProfiles(profileName) {
    if (profileName === undefined) return uiProfiles;
    const profile = uiProfiles.find(item => item.name === profileName);
    if (!profile) throw new Error(`Unknown UI profile: ${profileName}`);
    return [profile];
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const inside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function parseUIArguments(args) {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    const options = {};
    const names = { '--template-udid': 'udid', '--app': 'app', '--xctestrun': 'xctestrun', '--output-root': 'outputRoot', '--profile': 'profile' };
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]];
        const value = args[index + 1];
        if (!name || options[name] !== undefined || !value || value.startsWith('--')) throw new Error(`Invalid UI option: ${args[index]}`);
        options[name] = value;
    }
    if (!uuidPattern.test(options.udid ?? '')) throw new Error('An explicit available iOS Simulator UUID is required.');
    for (const name of ['app', 'xctestrun', 'outputRoot']) if (!path.isAbsolute(options[name] ?? '')) throw new Error(`${name} must be an absolute path.`);
    if (!options.app.endsWith('.app') || !options.xctestrun.endsWith('.xctestrun')) throw new Error('A built App.app and its .xctestrun are required.');
    selectRequestedProfiles(options.profile);
    return options;
}

function versionNumber(version) {
    if (typeof version !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(version)) return null;
    const [major, minor = 0, patch = 0] = version.split('.').map(Number);
    return major * 65536 + minor * 256 + patch;
}

/** Select real device types; report the chosen fallback rather than relabeling it. */
export function selectProfileType(profile, types, runtimeVersion, template) {
    if (!uiProfiles.some(item => item.name === profile.name && item.language === profile.language)) throw new Error('Unknown UI profile.');
    const version = versionNumber(runtimeVersion);
    if (version === null) throw new Error('A known iOS runtime version is required.');
    const available = types.filter(type => /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9-]+$/.test(type.identifier ?? '')
        && (Number.isFinite(type.minRuntimeVersion) ? version >= type.minRuntimeVersion : true)
        && (Number.isFinite(type.maxRuntimeVersion) ? version <= type.maxRuntimeVersion : true));
    let candidates;
    if (profile.name === 'iphone-ko') candidates = [template.deviceTypeIdentifier];
    else if (profile.name === 'iphone-small-en') candidates = [
        'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini',
        'com.apple.CoreSimulator.SimDeviceType.iPhone-16e',
    ];
    else candidates = [
        'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3',
        'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2',
        'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5',
        'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4',
        'com.apple.CoreSimulator.SimDeviceType.iPad-A16',
    ];
    const selected = candidates.map(identifier => available.find(type => type.identifier === identifier)).find(Boolean);
    if (!selected || !selected.identifier.split('.').at(-1).startsWith(profile.family)) throw new Error(`No supported device type for ${profile.name}; the profile cannot silently become a different screen family.`);
    return selected;
}

/** .xctestrun copies live elsewhere, so relocate only Xcode's TESTROOT token. */
export function configureXctestrun(source, profile, productsRoot) {
    if (!uiProfiles.some(item => item.name === profile.name && item.language === profile.language) || !path.isAbsolute(productsRoot)) throw new Error('Invalid test profile or Products root.');
    let count = 0;
    const visit = value => {
        if (Array.isArray(value)) return value.map(visit);
        if (value && typeof value === 'object') {
            const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
            if (copy.IsUITestBundle === true && (copy.BlueprintName === 'AppUITests' || /[/\\]AppUITests\.xctest$/.test(copy.TestBundlePath ?? ''))) {
                if (copy.UITargetAppBundleIdentifier && copy.UITargetAppBundleIdentifier !== 'com.sillytavern.ios') throw new Error('The UI target belongs to a different app.');
                if (!copy.UITargetAppPath || !copy.TestBundlePath) throw new Error('UI test target paths are missing.');
                copy.EnvironmentVariables = { ...copy.EnvironmentVariables, ST_UI_PROFILE: profile.name, ST_UI_LANGUAGE: profile.language };
                count++;
            }
            return copy;
        }
        return typeof value === 'string' ? value.replaceAll('__TESTROOT__', productsRoot) : value;
    };
    const configured = visit(source);
    if (count === 0) throw new Error('No AppUITests target found; refusing an unconfigured language run.');
    return configured;
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

export async function checkUIOutputRoot(outputRoot, app, devicesRoot) {
    if (!path.isAbsolute(outputRoot)) throw new Error('Output root must be absolute.');
    const target = await resolvedDestination(outputRoot);
    for (const directory of [app, devicesRoot]) {
        const protectedRoot = await resolvedDestination(directory);
        if (target === protectedRoot || inside(protectedRoot, target) || inside(target, protectedRoot)) throw new Error('UI output must be separate from built apps and Simulator containers.');
    }
    try {
        const stat = await fs.lstat(outputRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.readdir(outputRoot)).length !== 0) throw new Error('UI output root must be new or an empty ordinary directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
}

async function run(command, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        let settled = false, watchdog, fallback;
        let stdoutTail = '', stderrTail = '';
        const finish = (error, stdout, stderr) => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog); clearTimeout(fallback);
            if (error) {
                error.commandDetails = { command, arguments: args, timeoutMs, exitCode: typeof error.code === 'number' ? error.code : null,
                    signal: error.signal ?? null, killed: error.killed === true, stdoutTail: stdout.slice(-4096), stderrTail: stderr.slice(-4096) };
                error.capturedOutput = stdout + stderr;
                reject(error);
            } else resolve({ stdout, stderr });
        };
        const child = execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
            detached: process.platform === 'darwin', maxBuffer: 16 * 1024 * 1024 }, finish);
        child.stdout?.on('data', chunk => { stdoutTail = (stdoutTail + chunk).slice(-4096); });
        child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4096); });
        watchdog = setTimeout(() => {
            if (settled) return;
            try {
                if (process.platform === 'darwin' && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch { /* The hard deadline below still records the command failure. */ }
            fallback = setTimeout(() => {
                const error = new Error(`Command timed out: ${command} ${args.join(' ')}`);
                error.killed = true; error.signal = 'SIGKILL';
                child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); child.unref();
                finish(error, stdoutTail, stderrTail);
            }, 5000);
        }, timeoutMs + 1000);
    });
}
const simctl = (...args) => run('xcrun', ['simctl', ...args]);
const failure = error => ({ message: error.message.slice(0, 4096), ...(error.commandDetails ? { command: error.commandDetails } : {}) });
async function writeJSON(filename, value) {
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
        await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
}

/** Persist the last started phase before a long Simulator/XCTest operation. */
export async function checkpointSimulatorPhase({ profileName, name, result, report, directory, outputRoot, reportName }) {
    result.phase = name;
    result.phaseHistory ??= [];
    result.phaseHistory.push({ name, at: new Date().toISOString() });
    try {
        await writeJSON(path.join(directory, 'profile-result.json'), result);
        await writeJSON(path.join(outputRoot, reportName), report);
    } catch (error) {
        result.checkpointError = failure(error);
        result.status = 'failed';
    }
    console.log(JSON.stringify({ profile: profileName, phase: name }));
}

/** A refused TCP connection is evidence that no listener owns the local port. */
export async function probePortOffline({ port = 8000, timeoutMs = 1000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        let settled = false;
        const finish = (error, offline) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) reject(error);
            else resolve(offline);
        };
        socket.once('connect', () => finish(null, false));
        socket.once('error', error => error.code === 'ECONNREFUSED' ? finish(null, true) : finish(error));
        socket.setTimeout(timeoutMs, () => {
            const error = new Error('Local port probe timed out.');
            error.code = 'ETIMEDOUT';
            finish(error);
        });
    });
}

/** Inconclusive probes may recover; never infer an unused port from a timeout. */
export async function waitForOffline({ probe = probePortOffline, timeoutMs = 15000, retryMs = 200,
    now = Date.now, sleep = delay } = {}) {
    const deadline = now() + timeoutMs;
    let lastError = null;
    while (true) {
        try {
            if (await probe()) return;
            lastError = null;
        } catch (error) { lastError = error; }
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(retryMs, remaining));
    }
    if (lastError) throw new Error(`Port 8000 cannot be verified as unused (${lastError.code ?? lastError.message}); no existing app was stopped.`);
    throw new Error('Port 8000 is still occupied; refusing to start another embedded server.');
}
/** Verify identity once, then attempt each bounded cleanup action independently. */
export async function cleanupOwnedUISimulator({ fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier, xctestStarted, bundleID },
    command = (args, timeoutMs) => run('xcrun', ['simctl', ...args], timeoutMs)) {
    const cleanup = { deletedOwnedSimulator: false };
    let current;
    try {
        current = selectSimulator(JSON.parse((await command(['list', 'devices', 'available', '--json'], 20000)).stdout), fixtureUDID);
        if (current.name !== fixtureName || current.runtime !== runtimeIdentifier || current.deviceTypeIdentifier !== deviceTypeIdentifier)
            throw new Error('Owned Simulator identity changed; refusing cleanup.');
        cleanup.simulatorState = current.state;
    } catch (error) { cleanup.simulatorError = failure(error); return cleanup; }
    if (xctestStarted && current.state === 'Booted') {
        try { await command(['terminate', fixtureUDID, bundleID], 20000); }
        catch (error) {
            if (!/not running|no such process|found no running process|found nothing to terminate/i.test(error.commandDetails?.stderrTail ?? error.message))
                cleanup.terminationError = failure(error);
        }
    }
    if (current.state === 'Booted') {
        try { await command(['shutdown', fixtureUDID], 30000); }
        catch (error) { cleanup.shutdownError = failure(error); }
    }
    try { await command(['delete', fixtureUDID], 30000); cleanup.deletedOwnedSimulator = true; }
    catch (error) { cleanup.deleteError = failure(error); }
    return cleanup;
}

/** CLI intentionally uses actual simctl, Xcode and exported XCTest evidence. */
export async function validateSimulatorUI(options) {
    if (process.platform !== 'darwin') throw new Error('Actual Simulator UI validation requires macOS/Xcode.');
    const app = await fs.realpath(options.app);
    const productsRoot = path.dirname(await fs.realpath(options.xctestrun));
    const manifest = await verifyRuntimeManifest(path.join(app, 'public', 'nodejs-project'));
    const info = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')])).stdout);
    if (info.CFBundleIdentifier !== 'com.sillytavern.ios' || !info.CFBundleSupportedPlatforms?.includes('iPhoneSimulator')
        || info.CFBundleShortVersionString !== manifest.applicationVersion) throw new Error('An actual SillyTavern Simulator build is required.');
    const devicesRoot = path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
    const outputRoot = await checkUIOutputRoot(options.outputRoot, app, devicesRoot);
    const listing = JSON.parse((await simctl('list', 'devices', 'available', '--json')).stdout);
    const template = selectSimulator(listing, options.udid);
    const runtimes = JSON.parse((await simctl('list', 'runtimes', '--json')).stdout).runtimes;
    const runtime = runtimes.find(item => item.identifier === template.runtime && item.isAvailable === true);
    if (!runtime) throw new Error('The template runtime is unavailable.');
    const types = JSON.parse((await simctl('list', 'devicetypes', '--json')).stdout).devicetypes;
    const source = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', options.xctestrun])).stdout);
    const requestedProfiles = selectRequestedProfiles(options.profile);
    const selections = requestedProfiles.map(profile => ({ profile, type: selectProfileType(profile, types, runtime.version, template), configured: configureXctestrun(source, profile, productsRoot) }));
    await fs.mkdir(outputRoot, { recursive: true });
    const report = { formatVersion: 1, status: 'failed', startedAt: new Date().toISOString(), applicationVersion: manifest.applicationVersion,
        deploymentId: manifest.deploymentId, runtime: { identifier: runtime.identifier, version: runtime.version },
        requestedProfiles: requestedProfiles.map(profile => profile.name), profiles: [],
        coverage: { actualWebView: true, physicalDevice: false, languageSelectedInApp: true,
            allProfilesRequested: requestedProfiles.length === uiProfiles.length } };
    // Never terminate an app on the caller's template Simulator.
    await waitForOffline();
    for (const { profile, type, configured } of selections) {
        const directory = path.join(outputRoot, profile.name);
        await fs.mkdir(directory);
        const result = { profile: profile.name, requestedLanguage: profile.language, deviceType: { identifier: type.identifier, name: type.name },
            status: 'failed', cleanup: { deletedOwnedSimulator: false } };
        report.profiles.push(result);
        const fixtureName = `SillyTavern-stage3-${profile.name}-${randomUUID()}`;
        let fixtureUDID;
        let ownership = false, xctestStarted = false;
        const phase = name => checkpointSimulatorPhase({ profileName: profile.name, name, result, report, directory,
            outputRoot, reportName: 'ui-profiles.json' });
        try {
            await phase('create-simulator');
            fixtureUDID = (await simctl('create', fixtureName, type.identifier, runtime.identifier)).stdout.trim();
            if (!uuidPattern.test(fixtureUDID) || Object.values(listing.devices).flat().some(item => item.udid.toUpperCase() === fixtureUDID.toUpperCase())) throw new Error('Created Simulator UUID is invalid or already existed.');
            // Cleanup repeats the identity check if the following listing stalls.
            ownership = true;
            result.fixtureUDID = fixtureUDID;
            const created = selectSimulator(JSON.parse((await simctl('list', 'devices', 'available', '--json')).stdout), fixtureUDID);
            if (created.name !== fixtureName || created.runtime !== runtime.identifier || created.deviceTypeIdentifier !== type.identifier) throw new Error('Created Simulator ownership could not be verified.');
            await phase('boot-simulator');
            await simctl('boot', fixtureUDID);
            await run('xcrun', ['simctl', 'bootstatus', fixtureUDID, '-b'], 300000);
            await waitForOffline();
            const jsonPath = path.join(directory, 'profile-xctestrun.json');
            const runPath = path.join(directory, 'Profile.xctestrun');
            await writeJSON(jsonPath, configured);
            await run('plutil', ['-convert', 'xml1', '-o', runPath, jsonPath]);
            const bundlePath = path.join(directory, 'UI-tests.xcresult');
            await phase('run-xctest'); xctestStarted = true;
            try {
                const output = await run('xcodebuild', ['test-without-building', '-xctestrun', runPath, '-destination', `id=${fixtureUDID}`,
                    '-resultBundlePath', bundlePath, '-parallel-testing-enabled', 'NO',
                    '-only-testing:AppUITests/SillyTavernUITests/testOnboardingSliderKeyboardLifecycleAndPersistence', 'CODE_SIGNING_ALLOWED=NO'], 720000);
                await fs.writeFile(path.join(directory, 'xcodebuild.log'), output.stdout + output.stderr);
            } catch (error) {
                await fs.writeFile(path.join(directory, 'xcodebuild-failure.json'), JSON.stringify(failure(error), null, 2) + '\n');
                if (error.capturedOutput) await fs.writeFile(path.join(directory, 'xcodebuild.log'), error.capturedOutput);
                throw error;
            } finally {
                try {
                    const summary = JSON.parse((await run('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundlePath])).stdout);
                    await writeJSON(path.join(directory, 'ui-summary.json'), summary);
                    result.testResult = { result: summary.result, total: summary.totalTestCount, passed: summary.passedTests, failed: summary.failedTests, skipped: summary.skippedTests };
                    result.devices = summary.devicesAndConfigurations?.map(item => item.device);
                    await run('xcrun', ['xcresulttool', 'export', 'attachments', '--path', bundlePath, '--output-path', path.join(directory, 'screenshots')]);
                } catch (error) { result.evidenceError = failure(error); }
            }
            if (result.evidenceError || result.testResult?.result !== 'Passed' || result.testResult.total !== 1 || result.testResult.passed !== 1
                || result.testResult.failed !== 0 || result.testResult.skipped !== 0) throw new Error('The requested native UI test did not pass with exported evidence.');
            if (result.checkpointError) throw new Error('A native UI phase checkpoint could not be saved.');
            result.status = 'passed';
            await phase('completed');
        } catch (error) { result.failedPhase = result.phase ?? 'setup'; result.error = failure(error); }
        finally {
            await phase('cleanup');
            if (ownership) {
                Object.assign(result.cleanup, await cleanupOwnedUISimulator({ fixtureUDID, fixtureName,
                    runtimeIdentifier: runtime.identifier, deviceTypeIdentifier: type.identifier,
                    xctestStarted, bundleID: info.CFBundleIdentifier }));
                if (result.cleanup.deletedOwnedSimulator) {
                    try { await waitForOffline(); } catch (error) { result.cleanup.portError = failure(error); }
                }
                if (Object.keys(result.cleanup).some(key => key.endsWith('Error')) || !result.cleanup.deletedOwnedSimulator)
                    result.status = 'failed';
            }
            await phase(result.status);
            await writeJSON(path.join(directory, 'profile-result.json'), result);
            await writeJSON(path.join(outputRoot, 'ui-profiles.json'), report);
        }
    }
    report.status = report.profiles.length === requestedProfiles.length && report.profiles.every(profile => profile.status === 'passed'
        && profile.cleanup.deletedOwnedSimulator) ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString();
    await writeJSON(path.join(outputRoot, 'ui-profiles.json'), report);
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseUIArguments(process.argv.slice(2));
        if (options.help) console.log('macOS only: --template-udid <UUID> --app </absolute/App.app> --xctestrun </absolute/App.xctestrun> --output-root </absolute/new-directory> [--profile iphone-small-en|ipad-en|iphone-ko]');
        else {
            const report = await validateSimulatorUI(options);
            console.log(JSON.stringify({ status: report.status, profiles: report.profiles.map(item => ({ profile: item.profile, status: item.status, deviceType: item.deviceType.name, cleanup: item.cleanup })) }));
            if (report.status !== 'passed') process.exitCode = 1;
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
