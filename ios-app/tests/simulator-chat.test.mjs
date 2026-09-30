import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatContract, validateChatContract, fixtureProviderURL, requestChatFixtureHTTP, createChatMockProvider, chatFixtureSettings, seedChatFixture, verifyChatTranscript, verifyChatProvider } from '../scripts/simulator-chat-fixture.mjs';
import { parseChatArguments, chatProfilesPassed, configureChatXctestrun, checkChatContainer, chatAttachmentFromManifest, readActualChat, verifyChatUIEvidence, validateSimulatorChat, cleanupOwnedChatSimulator, launchInitiallyWithRecovery } from '../scripts/validate-simulator-chat.mjs';
import { uiProfiles, selectRequestedProfiles } from '../scripts/validate-simulator-ui.mjs';
import { requestHTTP, parseSSE } from '../scripts/validate-api.mjs';

const fixtureId = '11111111-2222-3333-4444-555555555555';
const contract = createChatContract(fixtureId);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function transcript() {
    const assistant = mes => ({ is_user: false, mes, extra: { model: contract.model }, swipe_id: 0, swipes: [mes],
        gen_started: '2026-09-29T00:00:00.000Z', gen_finished: '2026-09-29T00:00:02.000Z' });
    return [{ user_name: 'unused', character_name: 'unused', chat_metadata: { integrity: fixtureId } },
        { is_user: false, mes: contract.greeting }, { is_user: true, mes: contract.firstPrompt }, assistant(contract.firstResponse),
        { is_user: true, mes: contract.cancelPrompt }, assistant(contract.cancelPrefix)];
}

test('chat contracts reject traversal, cross-fixture text and credentials before reaching XCTest', () => {
    assert.equal(validateChatContract(contract), contract);
    assert.throws(() => createChatContract('../real-user'), /UUID/);
    assert.throws(() => validateChatContract({ ...contract, avatar: '../victim.png' }), /avatar/);
    assert.throws(() => validateChatContract({ ...contract, firstResponse: 'Pretend success' }), /firstResponse/);
    assert.throws(() => validateChatContract({ ...contract, credential: 'generated-fixture-secret' }), /credentials/);
    assert.throws(() => validateChatContract({ ...contract, initialChatName: '../chat' }), /Unsafe/);
});

test('provider configuration is limited to an independent loopback HTTP /v1 origin', () => {
    assert.equal(fixtureProviderURL('http://127.0.0.1:54321/v1'), 'http://127.0.0.1:54321/v1');
    for (const url of ['https://api.openai.com/v1', 'http://localhost:54321/v1', 'http://127.0.0.1:8000/v1',
        'http://user:pass@127.0.0.1:54321/v1', 'http://127.0.0.1:54321/v1?external=true', 'http://127.0.0.1:54321/other']) assert.throws(() => fixtureProviderURL(url), /loopback/);
});

test('fixture settings reader handles real-size preset responses above128KiB and refuses unbounded data', { timeout: 5000 }, async context => {
    const payload = JSON.stringify({ settings: JSON.stringify({ firstRun: true }), openai_settings: ['한글🙂' + 'x'.repeat(150000)] });
    const sockets = new Set();
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (request.url === '/api/settings/get') response.end(payload);
        else if (request.url === '/api/settings/save') response.end('x'.repeat(4 * 1024 * 1024 + 1));
        else if (request.url === '/api/characters/get') return;
        else response.end('{}');
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await requestChatFixtureHTTP(base + '/api/settings/get', { body: '{}' });
    assert.ok(response.bytes > 131072); assert.equal(response.text, payload);
    assert.equal(JSON.parse(JSON.parse(response.text).settings).firstRun, true);
    await assert.rejects(requestChatFixtureHTTP(base + '/api/settings/save', { body: '{}' }), error => error.code === 'ST_CHAT_RESPONSE_LIMIT');
    await assert.rejects(requestChatFixtureHTTP(base + '/api/characters/get', { body: '{}', timeoutMs: 100 }), error => error.code === 'ST_CHAT_CLIENT_TIMEOUT');
    assert.throws(() => requestChatFixtureHTTP('https://api.openai.com/v1/models'), /loopback/);
    assert.throws(() => requestChatFixtureHTTP(base + '/api/chats/save', { body: '{}' }), /allowlisted/);
});

