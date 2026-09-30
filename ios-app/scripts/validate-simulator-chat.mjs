#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { selectSimulator } from './validate-simulator-data.mjs';
import { parseUIArguments, uiProfiles, selectRequestedProfiles, selectProfileType, configureXctestrun, checkUIOutputRoot, checkpointSimulatorPhase, waitForOffline } from './validate-simulator-ui.mjs';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';
import { requestHTTP, sanitizeHostDiagnostic } from './validate-api.mjs';
import { createChatContract, validateChatContract, createChatMockProvider, createChatBackendClient, seedChatFixture, verifyChatTranscript, verifyChatProvider } from './simulator-chat-fixture.mjs';

export const chatTestSelector = 'AppUITests/SillyTavernUITests/testChatGenerationSaveAndColdRelaunch';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const inside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
export const parseChatArguments = parseUIArguments;

export function chatProfilesPassed(profiles, requestedProfiles) {
    return profiles.length === requestedProfiles.length && profiles.every((item, index) =>
        item.profile === requestedProfiles[index].name && item.status === 'passed'
        && item.cleanup.providerClosed && item.cleanup.deletedOwnedSimulator);
}

export function configureChatXctestrun(source, profile, productsRoot, contract) {
    validateChatContract(contract);
    const configured = configureXctestrun(source, profile, productsRoot);
    let targets = 0;
    function visit(value) {
        if (!value || typeof value !== 'object') return;
        if (value.IsUITestBundle === true && value.BlueprintName === 'AppUITests') {
            value.EnvironmentVariables = { ...value.EnvironmentVariables, ST_CHAT_FIXTURE_JSON: JSON.stringify(contract) };
            targets++;
        }
        for (const item of Object.values(value)) visit(item);
    }
    visit(configured);
    if (targets !== 1) throw new Error('Exactly one actual AppUITests target is required for the chat selector.');
    return configured;
}

/** No borrowed/template app is stopped: an occupied port is an explicit refusal. */
export async function requireNativePortOffline(options) {
    await waitForOffline(options);
}

/** Scope every disk read to the newly created Simulator; never shared user data. */
export async function checkChatContainer(container, udid, devicesRoot) {
    if (!uuidPattern.test(udid)) throw new Error('An owned Simulator UUID is required.');
    const resolvedDevices = await fs.realpath(devicesRoot);
    const devicePath = path.join(resolvedDevices, udid);
    if (!(await fs.lstat(devicePath)).isDirectory()) throw new Error('The owned Simulator root must be an ordinary directory.');
    const root = await fs.realpath(devicePath);
    if (path.dirname(root) !== resolvedDevices || path.basename(root).toLowerCase() !== udid.toLowerCase()) throw new Error('The owned Simulator root resolves outside its Devices directory.');
    const actual = await fs.realpath(container);
    const expected = path.join(root, 'data', 'Containers', 'Data', 'Application');
    if (!inside(expected, actual) || path.dirname(actual) !== expected || !uuidPattern.test(path.basename(actual))) throw new Error('The app container is outside the owned Simulator.');
    return actual;
}

