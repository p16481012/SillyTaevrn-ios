import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { parse } = require('acorn');
const source = await fs.readFile(new URL('../../public/scripts/openai.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const names = ['getChatCompletionErrorMessage', 'tryParseStreamingError', 'checkQuotaError', 'checkModerationError'];
const functions = names.map(name => {
    const declaration = ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
        .find(node => node?.type === 'FunctionDeclaration' && node.id?.name === name);
    assert.ok(declaration, `Actual shipped function ${name} must be present`);
    return source.slice(declaration.start, declaration.end);
}).join('\n');

function actualParser() {
    const errors = [], information = [], popups = [];
    const context = vm.createContext({
        toastr: { error: (...args) => errors.push(args), info: (...args) => information.push(args) },
        renderTemplateAsync: async () => 'Generated quota fixture',
        Popup: { show: { text: (...args) => popups.push(args) } },
        t: strings => strings.join(''),
    });
    vm.runInContext(functions + '\nglobalThis.parseError = tryParseStreamingError;', context);
    return { parseError: context.parseError, errors, information, popups };
}

test('actual frontend streamed API errors propagate with the readable provider message', () => {
    const parser = actualParser();
    assert.throws(() => parser.parseError({ ok: true }, JSON.stringify({ type: 'error', error: { message: 'Fixture streamed error' } })), /Fixture streamed error/);
    assert.equal(parser.errors.length, 1);
    assert.equal(parser.errors[0][0], 'Fixture streamed error');
    assert.notEqual(parser.errors[0][0], '[object Object]');
});

test('quiet streamed requests still fail without showing a toast or quota popup', () => {
    const parser = actualParser();
    assert.throws(() => parser.parseError({ ok: true }, JSON.stringify({ error: { message: 'Quota fixture' }, quota_error: true }), { quiet: true }), /Quota fixture/);
    assert.deepEqual(parser.errors, []);
    assert.deepEqual(parser.popups, []);
});

test('quota failure propagates and preserves the existing quota popup', async () => {
    const parser = actualParser();
    assert.throws(() => parser.parseError({ ok: true }, JSON.stringify({ error: { message: 'Quota fixture' }, quota_error: true })), /Quota fixture/);
    await Promise.resolve();
    assert.equal(parser.popups.length, 1);
    assert.equal(parser.popups[0][0], 'Quota Error');
});

test('message, detail and HTTP fallback envelopes retain meaningful failure text', () => {
    for (const [body, message] of [
        [{ message: 'Fixture message' }, 'Fixture message'],
        [{ detail: 'Fixture detail' }, 'Fixture detail'],
        [{ detail: { error: { code: 'fixture_code' } } }, 'fixture_code'],
        [{ error: true }, 'Bad Gateway'],
    ]) {
        const parser = actualParser();
        assert.throws(() => parser.parseError({ ok: false, statusText: 'Bad Gateway' }, JSON.stringify(body)), error => error.message === message);
        assert.equal(parser.errors[0][0], message);
    }
});

test('non-JSON, null and successful delta frames are not reported as API errors', () => {
    const parser = actualParser();
    for (const decoded of [': heartbeat', '[DONE]', '{not json', 'null', JSON.stringify({ choices: [{ delta: { content: '안녕하세요 🙂' } }] })]) {
        assert.doesNotThrow(() => parser.parseError({ ok: true }, decoded));
    }
    assert.deepEqual(parser.errors, []);
});

test('moderation error keeps its information notice and fails the streamed generation', () => {
    const parser = actualParser();
    const body = { error: { message: 'Fixture requires moderation', metadata: { reasons: ['fixture'], flagged_input: 'Generated test text' } } };
    assert.throws(() => parser.parseError({ ok: true }, JSON.stringify(body)), /requires moderation/);
    assert.equal(parser.information.length, 1);
    assert.equal(parser.errors.length, 1);
});
