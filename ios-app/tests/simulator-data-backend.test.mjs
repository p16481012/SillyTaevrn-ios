import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDataFixture, createReadClient, verifyReadableFixture, legacyConfig, verifyLegacyConfig } from '../scripts/simulator-data-fixture.mjs';
import { createTransferClient, runTransferScenario, verifyTransferReopen } from '../scripts/simulator-transfer-fixture.mjs';

// Run separately from all other port-8000 integration tests. No browser/provider calls.
const iosRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.join(iosRoot, '.test-tmp');
const deploy = path.join(iosRoot, 'nodejs-project-deploy');
const publicDirectory = path.join(iosRoot, 'ios', 'App', 'App', 'public');
const base = 'http://127.0.0.1:8000';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('real packaged APIs import, back up, restore and reopen representative data across JITless cold starts', { timeout: 180000 }, async () => {
    assert.ok((await fs.stat(path.join(deploy, 'runtime-manifest.json'))).isFile(), 'Prepare iOS assets before this integration test');
    try {
        await fetch(`${base}/api/ios/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        assert.fail('Port 8000 is occupied; run backend integration tests sequentially');
    } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
    await fs.mkdir(temporaryRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'simulator-data-backend-'));
    const runtime = path.join(directory, 'runtime');
    const documents = path.join(directory, 'Documents');
    const support = path.join(directory, 'support');
    let child;
    let closed;
    let hasClosed = false;
    let stopFailure;
    let running = false;

    async function waitForClose(timeoutMs) {
        if (hasClosed) return true;
        let timer;
        try {
            return await Promise.race([
                closed.then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async function stop() {
        if (stopFailure) throw stopFailure;
        if (!child) return;
        if (!hasClosed && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        if (!await waitForClose(2000)) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            if (!await waitForClose(2000)) {
                stopFailure = new Error(`Backend close could not be confirmed for PID ${child.pid ?? 'unknown'} after SIGTERM/SIGKILL; fixture preserved at ${directory}`);
                throw stopFailure;
            }
        }
        child = undefined;
        closed = undefined;
        running = false;
    }

    async function start() {
        const script = `if (typeof WebAssembly !== 'undefined') throw new Error('WASM must be disabled');
            globalThis.Intl = undefined;
            await import(${JSON.stringify(pathToFileURL(path.join(runtime, 'server-ios.js')).href)});`;
        let stderr = '';
        child = spawn(process.env.ST_TEST_NODE ?? process.execPath, ['--jitless', '--input-type=module', '-e', script], {
            cwd: runtime, env: { ...process.env, ST_IOS_CONFIG_PATH: path.join(support, 'st_config.json'),
                NODE_PATH: path.join(iosRoot, 'node_modules', '@choreruiz', 'capacitor-node-js', 'ios', 'Swift', 'builtin_modules') },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        running = true;
        hasClosed = false;
        closed = new Promise(resolve => child.once('close', () => { hasClosed = true; resolve(); }));
        child.on('error', error => { stderr = (stderr + error.message).slice(-4096); });
        child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
            try {
                const response = await fetch(`${base}/api/ios/health`, { signal: AbortSignal.timeout(1000) });
                const health = await response.json();
                if (response.status === 200 && health.ready === true && health.deploymentId === manifest.deploymentId) return;
            } catch { /* owned server is still starting */ }
            await delay(100);
        }
        const log = await fs.readFile(path.join(support, 'logs', 'startup.log'), 'utf8').catch(() => '(no startup log)');
        assert.fail(`Owned backend failed to become ready: ${stderr}\n${log.slice(-4096)}`);
    }

    const configFile = path.join(documents, 'SillyTavern', 'config.yaml');
    async function writeFixture(fixture) {
        assert.equal(running, false, 'Fixture writes require a stopped backend');
        for (const file of [...fixture.files, ...fixture.excludedBackupFiles]) {
            const target = path.resolve(directory, file.path);
            const relative = path.relative(directory, target);
            assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, file.bytes);
        }
    }
    async function checkBytes(fixture) {
        for (const file of [...fixture.files, ...fixture.excludedBackupFiles]) {
            assert.deepEqual(await fs.readFile(path.join(directory, file.path)), file.bytes, file.kind);
        }
    }
    async function readFixtureFile(relative) {
        const target = path.resolve(directory, relative);
        const within = path.relative(directory, target);
        assert.ok(within && within !== '..' && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within));
        return fs.readFile(target);
    }
    let manifest;
    try {
        await fs.cp(deploy, runtime, { recursive: true });
        await fs.mkdir(documents);
        await fs.mkdir(support);
        manifest = JSON.parse(await fs.readFile(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
        await fs.writeFile(path.join(support, 'st_config.json'), JSON.stringify({ bundlePublicPath: publicDirectory,
            bundleServerRoot: path.join(publicDirectory, 'st-defaults'), documentsPath: documents,
            deploymentId: manifest.deploymentId, applicationVersion: manifest.applicationVersion }));
        await start();
        await stop();
        const initial = JSON.parse(await fs.readFile(path.join(documents, 'SillyTavern', 'default-user', 'settings.json'), 'utf8'));
        const modern = createDataFixture('host-modern-fixture', initial);
        const initialConfig = await fs.readFile(configFile);
        await writeFixture(modern);
        await start();
        await verifyReadableFixture(modern, await createReadClient());
        await checkBytes(modern);
        assert.deepEqual(await fs.readFile(configFile), initialConfig);
        const { state, report } = await runTransferScenario(modern, { api: await createTransferClient(), readFile: readFixtureFile });
        assert.equal(report.fullDataZipExportChecked, true);
        assert.equal(report.fullDataZipRestoreAvailable, false);
        await checkBytes(modern);
        await stop();
        await start();
        const reopened = await verifyTransferReopen(modern, state, { api: await createTransferClient(), readFile: readFixtureFile });
        assert.equal(reopened.coldProcessRestart, true);
        await verifyReadableFixture(modern, await createReadClient());
        await checkBytes(modern);
        await stop();

        const legacy = createDataFixture('host-legacy-fixture', { firstRun: true, username: 'User', user_avatar: 'user-default.png',
            main_api: 'koboldhorde', amount_gen: 350, power_user: { personas: {}, persona_descriptions: {}, custom_stopping_strings: '' } }, { legacy: true });
        await writeFixture(legacy);
        await fs.writeFile(configFile, legacyConfig(legacy.id));
        await start();
        const migrated = await fs.readFile(configFile);
        verifyLegacyConfig(migrated, legacy.id);
        await verifyReadableFixture(legacy, await createReadClient());
        await checkBytes(legacy);
        await stop();
        await start();
        assert.deepEqual(await fs.readFile(configFile), migrated, 'Migrated config must remain stable on a second cold start');
        await verifyReadableFixture(legacy, await createReadClient());
        await checkBytes(legacy);
    } finally {
        await stop();
        const relative = path.relative(temporaryRoot, directory);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