export function verifyChatUIEvidence(observation, contract) {
    assert.equal(observation.schemaVersion, 1);
    assert.equal(observation.fixtureId, contract.fixtureId);
    assert.equal(observation.characterName, contract.characterName);
    assert.equal(observation.firstPrompt, contract.firstPrompt);
    assert.equal(observation.firstResponse, contract.firstResponse);
    assert.equal(observation.cancelPrompt, contract.cancelPrompt);
    assert.equal(observation.cancelResponse, contract.cancelPrefix);
    assert.equal(observation.coldRelaunchRestored, true);
    assert.equal(observation.streamObserved, true);
    assert.equal(observation.stopTapped, true);
    assert.ok(Number.isFinite(observation.beforeColdRelaunchAt) && observation.beforeColdRelaunchAt > 0,
        'XCTest must record its actual first cold-termination boundary');
    assert.ok(Number.isFinite(observation.stopTappedAt) && observation.stopTappedAt > 0
        && observation.stopTappedAt < observation.beforeColdRelaunchAt, 'XCTest must record its actual Stop tap before cold relaunch');
    assert.ok(typeof observation.firstStreamText === 'string' && observation.firstStreamText.includes(contract.firstPrefix.trim())
        && !observation.firstStreamText.includes(contract.firstResponse), 'The actual AX observation must contain an incomplete stream, not just its completed response');
    assert.ok(typeof observation.savedChatName === 'string' && observation.savedChatName && !/[\0/\\]/.test(observation.savedChatName), 'The actual saved chat name must be reported');
    if (observation.chatIntegrity !== undefined) assert.ok(uuidPattern.test(observation.chatIntegrity));
    return { actualSend: true, intermediateTextAndStopVisible: true, actualStop: true, coldRelaunchUIRestored: true };
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
                error.commandDetails = { command, arguments: args, exitCode: typeof error.code === 'number' ? error.code : null,
                    signal: error.signal ?? null, killed: error.killed === true, timeoutMs,
                    stdoutTail: sanitizeHostDiagnostic(stdout), stderrTail: sanitizeHostDiagnostic(stderr) };
                error.capturedOutput = (stdout + stderr).replace(/generated-fixture-[a-f0-9-]+/gi, '[redacted fixture]');
                reject(error);
            } else resolve({ stdout, stderr });
        };
        const child = execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
            detached: process.platform === 'darwin', maxBuffer: 32 * 1024 * 1024 }, finish);
        child.stdout?.on('data', chunk => { stdoutTail = (stdoutTail + chunk).slice(-16384); });
        child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-16384); });
        // execFile waits for inherited pipes to close after its timeout. Kill the
        // entire dedicated command group and bound that wait on macOS as well.
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
const failure = error => ({ message: sanitizeHostDiagnostic(error.message), ...(error.commandDetails ? { command: error.commandDetails } : {}) });
async function writeJSON(filename, value) {
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
        await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
}

async function terminate(udid, bundleID) {
    try { await simctl('terminate', udid, bundleID); } catch (error) { if (!/not running|no such process|found no running process|found nothing to terminate/i.test(error.commandDetails?.stderrTail ?? error.message)) throw error; }
}

/** Preserve the ownership check, but do not let one stuck simctl cleanup command prevent deletion. */
export async function cleanupOwnedChatSimulator({ fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier, installed, launched, bundleID },
    command = (args, timeoutMs) => run('xcrun', ['simctl', ...args], timeoutMs)) {
    const cleanup = { deletedOwnedSimulator: false };
    let current;
    try {
        current = selectSimulator(JSON.parse((await command(['list', 'devices', 'available', '--json'], 20000)).stdout), fixtureUDID);
        assert.deepEqual({ name: current.name, runtime: current.runtime, type: current.deviceTypeIdentifier },
            { name: fixtureName, runtime: runtimeIdentifier, type: deviceTypeIdentifier }, 'Owned Simulator identity changed; refusing cleanup.');
        cleanup.simulatorState = current.state;
    } catch (error) { cleanup.simulatorError = failure(error); return cleanup; }
    if (installed && launched && current.state === 'Booted') {
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

async function waitOffline() {
    await requireNativePortOffline();
}

async function waitHealth(manifest) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        let response;
        try { response = await requestHTTP('http://127.0.0.1:8000/api/ios/health', { timeoutMs: 2000 }); } catch (error) {
            if (!['ECONNREFUSED', 'ECONNRESET', 'ST_CLIENT_TIMEOUT'].includes(error.code)) throw error;
            await delay(500); continue;
        }
        if (response.status !== 200) { await delay(500); continue; }
        const health = JSON.parse(response.text);
        if (health.version !== manifest.applicationVersion || health.deploymentId !== manifest.deploymentId) throw new Error('The responding backend does not belong to the expected packaged runtime.');
        if (health.ready === true) return health;
        if (health.status === 'failed') throw new Error('The owned native backend reported startup failure.');
        await delay(500);
    }
    throw new Error('The owned native backend did not become ready within180s.');
}

