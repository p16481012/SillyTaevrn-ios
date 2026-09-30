import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCITemplate } from '../scripts/ci-simulator-template.mjs';

const current = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const older = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
const device = { udid: '11111111-1111-1111-1111-111111111111', state: 'Shutdown', isAvailable: true,
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' };
const listing = () => ({ runtimes: [{ identifier: current, version: '26.5', buildversion: 'fixture', isAvailable: true }],
    devices: { [older]: [{ ...device, udid: '22222222-2222-2222-2222-222222222222' }], [current]: [device] } });

test('CI selects its pinned runtime even when an older iPhone appears first', () => {
    const selected = selectCITemplate(listing(), current);
    assert.equal(selected.udid, device.udid);
    assert.equal(selected.runtime.identifier, current);
    assert.equal(selected.runtime.version, '26.5');
});

test('CI fails clearly instead of substituting an absent runtime or incompatible template', () => {
    assert.throws(() => selectCITemplate(listing(), undefined), /explicit/);
    assert.throws(() => selectCITemplate(listing(), older), /unavailable/);
    for (const replacement of [{ ...device, isAvailable: false }, { ...device, state: 'Creating' },
        { ...device, udid: 'booted' }, { ...device, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-A16' }]) {
        const source = listing();
        source.devices[current] = [replacement];
        assert.throws(() => selectCITemplate(source, current), /refusing/);
    }
    const source = listing();
    source.runtimes[0].isAvailable = false;
    assert.throws(() => selectCITemplate(source, current), /unavailable/);
});
