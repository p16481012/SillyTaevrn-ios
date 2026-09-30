import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeRuntimeManifest } from '../scripts/runtime-manifest.mjs';
import { parseUnsignedDeviceArguments, checkUnsignedOutputRoot, checkDeviceBundleInfo,
    checkUnsignedCodeSign, fingerprintApp, packageUnsignedDevice } from '../scripts/package-unsigned-device.mjs';

const testRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
const info = { CFBundleIdentifier: 'com.sillytavern.ios', CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.19.0',
    CFBundleVersion: '1', CFBundleSupportedPlatforms: ['iPhoneOS'], DTPlatformName: 'iphoneos', CFBundleExecutable: 'App', MinimumOSVersion: '15.0' };
const unsigned = app => ({ exitCode: 1, stdout: '', stderr: `${app}: code object is not signed at all\n` });

async function fixture(t) {
    await fs.mkdir(testRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(testRoot, 'unsigned-device-'));
    t.after(async () => {
        const relative = path.relative(testRoot, root);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        assert.equal(await fs.realpath(root), root);
        await fs.rm(root, { recursive: true, force: true });
    });
    const app = path.join(root, 'App.app');
    const runtime = path.join(app, 'public', 'nodejs-project');
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(app, 'Info.plist'), 'Unit fixture only; plutil is mocked.');
    await fs.writeFile(path.join(app, 'App'), 'Unit fixture only; not a native executable.');
    await fs.writeFile(path.join(runtime, 'server-bundle.mjs'), 'export const fixture = true;');
    const manifest = await writeRuntimeManifest(runtime, '1.19.0');
    return { root, app, manifest, outputRoot: path.join(root, 'output') };
}

function fixtureCommands(onArchive, calls = []) {
    return async (command, args) => {
        calls.push({ command, args });
        if (command === '/usr/bin/plutil') return { exitCode: 0, stdout: JSON.stringify(info), stderr: '' };
        if (command === '/usr/bin/codesign') return unsigned(args.at(-1));
        assert.equal(command, '/usr/bin/ditto');
        assert.deepEqual(args.slice(0, 3), ['-c', '-k', '--keepParent']);
        assert.equal(path.basename(args[3]), 'Payload');
        assert.ok((await fs.lstat(path.join(args[3], 'App.app', 'App'))).isFile());
        return onArchive(args.at(-1));
    };
}

test('unsigned packaging CLI has no signing option and requires complete absolute paths', () => {
    const args = ['--app', path.resolve('App.app'), '--output-root', path.resolve('new-output')];
    assert.deepEqual(parseUnsignedDeviceArguments(args), { app: args[1], outputRoot: args[3] });
    assert.deepEqual(parseUnsignedDeviceArguments(['--help']), { help: true });
    for (const invalid of [args.slice(0, -2), [...args, '--app', args[1]], [...args, '--sign', 'identity'],
        ['--app', 'App.app', '--output-root', args[3]], ['--app', `${args[1]}\n`, '--output-root', args[3]]]) {
        assert.throws(() => parseUnsignedDeviceArguments(invalid));
    }
});

test('device bundle guard rejects Simulator, foreign app, wrong release and unsafe executable paths', () => {
    const manifest = { applicationVersion: '1.19.0', deploymentId: 'a'.repeat(64) };
    checkDeviceBundleInfo(info, manifest);
    for (const patch of [{ CFBundleSupportedPlatforms: ['iPhoneSimulator'] }, { DTPlatformName: 'iphonesimulator' },
        { CFBundleIdentifier: 'another.app' }, { CFBundleShortVersionString: '1.18.0' }, { CFBundleExecutable: '../elsewhere' }]) {
        assert.throws(() => checkDeviceBundleInfo({ ...info, ...patch }, manifest));
    }
    assert.throws(() => checkDeviceBundleInfo(info, { ...manifest, applicationVersion: '1.18.0' }));
    assert.throws(() => checkDeviceBundleInfo(info, { ...manifest, deploymentId: 'unknown' }));
});

test('only the specific codesign unsigned diagnostic is accepted; signed apps and unrelated failures fail closed', () => {
    const app = path.resolve('App.app');
    assert.equal(checkUnsignedCodeSign(unsigned(app), app).mainApplication, 'unsigned');
    for (const result of [{ exitCode: 0, stdout: '', stderr: 'Signature=adhoc' },
        { ...unsigned(app), exitCode: 2 }, { ...unsigned(app), stderr: `${app}: Permission denied` },
        { ...unsigned(app), signal: 'SIGTERM' }, { ...unsigned(app), killed: true },
        { ...unsigned(app), stdout: 'unexpected output' }, { ...unsigned(app), stderr: unsigned(app).stderr + 'another error' }]) {
        assert.throws(() => checkUnsignedCodeSign(result, app), /did not confirm/);
    }
});