test('real API seeding preserves onboarding and sends no generation or saved chat requests', async () => {
    const baseline = { firstRun: true, unrelated: { kept: 'yes' }, main_api: 'kobold', oai_settings: { temp_openai: 0.8,
        custom_include_headers: 'X-External: old', custom_url: 'https://example.invalid/v1' }, power_user: { preserved: 7, auto_connect: true } };
    const original = structuredClone(baseline), requests = [];
    const provider = { baseURL: 'http://127.0.0.1:54321/v1', credential: 'generated-fixture-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const client = async (route, body) => {
        requests.push({ route, body });
        if (route === '/api/settings/get') return { settings: JSON.stringify(baseline) };
        if (route === '/api/settings/save') return { result: 'ok' };
        if (route === '/api/secrets/write') return { id: fixtureId };
        if (route === '/api/characters/create') return contract.avatar;
        if (route === '/api/characters/get') return { name: contract.characterName, first_mes: contract.greeting, chat: 'Server chosen initial chat' };
        throw new Error('Unexpected fixture route');
    };
    const seeded = await seedChatFixture(client, provider, contract);
    assert.equal(seeded.initialChatName, 'Server chosen initial chat');
    assert.deepEqual(requests.map(item => item.route), ['/api/settings/get', '/api/settings/save', '/api/secrets/write', '/api/characters/create', '/api/characters/get']);
    const saved = requests[1].body;
    assert.equal(saved.firstRun, true); assert.equal(saved.main_api, 'openai');
    assert.equal(saved.oai_settings.chat_completion_source, 'custom'); assert.equal(saved.oai_settings.stream_openai, true);
    assert.equal(saved.oai_settings.custom_include_headers, ''); assert.equal(saved.oai_settings.custom_prompt_post_processing, '');
    assert.equal(saved.power_user.auto_connect, false); assert.equal(saved.power_user.auto_load_chat, true);
    assert.deepEqual(saved.unrelated, baseline.unrelated); assert.deepEqual(baseline, original);
    assert.ok(!JSON.stringify(seeded).includes(provider.credential));
    assert.throws(() => chatFixtureSettings({ ...baseline, firstRun: false }, provider.baseURL, contract), /onboarding/);
});

test('chat xctestrun config preserves other targets and injects only generated non-secret fixture data', () => {
    const source = { TestConfigurations: [{ TestTargets: [{ BlueprintName: 'AppUITests', IsUITestBundle: true,
        TestBundlePath: '__TESTROOT__/AppUITests-Runner.app/PlugIns/AppUITests.xctest', UITargetAppPath: '__TESTROOT__/App.app',
        UITargetAppBundleIdentifier: 'com.sillytavern.ios', EnvironmentVariables: { EXISTING: 'kept' } },
    { BlueprintName: 'Other', IsUITestBundle: false, EnvironmentVariables: { EXISTING: 'untouched' } }] }] };
    const original = structuredClone(source), products = path.resolve('Products');
    const configured = configureChatXctestrun(source, uiProfiles[2], products, contract);
    const [target, other] = configured.TestConfigurations[0].TestTargets;
    assert.equal(target.EnvironmentVariables.ST_UI_PROFILE, 'iphone-ko');
    assert.equal(target.EnvironmentVariables.ST_UI_LANGUAGE, 'ko-kr');
    assert.deepEqual(JSON.parse(target.EnvironmentVariables.ST_CHAT_FIXTURE_JSON), contract);
    assert.equal(target.EnvironmentVariables.EXISTING, 'kept'); assert.deepEqual(other, original.TestConfigurations[0].TestTargets[1]);
    assert.deepEqual(source, original);
    assert.throws(() => configureChatXctestrun({ TestConfigurations: [] }, uiProfiles[0], products, contract), /AppUITests/);
});

test('chat CLI refuses ambiguous/shared destinations and the validator refuses non-macOS execution', async () => {
    const args = ['--template-udid', fixtureId, '--app', path.resolve('App.app'), '--xctestrun', path.resolve('App.xctestrun'), '--output-root', path.resolve('new-chat-results')];
    assert.equal(parseChatArguments(args).udid, fixtureId);
    assert.equal(parseChatArguments([...args, '--profile', 'ipad-en']).profile, 'ipad-en');
    assert.throws(() => parseChatArguments([...args, '--profile', 'unknown']), /Unknown UI profile/);
    assert.throws(() => parseChatArguments(args.map(value => value === fixtureId ? 'booted' : value)), /explicit/);
    assert.throws(() => parseChatArguments([...args, '--base-url', 'https://api.openai.com']), /Invalid/);
    if (process.platform !== 'darwin') await assert.rejects(validateSimulatorChat(parseChatArguments(args)), /macOS/);
});

