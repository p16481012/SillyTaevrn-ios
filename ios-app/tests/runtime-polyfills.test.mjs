import assert from 'node:assert/strict';
import test from 'node:test';
import { installRuntimePolyfills } from '../nodejs-project/runtime-polyfills.mjs';

test('no ICU fallback works as a function and constructor', () => {
    const runtime = {};
    installRuntimePolyfills(runtime);
    assert.equal(typeof runtime.Intl.Collator().compare, 'function');
    assert.deepEqual(['item10', 'item2', 'item1'].sort(new runtime.Intl.Collator('en', { numeric: true }).compare), ['item1', 'item2', 'item10']);
    assert.equal(runtime.Intl.Collator('en', { sensitivity: 'base' }).compare('TEST', 'test'), 0);
});

test('a real Intl implementation is preserved', () => {
    const runtime = { Intl };
    const original = runtime.Intl.Collator;
    installRuntimePolyfills(runtime);
    assert.equal(runtime.Intl.Collator, original);
});
