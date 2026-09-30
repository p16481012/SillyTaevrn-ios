import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiProfiles, parseUIArguments, selectRequestedProfiles, selectProfileType, configureXctestrun, checkUIOutputRoot } from '../scripts/validate-simulator-ui.mjs';

test('UI CLI requires an explicit Simulator and complete absolute build/output paths', () => {
    const options = ['--template-udid', '11111111-1111-1111-1111-111111111111', '--app', path.resolve('App.app'),
        '--xctestrun', path.resolve('App.xctestrun'), '--output-root', path.resolve('ui-results')];
    assert.equal(parseUIArguments(options).udid, options[1]);
    assert.deepEqual(parseUIArguments(['--help']), { help: true });
    assert.throws(() => parseUIArguments(options.map(value => value === options[1] ? 'booted' : value)), /explicit/);
    assert.throws(() => parseUIArguments([...options, '--app', options[3]]), /Invalid UI option/);
    assert.throws(() => parseUIArguments(options.map(value => value === options[3] ? 'App.app' : value)), /absolute/);
    assert.throws(() => parseUIArguments(options.slice(0, -2)), /absolute/);
});

test('UI CLI selects exactly one known profile when requested and otherwise retains all profiles', () => {
    const options = ['--template-udid', '11111111-1111-1111-1111-111111111111', '--app', path.resolve('App.app'),
        '--xctestrun', path.resolve('App.xctestrun'), '--output-root', path.resolve('ui-results')];
    assert.deepEqual(selectRequestedProfiles(parseUIArguments(options).profile), uiProfiles);
    for (const profile of uiProfiles) {
        const selected = parseUIArguments([...options, '--profile', profile.name]);
        assert.deepEqual(selectRequestedProfiles(selected.profile), [profile]);
    }
    assert.throws(() => parseUIArguments([...options, '--profile', 'iphone-ko,ipad-en']), /Unknown UI profile/);
    assert.throws(() => parseUIArguments([...options, '--profile', 'iPhone-ko']), /Unknown UI profile/);
    assert.throws(() => parseUIArguments([...options, '--profile', 'iphone-ko', '--profile', 'ipad-en']), /Invalid UI option/);
});

test('device selection records a supported small-screen fallback and refuses a large-only substitution', () => {
    const prefix = 'com.apple.CoreSimulator.SimDeviceType.';
    const types = [
        { identifier: prefix + 'iPhone-SE-3rd-generation', maxRuntimeVersion: 25 * 65536, name: 'SE' },
        { identifier: prefix + 'iPhone-13-mini', minRuntimeVersion: 15 * 65536, name: 'iPhone 13 mini' },
        { identifier: prefix + 'iPhone-17-Pro', name: 'iPhone 17 Pro' },
    ];
    const template = { deviceTypeIdentifier: types[2].identifier };
    assert.equal(selectProfileType(uiProfiles[0], types, '26.4.1', template).name, 'iPhone 13 mini');
    assert.equal(selectProfileType(uiProfiles[2], types, '26.4.1', template).identifier, template.deviceTypeIdentifier);
    assert.throws(() => selectProfileType(uiProfiles[0], types.slice(2), '26.4.1', template), /cannot silently/);
    assert.throws(() => selectProfileType(uiProfiles[0], types, 'unknown', template), /runtime version/);
    assert.throws(() => selectProfileType({ ...uiProfiles[0], language: 'ko-kr' }, types, '26.4.1', template), /Unknown/);
});

test('iPad profile must select an actual supported iPad device type', () => {
    const type = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3', name: 'iPad Air 11-inch (M3)' };
    assert.equal(selectProfileType(uiProfiles[1], [type], '26.4.1', {}).identifier, type.identifier);
    assert.throws(() => selectProfileType(uiProfiles[1], [{ ...type, minRuntimeVersion: 27 * 65536 }], '26.4.1', {}), /No supported/);
});

test('xctestrun profile injection preserves the original and other targets while relocating test products', () => {
    const source = { TestConfigurations: [{ TestTargets: [
        { BlueprintName: 'AppUITests', IsUITestBundle: true, TestBundlePath: '__TESTROOT__/AppUITests-Runner.app/PlugIns/AppUITests.xctest',
            UITargetAppPath: '__TESTROOT__/App.app', UITargetAppBundleIdentifier: 'com.sillytavern.ios', EnvironmentVariables: { EXISTING: 'preserved' } },
        { BlueprintName: 'OtherTests', IsUITestBundle: false, EnvironmentVariables: { EXISTING: 'unrelated' } },
    ] }], __xctestrun_metadata__: { FormatVersion: 2 } };
    const original = JSON.stringify(source);
    const root = path.resolve('Products');
    const configured = configureXctestrun(source, uiProfiles[2], root);
    assert.equal(JSON.stringify(source), original);
    const [target, other] = configured.TestConfigurations[0].TestTargets;
    assert.deepEqual(target.EnvironmentVariables, { EXISTING: 'preserved', ST_UI_PROFILE: 'iphone-ko', ST_UI_LANGUAGE: 'ko-kr' });
    assert.equal(target.UITargetAppPath, `${root}/App.app`);
    assert.deepEqual(other.EnvironmentVariables, { EXISTING: 'unrelated' });
    assert.deepEqual(configured.__xctestrun_metadata__, source.__xctestrun_metadata__);
});

test('xctestrun cannot silently run without a language-configured UI target or against another app', () => {
    const root = path.resolve('Products');
    assert.throws(() => configureXctestrun({ TestConfigurations: [] }, uiProfiles[2], root), /No AppUITests/);
    const target = { BlueprintName: 'AppUITests', IsUITestBundle: true, UITargetAppBundleIdentifier: 'another.app',
        UITargetAppPath: '__TESTROOT__/App.app', TestBundlePath: '__TESTROOT__/AppUITests.xctest' };
    assert.throws(() => configureXctestrun({ AppUITests: target }, uiProfiles[0], root), /different app/);
    assert.throws(() => configureXctestrun({}, { name: 'invented', language: 'en' }, root), /Invalid test/);
});

test('UI output guards preserve existing data and reject Simulator/app paths and symlinks', async t => {
    const temporaryRoot = fileURLToPath(new URL('../.test-tmp/', import.meta.url));
    await fs.mkdir(temporaryRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(temporaryRoot, 'ui-output-'));
    t.after(async () => {
        const relative = path.relative(temporaryRoot, fixture);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(fixture, { recursive: true, force: true });
    });
    const app = path.join(fixture, 'App.app');
    const devices = path.join(fixture, 'Devices');
    const results = path.join(fixture, 'results');
    await fs.mkdir(app); await fs.mkdir(devices); await fs.mkdir(results);
    assert.equal(await checkUIOutputRoot(results, app, devices), await fs.realpath(results));
    assert.equal(await checkUIOutputRoot(path.join(fixture, 'new-results'), app, devices), path.join(await fs.realpath(fixture), 'new-results'));
    await assert.rejects(checkUIOutputRoot(path.join(devices, 'results'), app, devices), /separate/);
    await assert.rejects(checkUIOutputRoot(app, app, devices), /separate/);
    await assert.rejects(checkUIOutputRoot(fixture, app, devices), /separate/);
    await fs.writeFile(path.join(results, 'keep.txt'), 'preserved');
    await assert.rejects(checkUIOutputRoot(results, app, devices), /new or an empty/);
    assert.equal(await fs.readFile(path.join(results, 'keep.txt'), 'utf8'), 'preserved');
    const link = path.join(fixture, 'alias');
    await fs.symlink(results, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkUIOutputRoot(link, app, devices), /ordinary directory/);
});