test('chat profile result accepts only the requested profiles in order with complete cleanup', () => {
    const result = profile => ({ profile: profile.name, status: 'passed', cleanup: { providerClosed: true, deletedOwnedSimulator: true } });
    const all = uiProfiles.map(result);
    assert.equal(chatProfilesPassed(all, selectRequestedProfiles()), true);
    assert.equal(chatProfilesPassed([all[1]], selectRequestedProfiles('ipad-en')), true);
    assert.equal(chatProfilesPassed([all[0]], selectRequestedProfiles('ipad-en')), false);
    assert.equal(chatProfilesPassed([all[1], all[0], all[2]], selectRequestedProfiles()), false);
    assert.equal(chatProfilesPassed(all, selectRequestedProfiles('ipad-en')), false);
    assert.equal(chatProfilesPassed([{ ...all[1], cleanup: { ...all[1].cleanup, providerClosed: false } }], selectRequestedProfiles('ipad-en')), false);
});

test('owned Simulator cleanup attempts shutdown and deletion after terminate hangs, but refuses another device', async () => {
    const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
    const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
    const fixtureName = 'SillyTavern-native-chat-test';
    const input = { fixtureUDID: fixtureId, fixtureName, runtimeIdentifier, deviceTypeIdentifier,
        installed: true, launched: true, bundleID: 'com.sillytavern.ios' };
    const listing = name => JSON.stringify({ devices: { [runtimeIdentifier]: [{ udid: fixtureId, name, state: 'Booted',
        isAvailable: true, deviceTypeIdentifier }] } });
    const calls = [];
    const command = async (args, timeoutMs) => {
        calls.push({ args, timeoutMs });
        if (args[0] === 'list') return { stdout: listing(fixtureName) };
        if (args[0] === 'terminate') throw new Error('simctl terminate timed out');
        return { stdout: '' };
    };
    const cleanup = await cleanupOwnedChatSimulator(input, command);
    assert.equal(cleanup.deletedOwnedSimulator, true);
    assert.match(cleanup.terminationError.message, /timed out/);
    assert.deepEqual(calls.map(item => item.args[0]), ['list', 'terminate', 'shutdown', 'delete']);
    assert.deepEqual(calls.map(item => item.timeoutMs), [20000, 20000, 30000, 30000]);

    calls.length = 0;
    const afterFailedLaunch = await cleanupOwnedChatSimulator({ ...input, launched: false }, command);
    assert.equal(afterFailedLaunch.deletedOwnedSimulator, true);
    assert.deepEqual(calls.map(item => item.args[0]), ['list', 'shutdown', 'delete']);

    calls.length = 0;
    const borrowed = await cleanupOwnedChatSimulator(input, async args => {
        calls.push(args[0]);
        return { stdout: listing('Another user Simulator') };
    });
    assert.equal(borrowed.deletedOwnedSimulator, false);
    assert.match(borrowed.simulatorError.message, /identity changed/);
    assert.deepEqual(calls, ['list']);
});

test('initial launch timeout continues on matching native health without rebooting or bypassing later readiness checks', async () => {
    const fixtureUDID = fixtureId, fixtureName = 'SillyTavern-native-chat-test';
    const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-26-2';
    const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5';
    const bundleID = 'com.sillytavern.ios';
    const manifest = { applicationVersion: '1.19.0', deploymentId: 'expected-deployment' };
    const result = {}, phases = [], calls = [];
    const timeout = new Error('Command timed out');
    timeout.commandDetails = { command: 'xcrun', arguments: ['simctl', 'launch', fixtureUDID, bundleID],
        exitCode: null, signal: 'SIGKILL', killed: true, timeoutMs: 120000, stdoutTail: '', stderrTail: '' };
    const listing = JSON.stringify({ devices: { [runtimeIdentifier]: [{ udid: fixtureUDID, name: fixtureName, state: 'Booted',
        isAvailable: true, deviceTypeIdentifier }] } });
    const context = { fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier, bundleID, manifest, result,
        phase: async name => { phases.push(name); }, verifyInstalled: async () => { throw new Error('No reboot was needed'); } };
    const command = async (args, timeoutMs) => {
        calls.push({ args, timeoutMs });
        if (args[0] === 'launch') throw timeout;
        if (args[0] === 'list') return { stdout: listing };
        throw new Error(`Unexpected simctl ${args[0]}`);
    };
    await launchInitiallyWithRecovery(context, { command, probeHealth: async () => ({ status: 503,
        text: JSON.stringify({ version: manifest.applicationVersion, deploymentId: manifest.deploymentId, ready: false }) }),
    requireOffline: async () => { throw new Error('No reboot was needed'); } });
    assert.deepEqual(calls.map(item => item.args[0]), ['launch', 'list']);
    assert.equal(result.initialLaunchRecovery.status, 'matching-health-observed');
    assert.equal(result.initialLaunchRecovery.healthProbe.ready, false);
    assert.equal(result.initialLaunchRecovery.healthProbe.httpStatus, 503);
    assert.deepEqual(phases, ['initial-launch-health-probe', 'initial-launch-health-observed']);
});

