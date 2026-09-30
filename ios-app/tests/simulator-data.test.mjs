import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeManifest, verifyRuntimeManifest } from '../scripts/runtime-manifest.mjs';
import { parseArguments, selectSimulator, validateContainerPath, checkedContainerChild, validateSimulatorData, defaultRunCommand } from '../scripts/validate-simulator-data.mjs';
import { read as readCard } from '../../src/character-card-parser.js';
import { createUpgradeVariant } from '../scripts/create-upgrade-variant.mjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');
const templateUDID = '11111111-1111-1111-1111-111111111111';
const fixtureUDID = '22222222-2222-2222-2222-222222222222';
const containerID = '33333333-3333-3333-3333-333333333333';
const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const bundleID = 'test.SillyTavern.simulator';
const relativeContainer = path.join(fixtureUDID, 'data', 'Containers', 'Data', 'Application', containerID);
const alreadyTerminatedStderr = `An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):
Simulator device failed to terminate ${bundleID}.
found nothing to terminate
The request to terminate ${bundleID} failed. found nothing to terminate`;
const alreadyTerminatedError = () => Object.assign(new Error('simctl terminate failed'), { stderr: alreadyTerminatedStderr });

async function removeInside(root, target) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path');
    await fs.rm(target, { recursive: true, force: true });
}

async function temporary(t) {
    await fs.mkdir(testRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(testRoot, 'simulator-data-'));
    t.after(() => removeInside(testRoot, directory));
    return directory;
}

