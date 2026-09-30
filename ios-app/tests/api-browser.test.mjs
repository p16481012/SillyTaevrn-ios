import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseAPIBrowserArguments } from '../scripts/validate-api-browser.mjs';

test('browser API CLI requires explicit executable/report paths and refuses external targets or unbounded deadlines', () => {
    const args = ['--chromium', path.resolve('chrome.exe'), '--host-node', process.execPath, '--report', path.resolve('generated-api-report.json')];
    assert.equal(parseAPIBrowserArguments(args).timeoutMs, 12000);
    assert.deepEqual(parseAPIBrowserArguments(['--help']), { help: true });
    assert.throws(() => parseAPIBrowserArguments(args.map(value => value === args[1] ? 'chrome.exe' : value)), /absolute/);
    assert.throws(() => parseAPIBrowserArguments([...args, '--base-url', 'https://example.com']), /Invalid/);
    assert.throws(() => parseAPIBrowserArguments([...args, '--timeout-ms', '0']), /Timeout/);
    assert.throws(() => parseAPIBrowserArguments([...args, '--chromium', args[1]]), /Invalid/);
    assert.throws(() => parseAPIBrowserArguments(args.slice(0, 4)), /absolute/);
});