test('initial launch recovery refuses ordinary command errors, outputful timeouts and unhealthy responses', async () => {
    const fixtureUDID = fixtureId, bundleID = 'com.sillytavern.ios';
    const manifest = { applicationVersion: '1.19.0', deploymentId: 'expected-deployment' };
    const createTimeout = changes => {
        const error = new Error('Command timed out');
        error.commandDetails = { command: 'xcrun', arguments: ['simctl', 'launch', fixtureUDID, bundleID],
            exitCode: null, signal: 'SIGKILL', killed: true, timeoutMs: 120000, stdoutTail: '', stderrTail: '', ...changes };
        return error;
    };
    const context = result => ({ fixtureUDID, fixtureName: 'SillyTavern-native-chat-test',
        runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', bundleID, manifest,
        result, phase: async () => {}, verifyInstalled: async () => { throw new Error('No reboot allowed'); } });
    for (const error of [new Error('simctl failed'), createTimeout({ signal: null, killed: false, exitCode: 1 }),
        createTimeout({ stderrTail: 'explicit app startup failure' }), createTimeout({ timeoutMs: 12000 })]) {
        const result = {}; let count = 0;
        await assert.rejects(launchInitiallyWithRecovery(context(result), { command: async () => { count++; throw error; },
            probeHealth: async () => { throw new Error('Should not probe'); } }), rejected => rejected === error);
        assert.equal(count, 1); assert.equal(result.initialLaunchRecovery, undefined);
    }
    for (const response of [{ status: 200, health: { version: manifest.applicationVersion, deploymentId: 'wrong', ready: true } },
        { status: 503, health: { version: manifest.applicationVersion, deploymentId: manifest.deploymentId, ready: false,
            error: 'Server initialization failed.' } }]) {
        const result = {}, calls = [];
        await assert.rejects(launchInitiallyWithRecovery(context(result), {
            command: async args => { calls.push(args[0]); throw createTimeout(); },
            probeHealth: async () => ({ status: response.status, text: JSON.stringify(response.health) }),
        }), /different runtime deployment|startup failure/);
        assert.deepEqual(calls, ['launch']);
        assert.equal(result.initialLaunchRecovery.status, 'failed');
        assert.equal(result.initialLaunchRecovery.firstAttempt.command.signal, 'SIGKILL');
    }
});

