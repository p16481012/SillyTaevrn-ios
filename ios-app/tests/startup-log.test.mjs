import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStartupLogger, redactDiagnostic, redirectConsole } from '../nodejs-project/startup-log.mjs';

test('diagnostic redaction removes common authorization and secret formats', () => {
    const text = redactDiagnostic('Bearer example-token api_key="example-key" password=example-password sk-example-secret');
    for (const secret of ['example-token', 'example-key', 'example-password', 'sk-example-secret']) assert.ok(!text.includes(secret));
});

test('ordinary application console output never records prompt bodies or keys', () => {
    const original = Object.fromEntries(['log', 'info', 'debug', 'warn', 'error'].map(key => [key, console[key]]));
    const output = [];
    try {
        redirectConsole({ log: value => output.push(value) });
        console.log('private chat message');
        console.debug({ api_key: 'test-secret' });
        console.warn('provider body contains private chat');
        console.error(new Error('private provider response'));
        assert.equal(output.length, 2);
        assert.ok(!output.join('\n').includes('private'));
        assert.ok(!output.join('\n').includes('test-secret'));
    } finally {
        Object.assign(console, original);
    }
});

test('buffered log rotation bounds file count and each file size', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ios-log-'));
    try {
        const logger = createStartupLogger(directory, { maxBytes: 4096, maxFiles: 3 });
        for (let i = 0; i < 200; i++) logger.log(`${i}: ${'한글'.repeat(200)}`);
        logger.flush();
        const files = fs.readdirSync(directory);
        assert.ok(files.length <= 3);
        assert.ok(files.length > 1);
        for (const file of files) assert.ok(fs.statSync(path.join(directory, file)).size <= 4096);
        assert.match(fs.readFileSync(path.join(directory, 'startup.log'), 'utf8'), /199:/);
    } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