/** Recover only an output-free timeout of the first, pre-fixture simctl launch. */
function initialLaunchTimedOut(error, fixtureUDID, bundleID) {
    const details = error.commandDetails;
    return details?.command === 'xcrun'
        && JSON.stringify(details.arguments) === JSON.stringify(['simctl', 'launch', fixtureUDID, bundleID])
        && details.timeoutMs === 120000 && details.exitCode === null
        && details.killed === true && details.signal === 'SIGKILL'
        && !details.stdoutTail?.trim() && !details.stderrTail?.trim();
}

/** One bounded reboot of the newly created Simulator, with all app checks retained. */
export async function launchInitiallyWithRecovery({ fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier,
    bundleID, manifest, result, phase, verifyInstalled }, {
    command = (args, timeoutMs) => run('xcrun', ['simctl', ...args], timeoutMs),
    probeHealth = () => requestHTTP('http://127.0.0.1:8000/api/ios/health', { timeoutMs: 2000 }),
    requireOffline = requireNativePortOffline,
} = {}) {
    const launch = () => command(['launch', fixtureUDID, bundleID], 120000);
    let initialError;
    try { await launch(); return; }
    catch (error) {
        if (!initialLaunchTimedOut(error, fixtureUDID, bundleID)) throw error;
        initialError = error;
    }
    const recovery = result.initialLaunchRecovery = { trigger: 'simulator-command-timeout', status: 'checking-health',
        firstAttempt: failure(initialError) };
    const owned = async expectedState => {
        const current = selectSimulator(JSON.parse((await command(['list', 'devices', 'available', '--json'], 20000)).stdout), fixtureUDID);
        assert.deepEqual({ name: current.name, runtime: current.runtime, type: current.deviceTypeIdentifier, state: current.state },
            { name: fixtureName, runtime: runtimeIdentifier, type: deviceTypeIdentifier, state: expectedState },
            'Owned Simulator identity/state changed; refusing initial launch recovery.');
    };
    try {
        await phase('initial-launch-health-probe');
        let response;
        try { response = await probeHealth(); }
        catch (error) {
            if (!['ECONNREFUSED', 'ECONNRESET', 'ST_CLIENT_TIMEOUT'].includes(error.code)) throw error;
            recovery.healthProbe = { unavailable: error.code };
        }
        if (response) {
            assert.ok(response.status === 200 || response.status === 503, 'The native health probe returned an unexpected HTTP status.');
            const health = JSON.parse(response.text);
            assert.equal(health.version, manifest.applicationVersion, 'The responding backend has a different application version.');
            assert.equal(health.deploymentId, manifest.deploymentId, 'The responding backend has a different runtime deployment.');
            assert.ok(health.status !== 'failed' && !health.error, 'The native backend reported startup failure.');
            assert.equal(typeof health.ready, 'boolean', 'The native health response lacks readiness.');
            assert.equal(response.status, health.ready ? 200 : 503, 'The native health status contradicts readiness.');
            await owned('Booted');
            recovery.healthProbe = { httpStatus: response.status, version: health.version, deploymentId: health.deploymentId,
                ready: health.ready };
            recovery.status = 'matching-health-observed';
            await phase('initial-launch-health-observed');
            return;
        }
        recovery.status = 'verifying-owned-simulator';
        await phase('initial-launch-verify-owned');
        await owned('Booted');
        // An unresponsive HTTP endpoint is not proof that another server is absent.
        await requireOffline();
        recovery.status = 'rebooting-owned-simulator';
        await phase('initial-launch-reboot-owned');
        await command(['shutdown', fixtureUDID], 30000);
        await command(['boot', fixtureUDID], 120000);
        await command(['bootstatus', fixtureUDID, '-b'], 300000);
        await owned('Booted');
        assert.ok(await verifyInstalled(20000), 'The installed app container could not be verified after boot.');
        recovery.installedAppVerifiedAfterBoot = true;
        await requireOffline();
        recovery.status = 'retrying-initial-launch';
        await phase('initial-launch-retry');
        try { await launch(); }
        catch (error) { recovery.retryError = failure(error); throw error; }
        recovery.status = 'retry-command-completed';
        await phase('initial-launch-retry-returned');
    } catch (error) {
        recovery.status = 'failed';
        recovery.error = failure(error);
        await phase('initial-launch-recovery-failed');
        throw error;
    }
}