test('initial launch recovery reboots only the owned Simulator once and records retry success or timeout', async () => {
    const fixtureUDID = fixtureId, fixtureName = 'SillyTavern-native-chat-test';
    const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-26-2';
    const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5';
    const bundleID = 'com.sillytavern.ios';
    const manifest = { applicationVersion: '1.19.0', deploymentId: 'expected-deployment' };
    const timeout = new Error('Command timed out');
    timeout.commandDetails = { command: 'xcrun', arguments: ['simctl', 'launch', fixtureUDID, bundleID],
        exitCode: null, signal: 'SIGKILL', killed: true, timeoutMs: 120000, stdoutTail: '', stderrTail: '' };
    for (const retryTimesOut of [false, true]) {
        const result = {}, phases = [], calls = [], verification = [], offline = [];
        const context = { fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier, bundleID, manifest, result,
            phase: async name => { phases.push(name); }, verifyInstalled: async timeoutMs => { verification.push(timeoutMs); return '/owned/container'; } };
        let state = 'Booted', launches = 0;
        const command = async (args, timeoutMs) => {
            calls.push({ args, timeoutMs });
            if (args[0] === 'launch' && (++launches === 1 || retryTimesOut)) throw timeout;
            if (args[0] === 'list') return { stdout: JSON.stringify({ devices: { [runtimeIdentifier]: [{ udid: fixtureUDID,
                name: fixtureName, state, isAvailable: true, deviceTypeIdentifier }] } }) };
            if (args[0] === 'shutdown') state = 'Shutdown';
            if (args[0] === 'boot') state = 'Booted';
            return { stdout: '' };
        };
        const runRecovery = () => launchInitiallyWithRecovery(context, { command,
            probeHealth: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); },
            requireOffline: async () => { offline.push(true); } });
        if (retryTimesOut) await assert.rejects(runRecovery(), rejected => rejected === timeout);
        else await runRecovery();
        assert.equal(launches, 2); assert.deepEqual(verification, [20000]); assert.equal(offline.length, 2);
        assert.deepEqual(calls.map(item => [item.args[0], item.timeoutMs]), [
            ['launch', 120000], ['list', 20000], ['shutdown', 30000], ['boot', 120000],
            ['bootstatus', 300000], ['list', 20000], ['launch', 120000],
        ]);
        assert.equal(result.initialLaunchRecovery.status, retryTimesOut ? 'failed' : 'retry-command-completed');
        assert.equal(result.initialLaunchRecovery.trigger, 'simulator-command-timeout');
        assert.equal(result.initialLaunchRecovery.firstAttempt.command.signal, 'SIGKILL');
        assert.equal(result.initialLaunchRecovery.retryError?.command.signal, retryTimesOut ? 'SIGKILL' : undefined);
        assert.ok(phases.includes('initial-launch-reboot-owned'));
        assert.ok(phases.includes(retryTimesOut ? 'initial-launch-recovery-failed' : 'initial-launch-retry-returned'));
    }
});

test('initial launch recovery refuses a changed or borrowed Simulator before shutdown', async () => {
    const fixtureUDID = fixtureId, fixtureName = 'SillyTavern-native-chat-test';
    const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-26-2';
    const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5';
    const bundleID = 'com.sillytavern.ios';
    const timeout = new Error('Command timed out');
    timeout.commandDetails = { command: 'xcrun', arguments: ['simctl', 'launch', fixtureUDID, bundleID],
        exitCode: null, signal: 'SIGKILL', killed: true, timeoutMs: 120000, stdoutTail: '', stderrTail: '' };
    const calls = [], result = {};
    await assert.rejects(launchInitiallyWithRecovery({ fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier,
        bundleID, manifest: { applicationVersion: '1.19.0', deploymentId: 'expected-deployment' }, result,
        phase: async () => {}, verifyInstalled: async () => { throw new Error('No reboot allowed'); } }, {
        command: async args => {
            calls.push(args[0]);
            if (args[0] === 'launch') throw timeout;
            if (args[0] === 'list') return { stdout: JSON.stringify({ devices: { [runtimeIdentifier]: [{ udid: fixtureUDID,
                name: 'Borrowed Simulator', state: 'Booted', isAvailable: true, deviceTypeIdentifier }] } }) };
            throw new Error('Borrowed Simulator was modified');
        },
        probeHealth: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); },
        requireOffline: async () => { throw new Error('Ownership must be checked first'); },
    }), /identity\/state changed/);
    assert.deepEqual(calls, ['launch', 'list']);
    assert.equal(result.initialLaunchRecovery.status, 'failed');
});

