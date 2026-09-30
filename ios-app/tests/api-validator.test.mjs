import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import fetch from 'node-fetch';
import { forwardFetchResponse } from '../../src/util.js';
import { createMockProvider, fixtureText } from '../scripts/api-mock-provider.mjs';
import { classifyHostFailure, parseArguments, parseSSE, requestHTTP, sanitizeHostDiagnostic, validateAPI } from '../scripts/validate-api.mjs';

const report = path.join(os.tmpdir(), 'st-generated-api-report.json');
const deploymentId = 'a'.repeat(64);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = (scenario, stream) => JSON.stringify({ model: `st-api-fixture:${scenario}:unit`, stream, messages: [{ role: 'user', content: 'generated fixture' }] });

test('API validator refuses remote/credentialed targets, wrong manifests, mixed modes and unbounded deadlines', () => {
    const args = ['--base-url', 'http://127.0.0.1:8000', '--deployment-id', deploymentId, '--report', report];
    assert.equal(parseArguments(args).baseURL, 'http://127.0.0.1:8000');
    for (const url of ['https://127.0.0.1:8000', 'http://example.com:8000', 'http://127.0.0.1:9000', 'http://user:password@127.0.0.1:8000', 'http://127.0.0.1:8000/api']) {
        assert.throws(() => parseArguments([args[0], url, ...args.slice(2)]));
    }
    assert.throws(() => parseArguments([...args, '--timeout-ms', '0']));
    assert.throws(() => parseArguments([...args, '--host-node', process.execPath]));
    assert.throws(() => parseArguments(['--base-url', args[1], '--deployment-id', 'wrong', '--report', report]));
    assert.throws(() => parseArguments(['--host-node', 'relative.exe', '--report', report]));
});

test('SSE parser distinguishes completion, provider error and malformed frames for both wire formats', () => {
    assert.deepEqual(parseSSE('data: {"choices":[{"delta":{"content":"안녕 🙂"}}]}\r\n\r\ndata: [DONE]\r\n\r\n', 'openai'), { content: '안녕 🙂', completed: true, failed: false, frames: 2 });
    assert.equal(parseSSE('event: error\ndata: {"type":"error","error":{"message":"fixture"}}\n\n', 'claude').failed, true);
    assert.equal(parseSSE('data: {"type":"content_block_delta","delta":{"text":"café"}}\n\ndata: {"type":"message_stop"}\n\n', 'claude').completed, true);
    assert.equal(parseSSE('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'openai').completed, false);
    assert.throws(() => parseSSE('data: invalid-json\n\n', 'openai'));
});

test('bounded startup diagnostics redact credentials and distinguish permissions, paths, and network failures', () => {
    const text = sanitizeHostDiagnostic('api_key=secret-value\nAuthorization: Bearer private-value\ngenerated-fixture-123abc-456def\n' + 'a'.repeat(9000));
    assert.ok(text.length <= 4096);
    assert.ok(!text.includes('secret-value') && !text.includes('private-value') && !text.includes('123abc'));
    assert.equal(classifyHostFailure({ code: 'EPERM', message: 'lstat failed' }), 'filesystem-permission');
    assert.equal(classifyHostFailure({ code: 'ENOENT', message: 'missing asset' }), 'filesystem-path-or-module');
    assert.equal(classifyHostFailure({ code: 'EADDRINUSE', message: 'port is owned by another process' }), 'network-or-port');
    assert.equal(classifyHostFailure({ message: 'Host exited' }, 'Error: operation not permitted'), 'filesystem-permission');
});

test('owned mock provider sends real split UTF8 HTTP bytes and protocol completion frames', async () => {
    const provider = await createMockProvider();
    try {
        for (const protocol of ['openai', 'claude']) {
            const response = await requestHTTP(provider.baseURL + (protocol === 'claude' ? '/messages' : '/chat/completions'), {
                body: body('success', true), headers: protocol === 'claude' ? { 'x-api-key': provider.credential } : { Authorization: `Bearer ${provider.credential}` },
            });
            const parsed = parseSSE(response.text, protocol);
            assert.equal(parsed.content, fixtureText); assert.equal(parsed.completed, true);
            assert.equal(provider.observations.get('st-api-fixture:success:unit').utf8Split, true);
        }
    } finally { await provider.close(); }
    await assert.rejects(requestHTTP(provider.baseURL, { timeoutMs: 500 }));
});

test('client cancellation after bytes and bounded timeout both close unfinished provider connections', async () => {
    const provider = await createMockProvider();
    try {
        for (const scenario of ['cancel', 'timeout']) {
            await assert.rejects(requestHTTP(`${provider.baseURL}/chat/completions`, {
                body: body(scenario, true), headers: { Authorization: `Bearer ${provider.credential}` },
                timeoutMs: scenario === 'timeout' ? 200 : 2000,
                onChunk: scenario === 'cancel' ? () => false : undefined,
            }));
            const observation = provider.observations.get(`st-api-fixture:${scenario}:unit`);
            const deadline = Date.now() + 1000;
            while (!observation.closed && Date.now() < deadline) await pause(10);
            assert.equal(observation.closed, true); assert.equal(observation.completed, false);
        }
    } finally { await provider.close(); }
});

test('invalid UTF8 is rejected instead of silently substituting corrupted streamed text', async () => {
    const server = http.createServer((_request, response) => response.end(Buffer.from([0xff])));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await assert.rejects(requestHTTP(`http://127.0.0.1:${server.address().port}`), /encoded data|encoding/i); }
    finally { await new Promise(resolve => server.close(resolve)); }
});

test('real fetch forwarding aborts a truncated upstream SSE body instead of waiting for the client deadline', async () => {
    const provider = await createMockProvider();
    const sockets = new Set();
    const server = http.createServer(async (request, response) => {
        const protocol = request.url === '/claude' ? 'claude' : 'openai';
        const upstream = await fetch(provider.baseURL + (protocol === 'claude' ? '/messages' : '/chat/completions'), {
            method: 'POST', body: body('disconnect-mid', true),
            headers: { 'Content-Type': 'application/json', ...(protocol === 'claude' ? { 'x-api-key': provider.credential } : { Authorization: `Bearer ${provider.credential}` }) },
        });
        await forwardFetchResponse(upstream, response);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const protocol of ['openai', 'claude']) {
            let received = false;
            await assert.rejects(requestHTTP(`http://127.0.0.1:${server.address().port}/${protocol}`, {
                timeoutMs: 1500, onChunk: () => { received = true; },
            }), error => error.code === 'ST_RESPONSE_ABORTED' || error.code === 'ECONNRESET');
            assert.equal(received, true, 'The interruption must happen after real streamed bytes arrive');
        }
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        await provider.close();
    }
});

test('mismatched real-backend deployment fails before any generation scenarios are counted', async () => {
    // This is only a guard unit test; it intentionally never claims runtime validation.
    const server = http.createServer((_request, response) => response.end(JSON.stringify({ ready: true, version: '1.19.0', deploymentId: 'b'.repeat(64) })));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const result = await validateAPI({ baseURL: `http://127.0.0.1:${server.address().port}`, deploymentId });
        assert.equal(result.status, 'failed'); assert.ok(result.error); assert.equal(result.scenarios.length, 0);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
