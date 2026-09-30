import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read as readCard } from '../../src/character-card-parser.js';
import { createDataFixture, createReadClient, legacyConfig, verifyLegacyConfig, verifyReadableFixture, fileDigest } from '../scripts/simulator-data-fixture.mjs';
import { createUpgradeVariant } from '../scripts/create-upgrade-variant.mjs';
import { writeRuntimeManifest, verifyRuntimeManifest } from '../scripts/runtime-manifest.mjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');
async function directory(t) {
    await fs.mkdir(testRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(testRoot, 'simulator-data-helper-'));
    t.after(async () => {
        const relative = path.relative(testRoot, root);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(root, { recursive: true, force: true });
    });
    return root;
}

test('generated card PNGs reopen with the real parser and both source formats', () => {
    for (const legacy of [false, true]) {
        const fixture = createDataFixture('generated-fixture', {}, { legacy });
        const card = fixture.files.find(file => file.kind === 'character-card');
        assert.deepEqual(JSON.parse(readCard(card.bytes)), fixture.card);
        assert.equal(fixture.files.length, 7);
        assert.equal(fixture.excludedBackupFiles.length, 2);
        for (const file of fixture.excludedBackupFiles) {
            assert.ok(file.path.startsWith('Documents/SillyTavern/default-user/'));
            assert.ok(file.bytes.includes(Buffer.from(file.marker)));
            assert.doesNotThrow(() => JSON.parse(file.bytes.toString('utf8')));
        }
        assert.ok(fixture.chat.every(line => typeof line === 'object'));
        assert.equal(fixture.chat[0].chat_metadata.integrity, undefined, 'Legacy-compatible headers do not invent integrity hashes');
        for (const file of fixture.files) {
            assert.ok(!file.path.split('/').includes('..'));
            assert.ok(!file.bytes.includes(Buffer.from('api_key')));
        }
    }
    assert.throws(() => createDataFixture('../escape'), /Unsafe fixture ID/);
});

test('a synthetic legacy config is only accepted after real key/value migration', async t => {
    const root = await directory(t);
    const bytes = legacyConfig('legacy-fixture');
    assert.throws(() => verifyLegacyConfig(bytes, 'legacy-fixture'));
    const filename = path.join(root, 'config.yaml');
    await fs.writeFile(filename, bytes);
    const { initConfig } = await import('../../src/config-init.js');
    const methods = { log: console.log, warn: console.warn };
    try { console.log = console.warn = () => {}; initConfig(filename); }
    finally { Object.assign(console, methods); }
    const migrated = await fs.readFile(filename);
    assert.equal(verifyLegacyConfig(migrated, 'legacy-fixture').deprecatedKeysMigrated, 7);
    assert.notEqual(fileDigest(bytes), fileDigest(migrated));
    try { console.log = console.warn = () => {}; initConfig(filename); }
    finally { Object.assign(console, methods); }
    assert.deepEqual(await fs.readFile(filename), migrated);
});

test('read client keeps CSRF/session protection and rejects non-local origins or redirects', async () => {
    const calls = [];
    const client = await createReadClient({ fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return url.pathname === '/csrf-token'
            ? new Response('{"token":"test-csrf-token"}', { status: 200, headers: { 'set-cookie': 'session=fixture; Path=/; HttpOnly' } })
            : new Response('{}', { status: 200 });
    } });
    await client('/api/settings/get', {});
    assert.equal(calls[1].options.headers['X-CSRF-Token'], 'test-csrf-token');
    assert.equal(calls[1].options.headers.Cookie, 'session=fixture');
    assert.equal(calls[1].options.redirect, 'error');
    await assert.rejects(client('//example.invalid'), /Unsafe/);
    await assert.rejects(createReadClient({ baseURL: 'https://example.invalid' }), /local HTTP/);
    await assert.rejects(createReadClient({ fetchImpl: async () => new Response('{"token":"disabled"}', { status: 200 }) }), /CSRF must remain enabled/);
});