async function childFile(container, relative, { missing = false } = {}) {
    const absolute = path.join(container, relative);
    if (!inside(container, absolute)) throw new Error('Unsafe owned container path.');
    try {
        const actual = await fs.realpath(absolute);
        if (!inside(container, actual)) throw new Error('Owned container file resolves outside the app.');
        return actual;
    } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
}

export async function readActualChat(container, contract, destination) {
    const directory = await childFile(container, `Documents/SillyTavern/default-user/chats/${contract.avatar.slice(0, -4)}`);
    const files = (await fs.readdir(directory)).filter(name => name.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'Exactly one actual fixture chat must be saved');
    const filename = files[0];
    assert.equal(path.basename(filename), filename);
    const bytes = await fs.readFile(await childFile(container, path.relative(container, path.join(directory, filename))));
    assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024, 'Chat evidence must be a bounded real JSONL file');
    // Preserve original failure bytes before checking their contents.
    await fs.writeFile(destination, bytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
    const result = verifyChatTranscript(rows, contract);
    return { filename, rows, bytes, result, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function chatAttachmentFromManifest(manifest, fixtureUDID) {
    assert.ok(Array.isArray(manifest));
    assert.ok(uuidPattern.test(fixtureUDID));
    const identifier = chatTestSelector.split('/').slice(1).join('/') + '()';
    const attachments = manifest.filter(item => item.testIdentifier === identifier).flatMap(item => item.attachments ?? []).filter(item => item.deviceId?.toLowerCase() === fixtureUDID.toLowerCase()
        && item.suggestedHumanReadableName?.includes('chat-observations'));
    assert.equal(attachments.length, 1, 'Exactly one actual XCTest chat observation attachment is required');
    const name = attachments[0].exportedFileName;
    if (typeof name !== 'string' || path.basename(name) !== name || /[\0/\\]/.test(name)) throw new Error('Unsafe exported XCTest attachment path');
    return name;
}

async function exportedChatObservation(directory, fixtureUDID) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const name = chatAttachmentFromManifest(manifest, fixtureUDID);
    const actual = await fs.realpath(path.join(directory, name));
    if (!inside(await fs.realpath(directory), actual)) throw new Error('XCTest attachment resolves outside its owned output.');
    return JSON.parse(await fs.readFile(actual, 'utf8'));
}

async function captureStartup(container, filename) {
    const source = await childFile(container, 'Library/Application Support/logs/startup.log', { missing: true });
    if (!source) return;
    const file = await fs.open(source, 'r');
    try {
        const size = (await file.stat()).size;
        const bytes = Buffer.alloc(Math.min(size, 16384));
        await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        await fs.writeFile(filename, sanitizeHostDiagnostic(bytes.toString('utf8')) + '\n');
    } finally { await file.close(); }
}

export async function validateSimulatorChat(options) {
    if (process.platform !== 'darwin') throw new Error('Actual native chat validation requires macOS/Xcode.');
    const app = await fs.realpath(options.app), xctestrun = await fs.realpath(options.xctestrun);
    const productsRoot = path.dirname(xctestrun);
    const manifest = await verifyRuntimeManifest(path.join(app, 'public', 'nodejs-project'));
    const info = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')])).stdout);
    if (info.CFBundleIdentifier !== 'com.sillytavern.ios' || !info.CFBundleSupportedPlatforms?.includes('iPhoneSimulator')
        || info.CFBundleShortVersionString !== manifest.applicationVersion) throw new Error('An actual packaged SillyTavern Simulator App is required.');
    const devicesRoot = path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
    const outputRoot = await checkUIOutputRoot(options.outputRoot, app, devicesRoot);
    const listing = JSON.parse((await simctl('list', 'devices', 'available', '--json')).stdout);
    const template = selectSimulator(listing, options.udid);
    const runtimes = JSON.parse((await simctl('list', 'runtimes', '--json')).stdout).runtimes;
    const runtime = runtimes.find(item => item.identifier === template.runtime && item.isAvailable === true);
    if (!runtime) throw new Error('The template runtime is unavailable.');
    const types = JSON.parse((await simctl('list', 'devicetypes', '--json')).stdout).devicetypes;
    const source = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', xctestrun])).stdout);
    const requestedProfiles = selectRequestedProfiles(options.profile);
    const selections = requestedProfiles.map(profile => ({ profile, type: selectProfileType(profile, types, runtime.version, template) }));
    await requireNativePortOffline();
    await fs.mkdir(outputRoot, { recursive: true });
    const report = { formatVersion: 1, status: 'failed', startedAt: new Date().toISOString(), sourceCommit: process.env.GITHUB_SHA ?? null,
        applicationVersion: manifest.applicationVersion, applicationBuild: info.CFBundleVersion, deploymentId: manifest.deploymentId,
        runtime: { identifier: runtime.identifier, version: runtime.version },
        requestedProfiles: requestedProfiles.map(profile => profile.name), profiles: [],
        coverage: { actualNativeNode: true, actualWebView: true, actualSendAndStop: true, physicalDevice: false, externalProvider: false,
            generatedLoopbackProvider: true, paidCalls: false, seededGeneratedReplies: false, injectedFrontendReadiness: false,
            autoLoadChatEnabled: true, realProviderCredentials: false,
            allProfilesRequested: requestedProfiles.length === uiProfiles.length } };
    for (const { profile, type } of selections) {
        const directory = path.join(outputRoot, profile.name);
        await fs.mkdir(directory);
        const result = { profile: profile.name, language: profile.language, status: 'failed', deviceType: { identifier: type.identifier, name: type.name },
            cleanup: { providerClosed: false, deletedOwnedSimulator: false } };
        report.profiles.push(result);
        const fixtureName = `SillyTavern-native-chat-${profile.name}-${randomUUID()}`;
        let fixtureUDID, ownership = false, installed = false, launched = false, provider, contract, container;
        const phase = name => checkpointSimulatorPhase({ profileName: profile.name, name, result, report, directory,
            outputRoot, reportName: 'chat-validation.json' });
        async function ownedContainer(timeoutMs = 120000) {
            if (!ownership || !installed) return null;
            const value = (await run('xcrun', ['simctl', 'get_app_container', fixtureUDID, info.CFBundleIdentifier, 'data'], timeoutMs)).stdout.trim();
            return checkChatContainer(value, fixtureUDID, devicesRoot);
        }
        try {
            await requireNativePortOffline();
            contract = createChatContract();
            // Shipping WebKit/XCTest AX snapshots and screenshots are slower
            // than host HTTP. Keep a genuine partial response visible long enough
            // for native UI assertions; never weaken stream/Stop evidence.
            // Keep the generated partial reply available beyond XCTest's
            // 25-second observation window; cancellation keeps its own bound.
            provider = await createChatMockProvider(contract, { prefixHoldMs: 30000, cancelTimeoutMs: 60000 });
            await phase('create-simulator');
            fixtureUDID = (await simctl('create', fixtureName, type.identifier, runtime.identifier)).stdout.trim();
            if (!uuidPattern.test(fixtureUDID) || Object.values(listing.devices).flat().some(item => item.udid.toLowerCase() === fixtureUDID.toLowerCase())) throw new Error('Created Simulator UUID is invalid or already existed.');
            // Cleanup repeats the identity check, so it is safe to track this UUID
            // before a potentially stuck post-create listing finishes.
            ownership = true; result.fixtureUDID = fixtureUDID;
            const created = selectSimulator(JSON.parse((await simctl('list', 'devices', 'available', '--json')).stdout), fixtureUDID);
            if (created.name !== fixtureName || created.runtime !== runtime.identifier || created.deviceTypeIdentifier !== type.identifier) throw new Error('Created Simulator ownership could not be verified.');
            await phase('boot-simulator');
            await simctl('boot', fixtureUDID);
            await run('xcrun', ['simctl', 'bootstatus', fixtureUDID, '-b'], 300000);
            await requireNativePortOffline();
            await phase('install-app');
            await simctl('install', fixtureUDID, app); installed = true;
            await phase('launch-app');
            await launchInitiallyWithRecovery({ fixtureUDID, fixtureName, runtimeIdentifier: runtime.identifier,
                deviceTypeIdentifier: type.identifier, bundleID: info.CFBundleIdentifier, manifest, result, phase,
                verifyInstalled: ownedContainer });
            launched = true;
            await phase('wait-native-backend');
            await waitHealth(manifest);
            container = await ownedContainer();
            const deployed = await verifyRuntimeManifest(await childFile(container, 'Library/nodejs/public'));
            assert.deepEqual(deployed, manifest, 'Actual native installed runtime must match the built app');
            const client = await createChatBackendClient();
            await phase('seed-fixture');
            contract = await seedChatFixture(client, provider, contract);
            await writeJSON(path.join(directory, 'fixture-contract.json'), contract);
            await terminate(fixtureUDID, info.CFBundleIdentifier); await waitOffline();

            const jsonPath = path.join(directory, 'chat-xctestrun.json'), runPath = path.join(directory, 'Chat.xctestrun');
            const configured = configureChatXctestrun(source, profile, productsRoot, contract);
            const visitTarget = value => {
                if (!value || typeof value !== 'object') return undefined;
                if (value.IsUITestBundle === true && value.BlueprintName === 'AppUITests') return value;
                return Object.values(value).map(visitTarget).find(Boolean);
            };
            assert.equal(await fs.realpath(visitTarget(configured).UITargetAppPath), app, 'XCTest must launch the identical verified Simulator app');
            await writeJSON(jsonPath, configured);
            await run('plutil', ['-convert', 'xml1', '-o', runPath, jsonPath]);
            const bundlePath = path.join(directory, 'UI-tests.xcresult');
            await phase('run-xctest');
            try {
                const output = await run('xcodebuild', ['test-without-building', '-xctestrun', runPath, '-destination', `id=${fixtureUDID}`,
                    '-only-testing:' + chatTestSelector, '-resultBundlePath', bundlePath, '-parallel-testing-enabled', 'NO', 'CODE_SIGNING_ALLOWED=NO'], 900000);
                await fs.writeFile(path.join(directory, 'xcodebuild.log'), output.stdout + output.stderr);
            } catch (error) {
                if (error.capturedOutput) await fs.writeFile(path.join(directory, 'xcodebuild.log'), error.capturedOutput);
                await writeJSON(path.join(directory, 'xcodebuild-failure.json'), failure(error)); throw error;
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
                || result.testResult.failed !== 0 || result.testResult.skipped !== 0) throw new Error('The selected actual native chat test did not pass with exported evidence.');
            await phase('verify-saved-chat');
            const observation = await exportedChatObservation(path.join(directory, 'screenshots'), fixtureUDID);
            result.ui = verifyChatUIEvidence(observation, contract);
            await writeJSON(path.join(directory, 'chat-observations.json'), observation);
            container = await ownedContainer();
            const before = await readActualChat(container, contract, path.join(directory, 'chat-original.jsonl'));
            assert.equal(observation.savedChatName + '.jsonl', before.filename, 'The actual XCTest/API chat must be the original JSONL file');
            result.savedChat = { ...before.result, filename: before.filename, bytes: before.bytes.length, sha256: before.sha256 };
            if (observation.chatIntegrity !== undefined) assert.equal(observation.chatIntegrity, before.result.integrity, 'XCTest/API and real JSONL integrity must match');
            const settings = JSON.parse(await fs.readFile(await childFile(container, 'Documents/SillyTavern/default-user/settings.json'), 'utf8'));
            assert.equal(settings.active_character, contract.avatar, 'The UI-selected character must actually persist before another launch');
            assert.equal(settings.power_user.auto_load_chat, true);
            assert.equal(settings.firstRun, false, 'Actual UI onboarding must have completed');

            // XCTest tearDown terminates its app. Launch the same owned app again
            // only for independent backend read verification; never generate/save.
            await phase('cold-relaunch');
            await simctl('launch', fixtureUDID, info.CFBundleIdentifier); await waitHealth(manifest);
            const restoredClient = await createChatBackendClient();
            const character = await restoredClient('/api/characters/get', { avatar_url: contract.avatar });
            assert.equal(character.chat + '.jsonl', before.filename);
            const restored = await restoredClient('/api/chats/get', { avatar_url: contract.avatar, file_name: character.chat });
            verifyChatTranscript(restored, contract); assert.deepEqual(restored, before.rows);
            await writeJSON(path.join(directory, 'chat-restored-api.json'), restored);
            const after = await readActualChat(container, contract, path.join(directory, 'chat-after-api-read.jsonl'));
            assert.deepEqual(after.bytes, before.bytes, 'Read verification must leave the actual JSONL bytes intact');
            const providerDeadline = Date.now() + 5000;
            while (!provider.observations.some(item => item.kind === 'generation' && item.scenario === 'cancel' && item.closed) && Date.now() < providerDeadline) await delay(100);
            // This happens while the provider is alive. Cleanup cannot manufacture
            // the upstream-close observation or make a timed-out stream pass.
            result.provider = verifyChatProvider(provider.observations, contract,
                { stopTappedAt: observation.stopTappedAt, beforeColdRelaunchAt: observation.beforeColdRelaunchAt });
            result.savedChat.backendReadMatchesOriginal = true;
            if (result.checkpointError) throw new Error('A native chat phase checkpoint could not be saved.');
            result.status = 'passed';
            await phase('completed');
        } catch (error) { result.failedPhase = result.phase ?? 'setup'; result.error = failure(error); } finally {
            await phase('cleanup');
            if (provider) {
                try { await writeJSON(path.join(directory, 'provider-observations.json'), structuredClone(provider.observations)); } catch (error) { result.providerEvidenceError = failure(error); result.status = 'failed'; }
            }
            if (ownership) {
                try {
                    container ??= await ownedContainer(12000);
                    if (container) await captureStartup(container, path.join(directory, 'startup.log'));
                    if (result.status !== 'passed') {
                        try { await run('xcrun', ['simctl', 'io', fixtureUDID, 'screenshot', path.join(directory, 'failure-screen.png')], 12000); }
                        catch { /* XCTest evidence remains primary. */ }
                        if (container && contract) {
                            try { await readActualChat(container, contract, path.join(directory, 'failure-chat.jsonl')); } catch (error) { result.chatEvidenceError = failure(error); }
                        }
                    }
                } catch (error) { result.startupEvidenceError = failure(error); }
                Object.assign(result.cleanup, await cleanupOwnedChatSimulator({ fixtureUDID, fixtureName,
                    runtimeIdentifier: runtime.identifier, deviceTypeIdentifier: type.identifier,
                    installed, launched, bundleID: info.CFBundleIdentifier }));
                if (result.cleanup.deletedOwnedSimulator) {
                    try { await waitOffline(); } catch (error) { result.cleanup.portError = failure(error); }
                }
                if (Object.keys(result.cleanup).some(key => key.endsWith('Error')) || !result.cleanup.deletedOwnedSimulator)
                    result.status = 'failed';
            }
            if (provider) {
                try { await provider.close(); result.cleanup.providerClosed = true; } catch (error) { result.cleanup.providerError = failure(error); result.status = 'failed'; }
            }
            await phase(result.status);
            await writeJSON(path.join(directory, 'profile-result.json'), result);
            await writeJSON(path.join(outputRoot, 'chat-validation.json'), report);
        }
    }
    report.status = chatProfilesPassed(report.profiles, requestedProfiles) ? 'passed' : 'failed';
    report.finishedAt = new Date().toISOString();
    await writeJSON(path.join(outputRoot, 'chat-validation.json'), report);
    return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseChatArguments(process.argv.slice(2));
        if (options.help) console.log('macOS only: --template-udid <UUID> --app </absolute/App.app> --xctestrun </absolute/App.xctestrun> --output-root </absolute/new-empty-directory> [--profile iphone-small-en|ipad-en|iphone-ko]');
        else {
            const report = await validateSimulatorChat(options);
            console.log(JSON.stringify({ status: report.status, profiles: report.profiles.map(item => ({ profile: item.profile, status: item.status, cleanup: item.cleanup })) }));
            if (report.status !== 'passed') process.exitCode = 1;
        }
    } catch (error) { console.error(sanitizeHostDiagnostic(error.message)); process.exitCode = 1; }
}