test('initial launch recovery refuses an occupied port or missing installed app instead of retrying', async () => {
    const fixtureUDID = fixtureId, fixtureName = 'SillyTavern-native-chat-test';
    const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-26-2';
    const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
    const bundleID = 'com.sillytavern.ios';
    const timeout = new Error('Command timed out');
    timeout.commandDetails = { command: 'xcrun', arguments: ['simctl', 'launch', fixtureUDID, bundleID],
        exitCode: null, signal: 'SIGKILL', killed: true, timeoutMs: 120000, stdoutTail: '', stderrTail: '' };
    const context = result => ({ fixtureUDID, fixtureName, runtimeIdentifier, deviceTypeIdentifier,
        bundleID, manifest: { applicationVersion: '1.19.0', deploymentId: 'expected-deployment' }, result,
        phase: async () => {}, verifyInstalled: async () => null });
    for (const occupied of [true, false]) {
        const calls = [], result = {};
        let state = 'Booted';
        await assert.rejects(launchInitiallyWithRecovery(context(result), {
            command: async args => {
                calls.push(args[0]);
                if (args[0] === 'launch') throw timeout;
                if (args[0] === 'list') return { stdout: JSON.stringify({ devices: { [runtimeIdentifier]: [{ udid: fixtureUDID,
                    name: fixtureName, state, isAvailable: true, deviceTypeIdentifier }] } }) };
                if (args[0] === 'shutdown') state = 'Shutdown';
                if (args[0] === 'boot') state = 'Booted';
                return { stdout: '' };
            },
            probeHealth: async () => { throw Object.assign(new Error('timed out'), { code: 'ST_CLIENT_TIMEOUT' }); },
            requireOffline: async () => { if (occupied) throw new Error('Port 8000 is still occupied'); },
        }), /Port 8000 is still occupied|installed app container/);
        assert.equal(calls.filter(name => name === 'launch').length, 1);
        assert.equal(calls.filter(name => name === 'shutdown').length, occupied ? 0 : 1);
        assert.equal(result.initialLaunchRecovery.status, 'failed');
    }
});

