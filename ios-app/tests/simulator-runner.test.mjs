import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cleanupOwnedUISimulator, checkpointSimulatorPhase, probePortOffline, waitForOffline } from '../scripts/validate-simulator-ui.mjs';

const udid = '11111111-2222-3333-4444-555555555555';
const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const deviceTypeIdentifier = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const fixtureName = 'SillyTavern-stage3-iphone-ko-owned';
const options = { fixtureUDID: udid, fixtureName, runtimeIdentifier, deviceTypeIdentifier,
    xctestStarted: true, bundleID: 'com.sillytavern.ios' };

function listing(name = fixtureName, state = 'Booted') {
    return JSON.stringify({ devices: { [runtimeIdentifier]: [{ udid, name, state, isAvailable: true, deviceTypeIdentifier }] } });
}

test('UI port preflight distinguishes an unresponsive listener from a refused connection', async context => {
    const server = createServer(() => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.listening ? new Promise(resolve => server.close(resolve)) : undefined);
    const port = server.address().port;
    assert.equal(await probePortOffline({ port }), false);
    await new Promise(resolve => server.close(resolve));
    assert.equal(await probePortOffline({ port }), true);
});

test('UI port preflight retries a timeout but never counts it as offline', async () => {
    let elapsed = 0;
    let attempts = 0;
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { code: 'ETIMEDOUT' });
    const options = { timeoutMs: 400, retryMs: 200, now: () => elapsed, sleep: async milliseconds => { elapsed += milliseconds; } };
    await waitForOffline({ ...options, probe: async () => { attempts++; if (attempts === 1) throw timeout; return true; } });
    assert.equal(attempts, 2);
    elapsed = 0;
    await assert.rejects(waitForOffline({ ...options, probe: async () => { throw timeout; } }), /cannot be verified as unused \(ETIMEDOUT\)/);
    elapsed = 0;
    await assert.rejects(waitForOffline({ ...options, probe: async () => false }), /still occupied/);
});

test('UI cleanup makes bounded independent shutdown and delete attempts after a stuck terminate', async () => {
    const calls = [];
    const command = async (args, timeoutMs) => {
        calls.push({ command: args[0], timeoutMs });
        if (args[0] === 'list') return { stdout: listing() };
        if (args[0] === 'terminate') throw new Error('simctl terminate timed out');
        if (args[0] === 'shutdown') throw new Error('simctl shutdown timed out');
        return { stdout: '' };
    };
    const result = await cleanupOwnedUISimulator(options, command);
    assert.equal(result.deletedOwnedSimulator, true);
    assert.equal(result.simulatorState, 'Booted');
    assert.match(result.terminationError.message, /timed out/);
    assert.match(result.shutdownError.message, /timed out/);
    assert.deepEqual(calls, [{ command: 'list', timeoutMs: 20000 }, { command: 'terminate', timeoutMs: 20000 },
        { command: 'shutdown', timeoutMs: 30000 }, { command: 'delete', timeoutMs: 30000 }]);
});

test('UI cleanup skips app termination before XCTest and never deletes a borrowed Simulator', async () => {
    const calls = [];
    const command = async args => {
        calls.push(args[0]);
        return { stdout: args[0] === 'list' ? listing() : '' };
    };
    const result = await cleanupOwnedUISimulator({ ...options, xctestStarted: false }, command);
    assert.equal(result.deletedOwnedSimulator, true);
    assert.deepEqual(calls, ['list', 'shutdown', 'delete']);

    calls.length = 0;
    const borrowed = await cleanupOwnedUISimulator(options, async args => {
        calls.push(args[0]);
        return { stdout: listing('Another user Simulator') };
    });
    assert.equal(borrowed.deletedOwnedSimulator, false);
    assert.match(borrowed.simulatorError.message, /identity changed/);
    assert.deepEqual(calls, ['list']);
});

test('runner checkpoints the current phase in both reports before a long command', async context => {
    const base = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
    await fs.mkdir(base, { recursive: true });
    const outputRoot = await fs.mkdtemp(path.join(base, 'runner-checkpoint-'));
    context.after(async () => {
        const resolved = await fs.realpath(outputRoot);
        assert.equal(path.dirname(resolved), await fs.realpath(base));
        assert.ok(path.basename(resolved).startsWith('runner-checkpoint-'));
        await fs.rm(resolved, { recursive: true, force: true });
    });
    const directory = path.join(outputRoot, 'iphone-ko');
    await fs.mkdir(directory);
    const result = { profile: 'iphone-ko', status: 'failed' };
    const report = { status: 'failed', profiles: [result] };
    const args = { profileName: result.profile, result, report, directory, outputRoot, reportName: 'ui-profiles.json' };
    await checkpointSimulatorPhase({ ...args, name: 'boot-simulator' });
    await checkpointSimulatorPhase({ ...args, name: 'run-xctest' });
    const profile = JSON.parse(await fs.readFile(path.join(directory, 'profile-result.json'), 'utf8'));
    const summary = JSON.parse(await fs.readFile(path.join(outputRoot, 'ui-profiles.json'), 'utf8'));
    assert.equal(profile.phase, 'run-xctest');
    assert.equal(summary.profiles[0].phase, 'run-xctest');
    assert.deepEqual(profile.phaseHistory.map(item => item.name), ['boot-simulator', 'run-xctest']);
    assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
    assert.deepEqual((await fs.readdir(outputRoot)).filter(name => name.endsWith('.tmp')), []);
});