async function exists(filename) {
    try { await fs.lstat(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('CLI requires explicit UUID, absolute app/report paths and bounded timeouts', () => {
    const app = path.resolve('Fixture.app');
    const report = path.resolve('result.json');
    const args = ['--udid', templateUDID, '--app', app, '--report', report];
    assert.deepEqual(parseArguments(args), { udid: templateUDID, app, report, timeoutMs: 180000 });
    assert.deepEqual(parseArguments(['--help']), { help: true });
    assert.throws(() => parseArguments(['--udid', 'booted', '--app', app, '--report', report]), /explicit Simulator UUID/);
    assert.throws(() => parseArguments(['--udid', templateUDID, '--app', 'Fixture.app', '--report', report]), /absolute built/);
    assert.throws(() => parseArguments([...args, '--timeout-ms', '1']), /between/);
    assert.throws(() => parseArguments([...args, '--udid', fixtureUDID]), /Invalid CLI/);
    assert.throws(() => parseArguments([...args, '--delete', fixtureUDID]), /Invalid CLI/);
});

test('Simulator selection rejects physical, unavailable and non-iOS device IDs', () => {
    const device = { udid: templateUDID, isAvailable: true, deviceTypeIdentifier };
    const listing = { devices: { [runtime]: [device] } };
    assert.equal(selectSimulator(listing, templateUDID).runtime, runtime);
    assert.throws(() => selectSimulator(listing, fixtureUDID), /Physical devices are not supported/);
    assert.throws(() => selectSimulator({ devices: { [runtime]: [{ ...device, isAvailable: false }] } }, templateUDID), /not an available iOS/);
    assert.throws(() => selectSimulator({ devices: { 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [device] } }, templateUDID), /not an available iOS/);
});

test('container and relative-path guards reject other devices, traversal and symlinks', async t => {
    const directory = await temporary(t);
    const devicesRoot = path.join(directory, 'Devices');
    const container = path.join(devicesRoot, relativeContainer);
    await fs.mkdir(container, { recursive: true });
    assert.equal(await validateContainerPath(container, fixtureUDID, devicesRoot), await fs.realpath(container));
    await assert.rejects(validateContainerPath(container, templateUDID, devicesRoot), /outside/);
    await assert.rejects(validateContainerPath(directory, fixtureUDID, devicesRoot), /outside/);
    await assert.rejects(checkedContainerChild(container, '../outside'), /Unsafe/);
    await assert.rejects(checkedContainerChild(container, 'Library\\outside'), /Unsafe/);
    await assert.rejects(checkedContainerChild(container, '/Library'), /Unsafe/);
    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(container, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkedContainerChild(container, 'alias/file.txt'), /symlink/);
    await fs.symlink(outside, path.join(container, 'Documents'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(validateContainerPath(path.join(devicesRoot, fixtureUDID, 'data', 'Containers', 'Data', 'Application', '44444444-4444-4444-4444-444444444444'), fixtureUDID, devicesRoot), /ENOENT/);
    // Replace the application's container itself with an alias and refuse it too.
    await removeInside(devicesRoot, container);
    await fs.symlink(outside, container, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(validateContainerPath(container, fixtureUDID, devicesRoot), /symlink/);
});

/** An external-app stub verifies runner fault layouts/order; it does not prove Swift recovery. */
async function fakeSimulator(t, behavior = {}) {
    const directory = await temporary(t);
    const devicesRoot = path.join(directory, 'CoreSimulator', 'Devices');
    const container = path.join(devicesRoot, relativeContainer);
    const app = path.join(directory, 'Fixture.app');
    const installedApp = path.join(devicesRoot, fixtureUDID, 'data', 'Containers', 'Bundle', 'Application', containerID, 'App.app');
    const bundled = path.join(app, 'public', 'nodejs-project');
    const installed = path.join(container, 'Library', 'nodejs', 'public');
    const previous = `${installed}.previous`;
    const pending = `${installed}.pending`;
    const config = path.join(container, 'Documents', 'SillyTavern', 'config.yaml');
    await fs.mkdir(bundled, { recursive: true });
    await fs.writeFile(path.join(app, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: bundleID,
        CFBundleSupportedPlatforms: ['iPhoneSimulator'], CFBundleVersion: '10190' }));
    for (const [filename, data] of Object.entries({
        'server-ios.js': '// native entry fixture\n', 'server-bundle.mjs': '// immutable executable fixture\n',
        'config.yaml': 'fixture: true\n', 'package.json': '{"type":"module"}\n',
    })) await fs.writeFile(path.join(bundled, filename), data);
    const manifest = await writeRuntimeManifest(bundled, '1.19.0');
    let activeManifest = manifest;
    let activeApp = app;
    const originalBundle = await fs.readFile(path.join(bundled, 'server-bundle.mjs'));
    const options = { udid: templateUDID, app, report: path.join(directory, 'reports', 'result.json'), timeoutMs: 5000 };
    const calls = [];
    const launches = [];
    let ownedDevice;
    let templateRunning = !behavior.templateAlreadyTerminated;
    let fixtureRunning = false;
    let pid;
    let installs = 0;

    async function verifyFaultLayout() {
        const index = launches.length;
        const layout = { installed: await exists(installed), previous: await exists(previous), pending: await exists(pending) };
        const expected = [
            { installed: false, previous: false, pending: false },
            { installed: true, previous: false, pending: false },
            { installed: true, previous: false, pending: false },
            { installed: true, previous: true, pending: true },
            { installed: false, previous: true, pending: true },
            { installed: true, previous: true, pending: true },
            { installed: false, previous: true, pending: true },
        ][index] ?? (behavior.upgrade && index === 10 ? { installed: true, previous: true, pending: true }
            : behavior.upgrade && index === 11 ? { installed: false, previous: true, pending: true }
                : { installed: true, previous: false, pending: false });
        assert.deepEqual(layout, expected);
        if ([1, 3].includes(index)) await verifyRuntimeManifest(installed);
        if ([3, 4, 5].includes(index)) await verifyRuntimeManifest(previous);
        if ([2, 5, 6].includes(index)) {
            const damaged = index === 6 ? previous : installed;
            const bytes = await fs.readFile(path.join(damaged, 'server-bundle.mjs'));
            assert.equal(bytes.length, originalBundle.length);
            assert.equal(bytes[0], originalBundle[0] ^ 1);
            assert.deepEqual(bytes.subarray(1), originalBundle.subarray(1));
            await assert.rejects(verifyRuntimeManifest(damaged), /integrity/);
        }
        if (layout.pending) await assert.rejects(verifyRuntimeManifest(pending), /Invalid runtime manifest/);
        if (behavior.upgrade && index === 9) {
            assert.equal((await verifyRuntimeManifest(installed)).deploymentId, manifest.deploymentId);
            assert.notEqual(activeManifest.deploymentId, manifest.deploymentId);
        }
        if (behavior.upgrade && [10, 11].includes(index)) {
            assert.equal((await verifyRuntimeManifest(previous)).deploymentId, manifest.deploymentId);
            if (index === 10) await assert.rejects(verifyRuntimeManifest(installed), /integrity/);
        }
        launches.push(layout);
    }

    async function runCommand(command, args, timeoutMs) {
        calls.push({ command, args, timeoutMs });
        if (command === 'plutil') {
            const filename = args.at(-1);
            const info = JSON.parse(await fs.readFile(filename, 'utf8'));
            if (args[0] === '-replace') {
                info[args[1]] = args[3];
                await fs.writeFile(filename, JSON.stringify(info));
                return { stdout: '' };
            }
            return { stdout: args[2] === 'json' ? JSON.stringify(info[args[1]]) : String(info[args[1]]) };
        }
        assert.equal(command, 'xcrun');
        assert.equal(args[0], 'simctl');
        const [operation, target, ...rest] = args.slice(1);
        if (operation === 'list') {
            assert.equal(target, 'devices');
            return { stdout: JSON.stringify({ devices: { [runtime]: [
                { udid: templateUDID, name: 'Existing UI test device', state: 'Booted', isAvailable: true, deviceTypeIdentifier },
                ...(ownedDevice ? [ownedDevice] : []),
            ] } }) };
        }
        if (operation === 'create') {
            assert.equal(rest[0], deviceTypeIdentifier);
            assert.equal(rest[1], runtime);
            ownedDevice = { name: target, udid: fixtureUDID, state: 'Shutdown', isAvailable: true, deviceTypeIdentifier };
            return { stdout: fixtureUDID };
        }
        if (operation === 'terminate' && target === templateUDID) {
            assert.equal(rest[0], bundleID);
            templateRunning = false;
            if (behavior.templateAlreadyTerminated) throw alreadyTerminatedError();
            return { stdout: '' };
        }
        assert.equal(target, fixtureUDID, 'operations must target only the newly created Simulator');
        if (operation === 'boot') ownedDevice.state = 'Booted';
        else if (operation === 'bootstatus') {
            assert.deepEqual(rest, ['-b']);
            if (behavior.bootstatusError) throw behavior.bootstatusError;
        }
        else if (operation === 'install') {
            assert.equal(fixtureRunning, false, 'install happens only while stopped');
            assert.equal(templateRunning, false);
            activeApp = rest[0];
            activeManifest = await verifyRuntimeManifest(path.join(activeApp, 'public', 'nodejs-project'));
            if (await exists(installedApp)) await removeInside(devicesRoot, installedApp);
            await fs.mkdir(path.dirname(installedApp), { recursive: true });
            await fs.cp(activeApp, installedApp, { recursive: true });
            installs++;
            if (installs === 1) {
                await fs.mkdir(path.dirname(config), { recursive: true });
                await fs.writeFile(config, 'fixtureAfterInitialMigration: true\n');
                await fs.mkdir(path.join(path.dirname(config), 'default-user'), { recursive: true });
                await fs.writeFile(path.join(path.dirname(config), 'default-user', 'settings.json'), '{"firstRun":true,"username":"User"}');
            } else if (behavior.loseConfigOnReinstall) await fs.writeFile(config, 'reset: true\n');
        } else if (operation === 'get_app_container') {
            assert.equal(rest[0], bundleID);
            assert.ok(['data', 'app'].includes(rest[1]));
            return { stdout: rest[1] === 'data' ? container : installedApp };
        } else if (operation === 'launch') {
            assert.equal(fixtureRunning, false);
            assert.equal(templateRunning, false);
            await verifyFaultLayout();
            if (await exists(installed)) await removeInside(container, installed);
            await fs.mkdir(path.dirname(installed), { recursive: true });
            await fs.cp(path.join(activeApp, 'public', 'nodejs-project'), installed, { recursive: true });
            for (const target of [previous, pending]) await removeInside(container, target);
            const support = path.join(container, 'Library', 'Application Support');
            await fs.mkdir(support, { recursive: true });
            await fs.writeFile(path.join(support, 'st_config.json'), JSON.stringify({
                deploymentId: activeManifest.deploymentId, applicationVersion: activeManifest.applicationVersion,
                documentsPath: path.join(container, 'Documents'),
            }));
            if ((await fs.readFile(config, 'utf8')).includes('disableThumbnails:')) {
                const { initConfig } = await import('../../src/config-init.js');
                const methods = { log: console.log, warn: console.warn };
                try { console.log = console.warn = () => {}; initConfig(config); }
                finally { Object.assign(console, methods); }
            }
            fixtureRunning = true;
            pid = 1000 + launches.length;
            return { stdout: behavior.omitPID ? bundleID : `${bundleID}: ${pid}\n` };
        } else if (operation === 'terminate') {
            assert.equal(rest[0], bundleID);
            fixtureRunning = false;
            if (behavior.fixtureAlreadyTerminated) throw alreadyTerminatedError();
        } else if (operation === 'shutdown') {
            assert.equal(fixtureRunning, false);
            ownedDevice.state = 'Shutdown';
        } else if (operation === 'delete') {
            assert.equal(fixtureRunning, false);
            assert.equal(ownedDevice.state, 'Shutdown');
            await removeInside(devicesRoot, path.join(devicesRoot, fixtureUDID));
            ownedDevice = undefined;
        } else throw new Error(`Unexpected simctl operation ${operation}`);
        return { stdout: '' };
    }

    const dependencies = {
        runCommand, devicesRoot, platform: 'darwin', pause: async () => {},
        processAlive: value => fixtureRunning && value === pid,
        probe: async () => fixtureRunning ? { status: 200, body: { ready: true, version: activeManifest.applicationVersion,
            deploymentId: behavior.wrongHealth ? '0'.repeat(64) : activeManifest.deploymentId } }
            : templateRunning ? { status: 200, body: { ready: true } } : null,
        apiClientFactory: async () => async (route, body) => {
            const root = path.join(container, 'Documents', 'SillyTavern', 'default-user');
            if (route === '/api/settings/get') {
                const presetNames = await fs.readdir(path.join(root, 'OpenAI Settings'));
                return { settings: await fs.readFile(path.join(root, 'settings.json'), 'utf8'),
                    openai_setting_names: presetNames.map(name => name.slice(0, -5)),
                    openai_settings: await Promise.all(presetNames.map(name => fs.readFile(path.join(root, 'OpenAI Settings', name), 'utf8'))) };
            }
            if (route === '/api/characters/get') {
                const card = readCard(await fs.readFile(path.join(root, 'characters', body.avatar_url)));
                const data = JSON.parse(card);
                return { name: data.data?.name ?? data.name, json_data: card, data: data.data ?? data };
            }
            if (route === '/api/chats/get') return (await fs.readFile(path.join(root, 'chats', body.avatar_url.slice(0, -4), `${body.file_name}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
            if (route === '/api/worldinfo/get') return JSON.parse(await fs.readFile(path.join(root, 'worlds', `${body.name}.json`), 'utf8'));
            if (route === '/api/avatars/get') return fs.readdir(path.join(root, 'User Avatars'));
            if (route.startsWith('/User%20Avatars/')) return fs.readFile(path.join(root, 'User Avatars', decodeURIComponent(route.split('/').at(-1))));
            if (route.startsWith('/user/files/')) return fs.readFile(path.join(root, 'user', 'files', decodeURIComponent(route.split('/').at(-1))));
            throw new Error(`Unexpected read API ${route}`);
        },
        // Unit tests model simulator command ordering. The separate JITless backend
        // integration test exercises the real upload/download/snapshot endpoints.
        transferClientFactory: async () => async () => { throw new Error('Unit transfer client must not make HTTP requests'); },
        transferScenario: async (fixture, { readFile }) => {
            if (behavior.transferFail) throw new Error('Generated transfer scenario failed');
            for (const file of fixture.files) assert.deepEqual(await readFile(file.path), file.bytes);
            return { state: { fixtureId: fixture.id }, report: { unitCommandOrderingOnly: true } };
        },
        verifyTransferReopen: async (fixture, state, { readFile }) => {
            assert.equal(state.fixtureId, fixture.id);
            for (const file of fixture.files) assert.deepEqual(await readFile(file.path), file.bytes);
            return { unitCommandOrderingOnly: true };
        },
    };
    if (behavior.upgrade) {
        const variant = await createUpgradeVariant({ sourceApp: app, outputRoot: path.join(directory, 'variant') }, { runCommand });
        options.upgradeApp = variant.upgradeApp;
    }
    return { options, dependencies, calls, launches, container, directory, app };
}

test('runner preserves representative data through repair and source-based legacy cold starts', async t => {
    const fixture = await fakeSimulator(t);
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'passed', report.error ?? report.cleanup.error);
    assert.deepEqual(report.scenarios.map(item => item.name), [
        'initial-install', 'same-app-reinstall', 'installed-same-size-corruption', 'interrupted-stale-staging',
        'interrupted-missing-installed', 'interrupted-corrupt-installed', 'interrupted-unusable-previous',
        'api-import-export-backup-restore', 'api-transfer-cold-reopen',
        'synthetic-1.17-config-migration', 'synthetic-1.17-second-cold-start',
    ]);
    assert.equal(fixture.launches.length, 11);
    for (const scenario of report.scenarios) {
        assert.equal(scenario.status, 'passed');
        assert.ok(scenario.durationMs >= 0);
        assert.ok(Date.parse(scenario.finishedAt) >= Date.parse(scenario.startedAt));
        assert.equal(scenario.runtimeVerified, true);
        assert.equal(scenario.pendingRemoved, true);
        assert.equal(scenario.previousRemoved, true);
    }
    const preservation = report.scenarios.slice(1, 7);
    for (const scenario of preservation) {
        assert.equal(scenario.configPreserved, true);
        assert.equal(scenario.userDataPreserved, true);
        assert.equal(scenario.configSHA256, preservation[0].configSHA256);
        assert.equal(scenario.userFileSHA256, preservation[0].userFileSHA256);
        assert.equal(scenario.files.length, 7);
        assert.equal(scenario.apiReadCheck, 'passed');
    }
    assert.equal(report.scenarios[7].transfer.unitCommandOrderingOnly, true);
    assert.equal(report.scenarios[8].transferColdReopen.unitCommandOrderingOnly, true);
    assert.equal(report.scenarios[9].configMigration.deprecatedKeysMigrated, 7);
    assert.equal(report.scenarios[9].configSHA256, report.scenarios[10].configSHA256);
    assert.equal(report.coverage.newManifestUpdate, false);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.equal(await exists(fixture.container), false);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
    assert.deepEqual(fixture.calls.filter(call => call.args[1] === 'delete').map(call => call.args[2]), [fixtureUDID]);
    assert.equal(await exists(path.join(fixture.dependencies.devicesRoot, templateUDID)), false);
});

test('controlled A-to-B upgrade and old-deployment recovery preserve real fixture files', async t => {
    const fixture = await fakeSimulator(t, { upgrade: true });
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'passed', report.error ?? report.cleanup.error);
    assert.equal(report.scenarios.length, 14);
    assert.deepEqual(report.scenarios.slice(9, 12).map(scenario => scenario.name), [
        'changed-manifest-upgrade', 'upgrade-interrupted-old-previous', 'upgrade-interrupted-missing-installed',
    ]);
    assert.equal(report.upgrade.classification, 'controlled-deployment-variant');
    assert.equal(report.upgrade.sameApplicationSource, true);
    assert.equal(report.coverage.differentSillyTavernVersions, false);
    assert.equal(report.initialBuild, '10190');
    assert.equal(report.finalBuild, '10191');
    assert.notEqual(report.upgrade.fromDeploymentId, report.upgrade.toDeploymentId);
    assert.equal(report.finalDeploymentId, report.upgrade.toDeploymentId);
    const baseline = report.scenarios[1];
    for (const scenario of report.scenarios.slice(9, 12)) {
        assert.equal(scenario.build, '10191');
        assert.equal(scenario.deploymentId, report.upgrade.toDeploymentId);
        assert.equal(scenario.configSHA256, baseline.configSHA256);
        assert.deepEqual(scenario.files, baseline.files);
        assert.equal(scenario.apiReadCheck, 'passed');
        assert.equal(scenario.transferAfterUpgrade.unitCommandOrderingOnly, true);
        assert.equal(scenario.syntheticSecretFixturesPreserved, true);
    }
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('an upgrade with the same build is rejected before creating a Simulator', async t => {
    const fixture = await fakeSimulator(t, { upgrade: true });
    const infoFile = path.join(fixture.options.upgradeApp, 'Info.plist');
    const info = JSON.parse(await fs.readFile(infoFile, 'utf8'));
    info.CFBundleVersion = '10190';
    await fs.writeFile(infoFile, JSON.stringify(info));
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /distinct build/);
    assert.equal(report.scenarios.length, 0);
    assert.equal(fixture.calls.some(call => call.args[1] === 'create'), false);
});

test('a backend read failure cannot be reported as successful data recovery', async t => {
    const fixture = await fakeSimulator(t);
    const factory = fixture.dependencies.apiClientFactory;
    fixture.dependencies.apiClientFactory = async () => {
        const client = await factory();
        return async (...args) => args[0] === '/api/worldinfo/get' ? { entries: {} } : client(...args);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.equal(report.scenarios[1].deploymentCheck, 'passed');
    assert.equal(report.scenarios[1].dataPreservationCheck, 'passed');
    assert.equal(report.scenarios[1].apiReadCheck, 'failed');
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('a failed import/backup/restore stage fails the run and still deletes only the owned Simulator', async t => {
    const fixture = await fakeSimulator(t, { transferFail: true });
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.equal(report.scenarios[7].name, 'api-import-export-backup-restore');
    assert.equal(report.scenarios[7].status, 'failed');
    assert.match(report.scenarios[7].error, /Generated transfer scenario failed/);
    assert.equal(report.scenarios[7].deploymentCheck, 'passed');
    assert.equal(report.scenarios[7].dataPreservationCheck, 'not-run');
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.equal(await exists(fixture.container), false);
});

function initialLaunchTimeout() {
    return Object.assign(new Error('Synthetic first launch timeout'), {
        timedOut: true, killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '',
    });
}

test('one pre-seed launch timeout reboots only the owned Simulator and repeats the full checks', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    let launchAttempts = 0;
    fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
        if (args[1] === 'launch' && ++launchAttempts === 1) {
            assert.equal(timeoutMs, 120000);
            throw initialLaunchTimeout();
        }
        return original(command, args, timeoutMs);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'passed', report.error ?? report.cleanup.error);
    assert.equal(report.scenarios.length, 11);
    assert.equal(launchAttempts, 12, 'one extra launch attempt precedes the usual 11 scenarios');
    assert.equal(report.initialLaunchRecovery.status, 'passed');
    assert.equal(report.initialLaunchRecovery.offlineVerified, true);
    assert.equal(report.initialLaunchRecovery.ownedBootedBeforeShutdown, true);
    assert.equal(report.initialLaunchRecovery.rebootedOwnedSimulator, true);
    assert.equal(report.initialLaunchRecovery.installedContainersVerified, true);
    assert.match(report.initialLaunchRecovery.originalError, /timed out after 120000 ms/);
    assert.deepEqual(report.initialLaunchRecovery.originalCommandError.arguments, ['simctl', 'launch', fixtureUDID, bundleID]);
    assert.equal(report.initialLaunchRecovery.originalCommandError.stdoutTail, '');
    assert.equal(report.initialLaunchRecovery.originalCommandError.stderrTail, '');
    assert.equal(fixture.calls.filter(call => call.args[1] === 'boot').length, 2);
    assert.equal(fixture.calls.filter(call => call.args[1] === 'bootstatus').length, 2);
    assert.equal(fixture.calls.filter(call => call.args[1] === 'list' && call.timeoutMs === 20000).length, 2);
    assert.equal(fixture.calls.filter(call => call.args[1] === 'get_app_container' && call.timeoutMs === 20000).length, 2);
    assert.equal(report.scenarios[0].runtimeVerified, true);
    assert.equal(report.scenarios[0].pendingRemoved, true);
    assert.equal(report.scenarios[0].previousRemoved, true);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
});

test('a second initial launch timeout fails without another reboot or retry', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    let launchAttempts = 0;
    fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
        if (args[1] === 'launch') {
            launchAttempts++;
            throw initialLaunchTimeout();
        }
        return original(command, args, timeoutMs);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.equal(launchAttempts, 2);
    assert.equal(report.scenarios.length, 0);
    assert.equal(report.initialLaunchRecovery.status, 'failed');
    assert.match(report.initialLaunchRecovery.originalError, /timed out after 120000 ms/);
    assert.match(report.initialLaunchRecovery.error, /timed out after 120000 ms/);
    assert.equal(fixture.calls.filter(call => call.args[1] === 'boot').length, 2);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('nonmatching initial launch diagnostics never trigger recovery', async t => {
    for (const mismatch of [
        { stdout: 'partial launch output' }, { stderr: 'diagnostic output' },
        { signal: 'SIGKILL' }, { code: 'ETIMEDOUT' }, { killed: false }, { timedOut: false },
    ]) {
        const fixture = await fakeSimulator(t);
        const original = fixture.dependencies.runCommand;
        let launchAttempts = 0;
        fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
            if (args[1] === 'launch') {
                launchAttempts++;
                throw Object.assign(initialLaunchTimeout(), mismatch);
            }
            return original(command, args, timeoutMs);
        };
        const report = await validateSimulatorData(fixture.options, fixture.dependencies);
        assert.equal(report.status, 'failed');
        assert.equal(report.scenarios.length, 0);
        assert.equal(report.initialLaunchRecovery, undefined);
        assert.equal(launchAttempts, 1);
        assert.equal(fixture.calls.filter(call => call.args[1] === 'boot').length, 1);
        assert.equal(report.cleanup.deletedOwnedSimulator, true);
    }
});

test('a responding or unverifiable listener prevents initial launch recovery', async t => {
    for (const mode of ['response', 'error']) {
        const fixture = await fakeSimulator(t);
        const originalRun = fixture.dependencies.runCommand;
        const originalProbe = fixture.dependencies.probe;
        let firstTimedOut = false;
        let checkedListener = false;
        fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
            if (args[1] === 'launch' && !firstTimedOut) {
                firstTimedOut = true;
                throw initialLaunchTimeout();
            }
            return originalRun(command, args, timeoutMs);
        };
        fixture.dependencies.probe = async () => {
            if (firstTimedOut && !checkedListener) {
                checkedListener = true;
                if (mode === 'error') throw new Error('Synthetic probe timeout');
                return { status: 200, body: { ready: true } };
            }
            return originalProbe();
        };
        const report = await validateSimulatorData(fixture.options, fixture.dependencies);
        assert.equal(report.status, 'failed');
        assert.equal(report.scenarios.length, 0);
        assert.match(report.error, /timed out after 120000 ms/);
        assert.equal(report.initialLaunchRecovery.status, 'failed');
        assert.match(report.initialLaunchRecovery.error, mode === 'error' ? /probe timeout/ : /listener/);
        assert.equal(report.initialLaunchRecovery.offlineVerified, undefined);
        assert.equal(fixture.calls.filter(call => call.args[1] === 'boot').length, 1);
        assert.equal(fixture.calls.filter(call => call.args[1] === 'bootstatus').length, 1);
        assert.equal(report.cleanup.deletedOwnedSimulator, true);
    }
});

test('initial launch recovery refuses an owned-Simulator identity change before reboot', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    let firstTimedOut = false;
    let tampered = false;
    fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
        if (args[1] === 'launch' && !firstTimedOut) {
            firstTimedOut = true;
            throw initialLaunchTimeout();
        }
        const result = await original(command, args, timeoutMs);
        if (firstTimedOut && !tampered && args[1] === 'list') {
            tampered = true;
            const listing = JSON.parse(result.stdout);
            listing.devices[runtime].find(device => device.udid === fixtureUDID).name = 'Another Simulator';
            return { stdout: JSON.stringify(listing) };
        }
        return result;
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /identity or Booted state changed/);
    assert.equal(report.initialLaunchRecovery.status, 'failed');
    assert.match(report.initialLaunchRecovery.originalError, /timed out after 120000 ms/);
    assert.equal(report.initialLaunchRecovery.ownedBootedBeforeShutdown, undefined);
    assert.equal(fixture.calls.filter(call => call.args[1] === 'boot').length, 1);
    assert.equal(report.scenarios.length, 0);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('initial launch recovery still requires a returned PID after reboot', async t => {
    const fixture = await fakeSimulator(t, { omitPID: true });
    const original = fixture.dependencies.runCommand;
    let firstTimedOut = false;
    fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
        if (args[1] === 'launch' && !firstTimedOut) {
            firstTimedOut = true;
            throw initialLaunchTimeout();
        }
        return original(command, args, timeoutMs);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /process PID/);
    assert.equal(report.initialLaunchRecovery.status, 'failed');
    assert.match(report.initialLaunchRecovery.originalError, /timed out after 120000 ms/);
    assert.equal(report.scenarios.length, 0);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('a seeded scenario launch timeout does not trigger initial-launch recovery', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    let launchAttempts = 0;
    fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
        if (args[1] === 'launch' && ++launchAttempts === 2) throw initialLaunchTimeout();
        return original(command, args, timeoutMs);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.equal(launchAttempts, 2);
    assert.equal(report.initialLaunchRecovery, undefined);
    assert.equal(report.scenarios[0].status, 'passed');
    assert.equal(report.scenarios[1].name, 'same-app-reinstall');
    assert.equal(report.scenarios[1].status, 'failed');
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('cancellation during the timed-out initial launch is never recovered', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    const cancellation = new AbortController();
    fixture.dependencies.signal = cancellation.signal;
    fixture.dependencies.runCommand = async (command, args, timeoutMs) => {
        if (args[1] === 'launch') {
            cancellation.abort(new Error('Synthetic initial launch cancellation'));
            throw initialLaunchTimeout();
        }
        return original(command, args, timeoutMs);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /initial launch cancellation/);
    assert.equal(report.initialLaunchRecovery, undefined);
    assert.equal(fixture.calls.filter(call => call.args[1] === 'boot').length, 1);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('first fixture boot and install have bounded cold-start budgets without extending reinstall', async t => {
    const fixture = await fakeSimulator(t);
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'passed', report.error ?? report.cleanup.error);
    const boot = fixture.calls.filter(call => call.args[1] === 'bootstatus');
    assert.equal(boot.length, 1);
    assert.deepEqual(boot[0].args, ['simctl', 'bootstatus', fixtureUDID, '-b']);
    assert.equal(boot[0].timeoutMs, 600000);
    const installs = fixture.calls.filter(call => call.args[1] === 'install');
    assert.ok(installs.length >= 2);
    assert.equal(installs[0].timeoutMs, 240000);
    for (const install of installs.slice(1)) assert.equal(install.timeoutMs, 120000);
    for (const call of fixture.calls.filter(call => !['bootstatus', 'install'].includes(call.args[1]))) {
        assert.ok([120000, 30000].includes(call.timeoutMs), 'cleanup commands use a shorter bound');
    }
    assert.equal(fixture.calls.find(call => call.args[1] === 'delete').timeoutMs, 30000);
});

test('a checkpoint exists before a blocked Simulator command and survives its failure', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    fixture.dependencies.runCommand = async (...args) => {
        if (args[1][1] === 'bootstatus') {
            const partial = JSON.parse(await fs.readFile(fixture.options.report, 'utf8'));
            assert.equal(partial.status, 'failed');
            assert.equal(partial.progress.phase, 'command-start');
            assert.equal(partial.progress.command, 'simctl bootstatus');
            assert.equal(partial.fixtureUDID, fixtureUDID);
            throw Object.assign(new Error('Synthetic blocked bootstatus'), { timedOut: true, killed: true });
        }
        return original(...args);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.equal(report.timedOut, true);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
});

test('a report write failure after Simulator creation still verifies and deletes the owned device', async t => {
    const fixture = await fakeSimulator(t);
    let injected = false;
    fixture.dependencies.writeReport = async (filename, report) => {
        if (!injected && report.progress.phase === 'command-passed' && report.progress.command === 'simctl create') {
            injected = true;
            throw new Error('Synthetic checkpoint disk failure');
        }
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, JSON.stringify(report, null, 2) + '\n');
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(injected, true);
    assert.equal(report.status, 'failed');
    assert.match(report.checkpointError, /Synthetic checkpoint disk failure/);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.equal(report.scenarios.length, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
    assert.equal(await exists(fixture.container), false);
});

test('cancellation just after Simulator creation still verifies identity before deleting it', async t => {
    const fixture = await fakeSimulator(t);
    const cancellation = new AbortController();
    const original = fixture.dependencies.runCommand;
    fixture.dependencies.signal = cancellation.signal;
    fixture.dependencies.runCommand = async (...args) => {
        const result = await original(...args);
        if (args[1][1] === 'create') cancellation.abort(new Error('Synthetic post-create cancellation'));
        return result;
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /Synthetic post-create cancellation/);
    assert.equal(report.fixtureUDID, fixtureUDID);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.ok(fixture.calls.some(call => call.args[1] === 'list' && call.timeoutMs === 20000),
        'candidate identity lookup remains bounded after cancellation');
    assert.equal(await exists(fixture.container), false);
});

test('cancellation retains the report and deletes the verified owned Simulator', async t => {
    const fixture = await fakeSimulator(t);
    const cancellation = new AbortController();
    const original = fixture.dependencies.runCommand;
    fixture.dependencies.signal = cancellation.signal;
    fixture.dependencies.runCommand = async (...args) => {
        if (args[1][1] === 'bootstatus') cancellation.abort(new Error('Synthetic cancellation'));
        return original(...args);
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /Synthetic cancellation/);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
});

test('cleanup continues to owned shutdown and deletion after termination verification fails', async t => {
    const fixture = await fakeSimulator(t);
    const original = fixture.dependencies.runCommand;
    fixture.dependencies.runCommand = async (...args) => {
        const result = await original(...args);
        if (args[1][1] === 'terminate' && args[1][2] === fixtureUDID) {
            throw new Error('Synthetic termination verification failure');
        }
        return result;
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.match(report.cleanup.error, /termination verification failure/);
    assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
    assert.equal(await exists(fixture.container), false);
});

test('command timeout kills a process that ignores SIGTERM within a hard bound', async () => {
    const startedAt = Date.now();
    await assert.rejects(defaultRunCommand(process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], 100), error => {
        assert.equal(error.timedOut, true);
        assert.equal(error.killed, true);
        return true;
    });
    assert.ok(Date.now() - startedAt < 4000);
});

test('boot timeout fails before scenarios, retains bounded command diagnostics and cleans up', async t => {
    for (const timedOut of [true, false]) {
        const stdout = `omitted stdout prefix${'o'.repeat(5000)}bootstatus stdout end`;
        const stderr = `omitted stderr prefix${'e'.repeat(5000)}bootstatus stderr end`;
        const bootstatusError = Object.assign(new Error('Command failed: xcrun simctl bootstatus'), {
            timedOut, stdout, stderr, signal: 'SIGTERM', killed: true, code: null,
        });
        const fixture = await fakeSimulator(t, { bootstatusError });
        const report = await validateSimulatorData(fixture.options, fixture.dependencies);
        assert.equal(report.status, 'failed');
        assert.equal(report.scenarios.length, 0);
        assert.equal(fixture.launches.length, 0);
        assert.equal(report.cleanup.deletedOwnedSimulator, true);
        assert.deepEqual(report.commandError, { command: 'xcrun', arguments: ['simctl', 'bootstatus', fixtureUDID, '-b'],
            timeoutMs: 600000, timedOut, exitCode: null, errorCode: null, signal: 'SIGTERM', killed: true,
            stdoutTail: stdout.slice(-4096), stderrTail: stderr.slice(-4096) });
        if (timedOut) assert.match(report.error, /timed out after 600000 ms/);
        else assert.match(report.error, /^Command failed:/, 'SIGTERM without our timeout marker is not classified as timeout');
        assert.deepEqual(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')), report);
        assert.deepEqual(fixture.calls.filter(call => call.args[1] === 'delete').map(call => call.args[2]), [fixtureUDID]);
    }
});

test('CI already-terminated stderr is accepted while PID and offline checks still run', async t => {
    const fixture = await fakeSimulator(t, { templateAlreadyTerminated: true, fixtureAlreadyTerminated: true });
    const { runCommand, processAlive, probe } = fixture.dependencies;
    const checks = [];
    let termination;
    fixture.dependencies.runCommand = async (command, args, timeout) => {
        if (args[1] === 'launch') termination = undefined;
        try { return await runCommand(command, args, timeout); }
        finally {
            if (args[1] === 'terminate') {
                termination = { udid: args[2], processChecks: 0, offlineChecks: 0 };
                checks.push(termination);
            }
        }
    };
    fixture.dependencies.processAlive = value => {
        if (termination) termination.processChecks++;
        return processAlive(value);
    };
    fixture.dependencies.probe = async () => {
        if (termination) termination.offlineChecks++;
        return probe();
    };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'passed', report.error ?? report.cleanup.error);
    assert.equal(report.scenarios.length, 11);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.equal(checks[0].udid, templateUDID);
    assert.ok(checks[0].offlineChecks > 0);
    const fixtureChecks = checks.filter(check => check.udid === fixtureUDID);
    assert.equal(fixtureChecks.length, 11);
    for (const check of fixtureChecks) {
        assert.ok(check.processChecks > 0, 'accepted stderr must not skip PID exit verification');
        assert.ok(check.offlineChecks > 0, 'accepted stderr must not skip listener verification');
    }
});

test('already-terminated stderr does not bypass an unsuccessful offline probe', async t => {
    const fixture = await fakeSimulator(t, { templateAlreadyTerminated: true });
    fixture.dependencies.probe = async () => { throw new Error('Listener exit could not be verified'); };
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /Listener exit could not be verified/);
    assert.equal(fixture.calls.some(call => call.args[1] === 'create'), false);
    assert.equal(report.scenarios.length, 0);
    assert.equal(report.cleanup.deletedOwnedSimulator, false);
});

test('wrong deployment health fails and still terminates/deletes the owned Simulator', async t => {
    const fixture = await fakeSimulator(t, { wrongHealth: true });
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /different deployment/);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.equal(report.scenarios.length, 0);
    assert.equal(JSON.parse(await fs.readFile(fixture.options.report, 'utf8')).status, 'failed');
});

test('launch without PID still cleans up an app that may have started', async t => {
    const fixture = await fakeSimulator(t, { omitPID: true });
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /process PID/);
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
    assert.ok(fixture.calls.some(call => call.args[1] === 'terminate' && call.args[2] === fixtureUDID));
});

test('a reinstall that loses config is reported as failure instead of fake success', async t => {
    const fixture = await fakeSimulator(t, { loseConfigOnReinstall: true });
    const report = await validateSimulatorData(fixture.options, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /config bytes changed/);
    assert.equal(report.scenarios[1].name, 'same-app-reinstall');
    assert.equal(report.scenarios[1].status, 'failed');
    assert.equal(report.scenarios[1].deploymentCheck, 'passed');
    assert.equal(report.scenarios[1].runtimeVerified, true);
    assert.equal(report.scenarios[1].dataPreservationCheck, 'failed');
    assert.equal(report.cleanup.deletedOwnedSimulator, true);
});

test('unsafe report destinations are rejected before any command and never written in finally', async t => {
    const fixture = await fakeSimulator(t);
    for (const reportPath of [path.join(fixture.app, 'result.json'), path.join(fixture.dependencies.devicesRoot, 'result.json')]) {
        const report = await validateSimulatorData({ ...fixture.options, report: reportPath }, fixture.dependencies);
        assert.equal(report.status, 'failed');
        assert.match(report.error, /Report must be outside/);
        assert.equal(await exists(reportPath), false);
        assert.equal(fixture.calls.length, 0);
    }
    const alias = path.join(fixture.directory, 'app-alias');
    await fs.symlink(fixture.app, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const reportPath = path.join(alias, 'result.json');
    const report = await validateSimulatorData({ ...fixture.options, report: reportPath }, fixture.dependencies);
    assert.equal(report.status, 'failed');
    assert.match(report.error, /Report must be outside/);
    assert.equal(await exists(reportPath), false);
    assert.equal(fixture.calls.length, 0);
});