test('owned container guard rejects a borrowed Simulator, outside path and symlink escape', async context => {
    const temporaryRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
    await fs.mkdir(temporaryRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(temporaryRoot, 'chat-container-'));
    context.after(async () => {
        const resolved = await fs.realpath(fixture), base = await fs.realpath(temporaryRoot);
        assert.equal(path.dirname(resolved), base); assert.ok(path.basename(resolved).startsWith('chat-container-'));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const devices = path.join(fixture, 'Devices');
    const container = path.join(devices, fixtureId, 'data', 'Containers', 'Data', 'Application', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await fs.mkdir(container, { recursive: true });
    assert.equal(await checkChatContainer(container, fixtureId, devices), await fs.realpath(container));
    const borrowed = '99999999-2222-3333-4444-555555555555';
    await fs.mkdir(path.join(devices, borrowed));
    await assert.rejects(checkChatContainer(container, borrowed, devices), /outside/);
    await assert.rejects(checkChatContainer(path.dirname(container), fixtureId, devices), /outside/);
    const outside = path.join(fixture, 'outside'); await fs.mkdir(outside);
    const alias = path.join(path.dirname(container), 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee');
    await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkChatContainer(alias, fixtureId, devices), /outside/);
    const linkedDevice = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
    await fs.symlink(path.join(devices, fixtureId), path.join(devices, linkedDevice), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkChatContainer(container, linkedDevice, devices), /ordinary|outside/);
});

test('XCResult chat evidence must belong to the selected test and owned device with one safe attachment', () => {
    const attachment = { deviceId: fixtureId, suggestedHumanReadableName: 'chat-observations.json_0_suffix.json', exportedFileName: 'actual.json' };
    const selected = { testIdentifier: 'SillyTavernUITests/testChatGenerationSaveAndColdRelaunch()', attachments: [attachment] };
    const other = { testIdentifier: 'SillyTavernUITests/testOnboardingSliderKeyboardLifecycleAndPersistence()', attachments: [{ ...attachment, exportedFileName: 'unrelated.json' }] };
    assert.equal(chatAttachmentFromManifest([other, selected], fixtureId), 'actual.json');
    assert.throws(() => chatAttachmentFromManifest([other], fixtureId), /Exactly one/);
    assert.throws(() => chatAttachmentFromManifest([{ ...selected, attachments: [attachment, attachment] }], fixtureId), /Exactly one/);
    assert.throws(() => chatAttachmentFromManifest([{ ...selected, attachments: [{ ...attachment, exportedFileName: '../victim.json' }] }], fixtureId), /Unsafe/);
    assert.throws(() => chatAttachmentFromManifest([selected], '99999999-2222-3333-4444-555555555555'), /Exactly one/);
});

test('failed UTF8/JSON parsing preserves bounded original JSONL bytes before owned cleanup', async context => {
    const temporaryRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
    await fs.mkdir(temporaryRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(temporaryRoot, 'chat-failure-bytes-'));
    context.after(async () => {
        const resolved = await fs.realpath(fixture), base = await fs.realpath(temporaryRoot);
        assert.equal(path.dirname(resolved), base); assert.ok(path.basename(resolved).startsWith('chat-failure-bytes-'));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const container = path.join(fixture, 'container');
    const chatDirectory = path.join(container, 'Documents', 'SillyTavern', 'default-user', 'chats', contract.avatar.slice(0, -4));
    await fs.mkdir(chatDirectory, { recursive: true });
    const original = path.join(chatDirectory, 'actual.jsonl'), preserved = path.join(fixture, 'failure-chat.jsonl');
    for (const bytes of [Buffer.from([0xf0, 0x28, 0x8c, 0xbc]), Buffer.from('{"broken":')]) {
        await fs.writeFile(original, bytes);
        await assert.rejects(readActualChat(container, contract, preserved));
        assert.deepEqual(await fs.readFile(original), bytes); assert.deepEqual(await fs.readFile(preserved), bytes);
    }
    const previousEvidence = await fs.readFile(preserved);
    await fs.writeFile(original, Buffer.alloc(1024 * 1024 + 1));
    await assert.rejects(readActualChat(container, contract, preserved), /bounded/);
    assert.deepEqual(await fs.readFile(preserved), previousEvidence, 'Unbounded files must not overwrite preserved evidence');
});

test('saved chat checks require real full/partial exchange order, Unicode, model and swipe metadata', () => {
    const rows = transcript();
    assert.equal(verifyChatTranscript(rows, contract).generatedAssistantMessages, 2);
    for (const mutate of [data => data.pop(), data => { data[3].mes = '안녕하세요 � café.'; },
        data => { data[5].mes += contract.forbiddenSuffix; }, data => { data[5].is_user = true; },
        data => { data[5].extra.model = 'unrelated-model'; }, data => { data[3].swipes[0] = 'Different reply'; },
        data => { data[3].gen_finished = 'pretend'; }, data => { data[0].chat_metadata.integrity = '../fake'; }]) {
        const changed = structuredClone(rows); mutate(changed); assert.throws(() => verifyChatTranscript(changed, contract));
    }
});

test('native UI evidence cannot pass with a copied fixture from another run or missing actual stream/stop/restore observations', () => {
    const actual = { schemaVersion: 1, fixtureId, characterName: contract.characterName, firstPrompt: contract.firstPrompt,
        firstResponse: contract.firstResponse, cancelPrompt: contract.cancelPrompt, cancelResponse: contract.cancelPrefix,
        coldRelaunchRestored: true, streamObserved: true, stopTapped: true, chatIntegrity: fixtureId,
        firstStreamText: contract.firstPrefix.trim(), savedChatName: 'Actual server chat name', stopTappedAt: Date.now() - 1000, beforeColdRelaunchAt: Date.now() };
    assert.equal(verifyChatUIEvidence(actual, contract).actualSend, true);
    for (const [key, value] of [['fixtureId', 'different'], ['coldRelaunchRestored', false], ['streamObserved', false],
        ['stopTapped', false], ['cancelResponse', 'Pretend finished'], ['firstStreamText', contract.firstResponse],
        ['savedChatName', '../outside'], ['stopTappedAt', undefined], ['beforeColdRelaunchAt', undefined]]) assert.throws(() => verifyChatUIEvidence({ ...actual, [key]: value }, contract));
});

test('generated first-stream partial arrives before the hold without completing the response', { timeout: 8000 }, async context => {
    const provider = await createChatMockProvider(contract, { prefixHoldMs: 5000, prefixFrameDelayMs: 10, chunkDelayMs: 10, cancelTimeoutMs: 2000 });
    context.after(() => provider.close());
    const partialText = contract.firstPrefix + '안녕';
    let observedPartial = false;
    await assert.rejects(requestHTTP(provider.baseURL + '/chat/completions', {
        headers: { Authorization: `Bearer ${provider.credential}` }, timeoutMs: 3000,
        body: JSON.stringify({ model: contract.model, stream: true, messages: [{ role: 'user', content: contract.firstPrompt }] }),
        onChunk: text => {
            const complete = text.slice(0, text.lastIndexOf('\n\n') + 2);
            if (parseSSE(complete, 'openai').content === partialText) {
                observedPartial = true;
                return false;
            }
        },
    }), error => error.code === 'ST_CLIENT_CANCELLED');
    assert.equal(observedPartial, true);
    const generation = provider.observations.find(item => item.scenario === 'stream');
    assert.equal(generation.sentText, partialText);
    assert.equal(generation.doneSent, false);
});

test('owned provider emits incremental Unicode over real HTTP and observes cancellation before cleanup', { timeout: 5000 }, async context => {
    const provider = await createChatMockProvider(contract, { prefixHoldMs: 5, chunkDelayMs: 5, cancelTimeoutMs: 2000 });
    context.after(() => provider.close());
    const models = await requestHTTP(provider.baseURL + '/models', { headers: { Authorization: `Bearer ${provider.credential}` } });
    assert.equal(models.status, 200); assert.equal(JSON.parse(models.text).data[0].id, contract.model);
    const headers = { Authorization: `Bearer ${provider.credential}` };
    const first = await requestHTTP(provider.baseURL + '/chat/completions', { headers,
        body: JSON.stringify({ model: contract.model, stream: true, messages: [{ role: 'user', content: contract.firstPrompt }] }) });
    assert.equal(first.status, 200);
    assert.equal(parseSSE(first.text, 'openai').content, contract.firstResponse);
    assert.equal(parseSSE(first.text, 'openai').completed, true);
    const prior = [{ role: 'user', content: contract.firstPrompt }, { role: 'assistant', content: contract.firstResponse }, { role: 'user', content: contract.cancelPrompt }];
    await assert.rejects(requestHTTP(provider.baseURL + '/chat/completions', { headers, body: JSON.stringify({ model: contract.model, stream: true, messages: prior }),
        onChunk: text => {
            const complete = text.slice(0, text.lastIndexOf('\n\n') + 2);
            return parseSSE(complete, 'openai').content.includes(contract.cancelPrefix) ? false : undefined;
        } }), error => error.code === 'ST_CLIENT_CANCELLED');
    const deadline = Date.now() + 1000;
    while (!provider.observations.some(item => item.scenario === 'cancel' && item.closed) && Date.now() < deadline) await pause(10);
    assert.equal(verifyChatProvider(provider.observations, contract).upstreamCancellationBeforeCleanup, true);
    const cancelled = provider.observations.find(item => item.scenario === 'cancel');
    assert.equal(cancelled.doneSent, false); assert.equal(cancelled.completed, false); assert.equal(cancelled.closedBeforeShutdown, true);
    assert.equal(verifyChatProvider(provider.observations, contract, { stopTappedAt: cancelled.closedAt - 1, beforeColdRelaunchAt: cancelled.closedAt + 1 }).upstreamCancellationBeforeAppTermination, true);
    assert.throws(() => verifyChatProvider(provider.observations, contract, { stopTappedAt: cancelled.closedAt - 1, beforeColdRelaunchAt: cancelled.closedAt }), /app termination/);
    assert.throws(() => verifyChatProvider(provider.observations, contract, { stopTappedAt: cancelled.closedAt + 1, beforeColdRelaunchAt: cancelled.closedAt + 2 }), /actual tap/);
});

test('cleanup-produced closure cannot pass upstream cancellation evidence', { timeout: 5000 }, async context => {
    const provider = await createChatMockProvider(contract, { prefixHoldMs: 0, chunkDelayMs: 0, cancelTimeoutMs: 2000 });
    let closed = false;
    context.after(async () => { if (!closed) await provider.close(); });
    const headers = { Authorization: `Bearer ${provider.credential}` };
    await requestHTTP(provider.baseURL + '/models', { headers });
    await requestHTTP(provider.baseURL + '/chat/completions', { headers, body: JSON.stringify({ model: contract.model, stream: true, messages: [{ role: 'user', content: contract.firstPrompt }] }) });
    const pending = requestHTTP(provider.baseURL + '/chat/completions', { headers, body: JSON.stringify({ model: contract.model, stream: true,
        messages: [{ role: 'user', content: contract.firstPrompt }, { role: 'assistant', content: contract.firstResponse }, { role: 'user', content: contract.cancelPrompt }] }) }).catch(error => error);
    const deadline = Date.now() + 1000;
    while (!provider.observations.some(item => item.scenario === 'cancel' && item.contentFrames === 2) && Date.now() < deadline) await pause(5);
    assert.ok(provider.observations.some(item => item.scenario === 'cancel' && item.contentFrames === 2 && item.sentText === contract.cancelPrefix), 'Cancellation response must actually be active before provider cleanup');
    await provider.close(); closed = true; await pending;
    assert.throws(() => verifyChatProvider(provider.observations, contract), /before DONE\/provider cleanup/);
});