test('read verification fails on missing presets rather than accepting saved bytes alone', async () => {
    const fixture = createDataFixture('missing-preset');
    await assert.rejects(verifyReadableFixture(fixture, async () => ({ settings: JSON.stringify(fixture.settings),
        openai_setting_names: [], openai_settings: [] })), /Saved preset is missing/);
});

async function sourceApp(t) {
    const root = await directory(t);
    const app = path.join(root, 'Source.app');
    const runtime = path.join(app, 'public', 'nodejs-project');
    await fs.mkdir(runtime, { recursive: true });
    const info = { CFBundleIdentifier: 'fixture.ST', CFBundleSupportedPlatforms: ['iPhoneSimulator'], CFBundleVersion: '10190' };
    await fs.writeFile(path.join(app, 'Info.plist'), JSON.stringify(info));
    for (const file of ['server-ios.js', 'server-bundle.mjs', 'config.yaml', 'package.json']) await fs.writeFile(path.join(runtime, file), `fixture ${file}\n`);
    const manifest = await writeRuntimeManifest(runtime, '1.19.0');
    const runCommand = async (command, args) => {
        assert.equal(command, 'plutil');
        const filename = args.at(-1);
        const data = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (args[0] === '-replace') {
            data[args[1]] = args[3];
            await fs.writeFile(filename, JSON.stringify(data));
            return { stdout: '' };
        }
        return { stdout: args[2] === 'json' ? JSON.stringify(data[args[1]]) : String(data[args[1]]) };
    };
    return { root, app, runtime, manifest, runCommand };
}

test('variant changes deployment and build only in a labeled unsigned copy', async t => {
    const source = await sourceApp(t);
    const info = await fs.readFile(path.join(source.app, 'Info.plist'));
    const result = await createUpgradeVariant({ sourceApp: source.app, outputRoot: path.join(source.root, 'output') }, source);
    assert.equal(result.classification, 'controlled-deployment-variant');
    assert.equal(result.sameApplicationSource, true);
    assert.equal(result.notDifferentSillyTavernVersion, true);
    assert.equal(result.toBuild, '10191');
    assert.notEqual(result.sourceDeploymentId, result.targetDeploymentId);
    assert.deepEqual(await verifyRuntimeManifest(source.runtime), source.manifest);
    assert.deepEqual(await fs.readFile(path.join(source.app, 'Info.plist')), info);
    const upgraded = await verifyRuntimeManifest(path.join(result.upgradeApp, 'public', 'nodejs-project'));
    assert.equal(upgraded.deploymentId, result.targetDeploymentId);
    assert.ok(upgraded.files.some(file => file.path === 'validation-deployment-variant.json'));
    const metadata = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'));
    assert.equal(metadata.classification, result.classification);
});

test('variant refuses source overlap, occupied output, symlinks and signed input', async t => {
    const source = await sourceApp(t);
    await assert.rejects(createUpgradeVariant({ sourceApp: source.app, outputRoot: path.join(source.app, 'output') }, source), /separate/);
    const output = path.join(source.root, 'occupied');
    await fs.mkdir(output);
    await fs.writeFile(path.join(output, 'preserve.txt'), 'owned by another operation');
    await assert.rejects(createUpgradeVariant({ sourceApp: source.app, outputRoot: output }, source), /new or empty/);
    assert.equal(await fs.readFile(path.join(output, 'preserve.txt'), 'utf8'), 'owned by another operation');
    const alias = path.join(source.app, 'alias');
    await fs.symlink(source.runtime, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createUpgradeVariant({ sourceApp: source.app, outputRoot: path.join(source.root, 'links') }, source), /symlink/);
    await fs.unlink(alias);
    await fs.mkdir(path.join(source.app, '_CodeSignature'));
    await assert.rejects(createUpgradeVariant({ sourceApp: source.app, outputRoot: path.join(source.root, 'signed') }, source), /unsigned Simulator/);
});