test('output guards reject source overlap, nonempty data and symlink aliases without removing files', async t => {
    const data = await fixture(t);
    assert.equal(await checkUnsignedOutputRoot(data.outputRoot, data.app), data.outputRoot);
    await assert.rejects(checkUnsignedOutputRoot(path.join(data.app, 'output'), data.app), /separate/);
    await assert.rejects(checkUnsignedOutputRoot(data.root, data.app), /separate/);
    await assert.rejects(checkUnsignedOutputRoot(data.app, data.app), /separate/);
    await fs.mkdir(data.outputRoot);
    await fs.writeFile(path.join(data.outputRoot, 'keep.txt'), 'preserved');
    await assert.rejects(checkUnsignedOutputRoot(data.outputRoot, data.app), /new or an empty/);
    assert.equal(await fs.readFile(path.join(data.outputRoot, 'keep.txt'), 'utf8'), 'preserved');
    const empty = path.join(data.root, 'empty');
    await fs.mkdir(empty);
    const alias = path.join(data.root, 'alias');
    await fs.symlink(empty, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkUnsignedOutputRoot(alias, data.app), /ordinary directory/);
});

test('bundle fingerprint detects changed bytes and rejects links to external data', async t => {
    const data = await fixture(t);
    const original = await fingerprintApp(data.app);
    await fs.writeFile(path.join(data.app, 'App'), 'Changed bundle bytes.');
    assert.notEqual((await fingerprintApp(data.app)).sha256, original.sha256);
    const outside = path.join(data.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'external data');
    await fs.symlink(outside, path.join(data.app, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(fingerprintApp(data.app), /symlinks/);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'external data');
});

test('actual packaging refuses non-macOS before invoking tools or creating output', async t => {
    const data = await fixture(t);
    await assert.rejects(packageUnsignedDevice(data, { platform: 'win32', command: () => assert.fail('No tool may run.') }), /macOS/);
    await assert.rejects(fs.stat(data.outputRoot), { code: 'ENOENT' });
});

test('mocked macOS packaging verifies source preservation, IPA checksum, limitations and owned staging cleanup', async t => {
    const data = await fixture(t);
    const before = await fingerprintApp(data.app);
    const calls = [];
    // This tests packaging bookkeeping only, not a real ditto archive or app.
    const archive = Buffer.from('PK-unit-fixture-archive');
    const command = fixtureCommands(async filename => {
        await fs.writeFile(filename, archive);
        return { exitCode: 0, stdout: '', stderr: '' };
    }, calls);
    const sourceRevision = '1234567890abcdef1234567890abcdef12345678';
    const metadata = await packageUnsignedDevice(data, { platform: 'darwin', command, sourceRevision });
    assert.equal(metadata.sourceRevision, sourceRevision);
    assert.equal(metadata.ipa.sha256, createHash('sha256').update(archive).digest('hex'));
    assert.equal(metadata.deploymentId, data.manifest.deploymentId);
    assert.equal(metadata.ipa.payloadApp, 'Payload/App.app');
    assert.equal(metadata.installRequiresSigning, true);
    assert.equal(metadata.physicalDeviceValidated, false);
    assert.equal(metadata.signingCredentialsRequiredForPackaging, false);
    assert.equal(metadata.sourcePreservationVerified, true);
    assert.deepEqual(await fingerprintApp(data.app), before);
    assert.deepEqual((await fs.readdir(data.outputRoot)).sort(), [metadata.ipa.filename, 'unsigned-device-build.json'].sort());
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data.outputRoot, 'unsigned-device-build.json'), 'utf8')), metadata);
    assert.equal(calls.filter(call => call.command === '/usr/bin/codesign').length, 2);
    assert.ok(calls.every(call => !call.args.includes('--sign')));
});

test('archive failure cleans only owned partial/staging files and preserves unrelated output and source', async t => {
    const data = await fixture(t);
    const before = await fingerprintApp(data.app);
    const command = fixtureCommands(async filename => {
        await fs.writeFile(filename, 'partial');
        await fs.writeFile(path.join(data.outputRoot, 'keep.txt'), 'unrelated output');
        return { exitCode: 2, stdout: '', stderr: 'fixture archive failure' };
    });
    await assert.rejects(packageUnsignedDevice(data, { platform: 'darwin', command }), /Creating unsigned IPA failed/);
    assert.deepEqual(await fs.readdir(data.outputRoot), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(data.outputRoot, 'keep.txt'), 'utf8'), 'unrelated output');
    assert.deepEqual(await fingerprintApp(data.app), before);
});
