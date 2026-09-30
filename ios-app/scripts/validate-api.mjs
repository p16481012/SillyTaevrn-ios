#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMockProvider, fixtureText } from './api-mock-provider.mjs';
import { redactDiagnostic } from '../nodejs-project/startup-log.mjs';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashPattern = /^[a-f0-9]{64}$/;
export const usage = `Usage: node ios-app/scripts/validate-api.mjs
  --base-url http://127.0.0.1:8000 --deployment-id <manifest SHA256> --report </absolute/result.json>
  OR --host-node </absolute/Node18.exe> --report </absolute/result.json>
  [--timeout-ms 12000]
Only loopback HTTP endpoints are allowed. Uses real CSRF and chat-completions
routes with a generated credential and owned loopback mock provider. External
mode never starts/stops the app or changes files. Host mode owns an isolated
packaged runtime/data fixture and port8000; run it separately from startup smoke.
Timeout coverage is a client deadline/cancellation, not a server timeout policy.`;

export function parseArguments(args) {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    const result = { timeoutMs: 12000 };
    const names = { '--base-url': 'baseURL', '--deployment-id': 'deploymentId', '--host-node': 'hostNode', '--report': 'report', '--timeout-ms': 'timeoutMs' };
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]], value = args[index + 1];
        if (!name || seen.has(name) || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`);
        seen.add(name); result[name] = name === 'timeoutMs' ? Number(value) : value;
    }
    if (!path.isAbsolute(result.report ?? '') || !result.report.endsWith('.json')) throw new Error('An absolute JSON report path is required.');
    if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 2000 || result.timeoutMs > 60000) throw new Error('Timeout must be 2000..60000 milliseconds.');
    if (result.hostNode) {
        if (!path.isAbsolute(result.hostNode) || result.baseURL || result.deploymentId) throw new Error('Host executable must be absolute; host and external modes cannot be combined.');
    } else {
        const url = new URL(result.baseURL ?? '');
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
            || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port !== '8000') throw new Error('External base must be an uncredentialed loopback HTTP port8000 origin.');
        if (!hashPattern.test(result.deploymentId ?? '')) throw new Error('External mode requires the expected deployment ID.');
        result.baseURL = url.origin;
    }
    return result;
}

/** HTTP bytes are decoded incrementally, so a UTF-8 codepoint may span reads. */
export function requestHTTP(url, { body, headers = {}, timeoutMs = 12000, onChunk } = {}) {
    return new Promise((resolve, reject) => {
        let done = false, size = 0, text = '';
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const settle = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const request = http.request(url, { method: body === undefined ? 'GET' : 'POST', agent: false,
            headers: { ...headers, 'Accept-Encoding': 'identity', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } }, response => {
            response.on('data', chunk => {
                try {
                    size += chunk.length;
                    if (size > 131072) throw new Error('Response exceeds fixture limit');
                    text += decoder.decode(chunk, { stream: true });
                    if (onChunk?.(text) === false) request.destroy(Object.assign(new Error('User cancelled fixture request'), { code: 'ST_CLIENT_CANCELLED' }));
                } catch (error) { request.destroy(error); settle(error); }
            });
            response.on('aborted', () => settle(Object.assign(new Error('HTTP response was aborted before completion'), { code: 'ST_RESPONSE_ABORTED' })));
            response.on('error', error => settle(error));
            response.on('end', () => {
                try { text += decoder.decode(); settle(null, { status: response.statusCode, headers: response.headers, text, bytes: size }); }
                catch (error) { settle(error); }
            });
        });
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('Client deadline expired'), { code: 'ST_CLIENT_TIMEOUT' })), timeoutMs);
        request.on('error', error => settle(error));
        request.end(body);
    });
}

export function parseSSE(text, provider) {
    let content = '', completed = false, failed = false, frames = 0;
    for (const frame of text.replaceAll('\r\n', '\n').split('\n\n')) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        frames++;
        if (data === '[DONE]') { completed = true; continue; }
        const json = JSON.parse(data);
        failed ||= Boolean(json.error || json.type === 'error');
        if (provider === 'claude') { content += json.delta?.text ?? ''; completed ||= json.type === 'message_stop'; }
        else content += json.choices?.[0]?.delta?.content ?? '';
    }
    return { content, completed, failed, frames };
}

export function sanitizeHostDiagnostic(value) {
    return String(value).replace(/generated-fixture-[a-f0-9-]+/gi, '[redacted fixture]')
        .split('\n').map(line => redactDiagnostic(line)).join('\n').slice(-4096);
}

export function classifyHostFailure(error, diagnostics = '') {
    const text = `${error.code ?? ''} ${error.message ?? ''} ${diagnostics}`;
    // EPERM/EACCES alone cannot establish whether a sandbox or OS ACL caused it.
    if (/\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i.test(text)) return 'filesystem-permission';
    if (/\b(?:ENOENT|ENOTDIR|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|cannot find module/i.test(text)) return 'filesystem-path-or-module';
    if (/\b(?:EADDRINUSE|EADDRNOTAVAIL|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|connectex|blocked socket/i.test(text)) return 'network-or-port';
    return 'process-startup';
}

async function readDiagnosticTail(filename) {
    let file;
    try {
        file = await fs.open(filename, 'r');
        const size = (await file.stat()).size;
        const bytes = Buffer.alloc(Math.min(size, 8192));
        await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        return sanitizeHostDiagnostic(bytes.toString('utf8'));
    } catch (error) {
        return error.code === 'ENOENT' ? '' : `Diagnostic unavailable (${error.code ?? 'unknown'})`;
    } finally { await file?.close(); }
}

async function awaitClosed(observation, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!observation?.closed && Date.now() < deadline) await delay(20);
    assert.equal(observation?.closed, true, 'Provider connection must close within the bounded deadline');
    assert.equal(observation.completed, false, 'Cancellation must stop an unfinished upstream response');
}

export async function validateAPI({ baseURL, deploymentId, timeoutMs = 12000 }) {
    const report = { formatVersion: 1, status: 'failed', mode: 'external-backend', startedAt: new Date().toISOString(),
        expectedDeploymentId: deploymentId, scenarios: [], cleanup: {},
        limits: ['Mock providers; no real credentials or paid calls', 'Backend HTTP forwarding; does not assert frontend error rendering', 'Client deadline cancellation; server provider-timeout policy is not tested'] };
    let provider;
    try {
        const health = await requestHTTP(`${baseURL}/api/ios/health`, { timeoutMs });
        const ready = JSON.parse(health.text);
        assert.equal(health.status, 200); assert.equal(ready.ready, true); assert.equal(ready.version, '1.19.0'); assert.equal(ready.deploymentId, deploymentId);
        report.deploymentId = ready.deploymentId;
        const csrf = await requestHTTP(`${baseURL}/csrf-token`, { timeoutMs });
        assert.equal(csrf.status, 200);
        const token = JSON.parse(csrf.text).token;
        assert.ok(token && token !== 'disabled', 'CSRF protection must be enabled');
        const cookies = (csrf.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
        assert.ok(cookies, 'A real application session cookie is required');
        provider = await createMockProvider();
        for (const protocol of ['openai', 'claude']) {
            for (const [scenario, stream] of [['success', false], ['success', true], ['error-401', false], ['error-401', true], ['error-429', false], ['error-429', true], ['stream-error', true], ['disconnect-before', false], ['disconnect-mid', true], ['cancel', true], ['timeout', false]]) {
                const item = { provider: protocol, scenario, stream, status: 'failed' };
                report.scenarios.push(item);
                const model = `st-api-fixture:${scenario}:${randomUUID()}`;
                const payload = JSON.stringify({ chat_completion_source: protocol, reverse_proxy: provider.baseURL,
                    proxy_password: provider.credential, model, stream, messages: [{ role: 'user', content: 'Generated iOS API validation fixture' }], max_tokens: 32, temperature: 0.7 });
                let seenChunk = false;
                const started = Date.now();
                try {
                    let result, failure;
                    try {
                        result = await requestHTTP(`${baseURL}/api/backends/chat-completions/generate`, {
                            body: payload, headers: { Cookie: cookies, 'X-CSRF-Token': token },
                            timeoutMs: scenario === 'timeout' ? 500 : timeoutMs,
                            onChunk: scenario === 'cancel' ? () => { seenChunk = true; return false; } : undefined,
                        });
                    } catch (error) { failure = error; }
                    const observation = provider.observations.get(model);
                    assert.ok(observation, 'The shipped route must actually contact the owned provider');
                    assert.equal(observation.authMatched, true); assert.equal(observation.messagesReceived, true);
                    item.observation = { path: observation.path, authMatched: true, messagesReceived: true };
                    if (scenario === 'cancel' || scenario === 'timeout') {
                        assert.ok(failure, 'Cancelled/expired requests must not succeed');
                        if (scenario === 'cancel') assert.equal(seenChunk, true, 'Cancel only after real upstream bytes arrived');
                        else assert.equal(failure.code, 'ST_CLIENT_TIMEOUT');
                        await awaitClosed(observation, timeoutMs);
                        item.upstreamStopped = true; item.clientFailure = scenario;
                    } else if (scenario === 'disconnect-mid') {
                        assert.ok(failure && failure.code !== 'ST_CLIENT_TIMEOUT', 'A broken upstream SSE body must promptly fail the downstream connection, not hang until the client deadline');
                        item.clientFailure = 'interrupted-stream';
                    } else {
                        if (failure) throw failure;
                        item.httpStatus = result.status;
                        if (scenario === 'success') {
                            assert.equal(result.status, 200);
                            if (stream) {
                                const parsed = parseSSE(result.text, protocol);
                                assert.equal(parsed.content, fixtureText); assert.equal(parsed.completed, true); assert.equal(parsed.failed, false); assert.equal(observation.utf8Split, true);
                                item.utf8Preserved = true; item.completionMarker = true;
                            } else assert.equal(JSON.parse(result.text).choices?.[0]?.message?.content, fixtureText);
                        } else if (scenario.startsWith('error-')) {
                            const code = Number(scenario.slice(6)), error = JSON.parse(result.text);
                            // Preserve upstream ST's deliberate Basic-auth protection and nonstream error envelope contracts.
                            assert.equal(result.status, stream ? (code === 401 ? 400 : code) : (protocol === 'claude' ? 500 : 200));
                            assert.ok(error.error, 'API errors must remain explicitly marked; HTTP200 is not sufficient to call generation successful');
                            if (stream) assert.equal(error.error.message, `Fixture error ${code}`);
                            if (!stream && protocol === 'openai' && code === 429) assert.equal(error.quota_error, true);
                            item.explicitError = true; item.upstreamStatus = code;
                        } else if (scenario === 'stream-error') {
                            const parsed = parseSSE(result.text, protocol);
                            assert.equal(parsed.failed, true); assert.equal(parsed.completed, false); item.streamErrorPreserved = true;
                        } else if (scenario === 'disconnect-before') {
                            assert.equal(result.status, protocol === 'claude' ? 500 : 502); assert.ok(JSON.parse(result.text).error); item.explicitError = true;
                        }
                    }
                    const after = JSON.parse((await requestHTTP(`${baseURL}/api/ios/health`, { timeoutMs })).text);
                    assert.equal(after.ready, true); assert.equal(after.deploymentId, deploymentId, 'The same backend must survive each error');
                    item.status = 'passed';
                } catch (error) { item.error = error.message; }
                item.elapsedMs = Date.now() - started;
            }
        }
        report.status = report.scenarios.every(item => item.status === 'passed') ? 'passed' : 'failed';
    } catch (error) { report.error = error.message; }
    finally {
        if (provider) { await provider.close(); report.cleanup.mockProviderClosed = true; }
        report.finishedAt = new Date().toISOString();
    }
    return report;
}

export async function startHost(nodeExecutable) {
    const temporaryRoot = path.join(appDirectory, '.test-tmp');
    await fs.mkdir(temporaryRoot, { recursive: true });
    // Refuse to share a fixed port with another application or test.
    const reservation = http.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(8000, '127.0.0.1', resolve); });
    await new Promise(resolve => reservation.close(resolve));
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'api-'));
    const runtime = path.join(directory, 'runtime'), support = path.join(directory, 'support'), documents = path.join(directory, 'Documents');
    let child, closed, spawnError, nodeVersion, stderr = '', lastHealthFailure;
    const waitForClose = timeoutMs => new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        closed.then(() => { clearTimeout(timer); resolve(true); });
    });
    const stop = async () => {
        if (child && child.exitCode === null) child.kill();
        if (closed && !(await waitForClose(2000))) {
            child.kill('SIGKILL');
            if (!(await waitForClose(2000))) throw new Error('Owned host process did not stop; retaining its fixture for inspection.');
        }
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(temporaryRoot));
        await fs.rm(directory, { recursive: true, force: true });
    };
    try {
        await fs.cp(path.join(appDirectory, 'nodejs-project-deploy'), runtime, { recursive: true });
        await fs.mkdir(support); await fs.mkdir(documents);
        const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
        const config = path.join(support, 'st_config.json'), publicDirectory = path.join(appDirectory, 'ios', 'App', 'App', 'public');
        await fs.writeFile(config, JSON.stringify({ bundlePublicPath: publicDirectory, bundleServerRoot: path.join(publicDirectory, 'st-defaults'), documentsPath: documents, deploymentId: manifest.deploymentId }));
        const bootstrap = `if(!process.version.startsWith('v18.'))throw new Error('Host compatibility validation requires Node18');if(typeof WebAssembly!=='undefined')throw new Error('WASM must be disabled');process.send({validationNodeVersion:process.version});globalThis.Intl=undefined;await import(${JSON.stringify(pathToFileURL(path.join(runtime, 'server-ios.js')).href)});`;
        child = spawn(nodeExecutable, ['--jitless', '--input-type=module', '-e', bootstrap], { cwd: runtime,
            env: { ...process.env, ST_IOS_CONFIG_PATH: config, NODE_PATH: path.join(appDirectory, 'node_modules', '@choreruiz', 'capacitor-node-js', 'ios', 'Swift', 'builtin_modules') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192); });
        let serverReady = false;
        child.on('message', message => {
            if (typeof message?.validationNodeVersion === 'string') nodeVersion = message.validationNodeVersion;
            try { serverReady ||= message.channelName === 'EVENT_CHANNEL' && JSON.parse(message.channelMessage).eventName === 'serverReady'; } catch { /* Ignore other bridge events. */ }
        });
        child.once('error', error => { spawnError = error; });
        closed = new Promise(resolve => child.once('close', resolve));
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && child.exitCode === null && !spawnError) {
            try {
                const ready = JSON.parse((await requestHTTP('http://127.0.0.1:8000/api/ios/health', { timeoutMs: 500 })).text);
                if (nodeVersion?.startsWith('v18.') && serverReady && ready.ready && ready.deploymentId === manifest.deploymentId) return { baseURL: 'http://127.0.0.1:8000', deploymentId: manifest.deploymentId, nodeVersion, stop };
            } catch (error) { lastHealthFailure = { code: error.code ?? null, message: sanitizeHostDiagnostic(error.message) }; }
            await delay(100);
        }
        if (spawnError) throw spawnError;
        throw new Error(`Packaged host failed to initialize/announce readiness within45s (exit ${child.exitCode ?? 'unknown'}).`);
    } catch (error) {
        const stderrTail = sanitizeHostDiagnostic(stderr);
        const startupLogTail = await readDiagnosticTail(path.join(support, 'logs', 'startup.log'));
        error.hostDiagnostics = { failureClass: classifyHostFailure(error, stderrTail + startupLogTail),
            permissionCauseNotDetermined: classifyHostFailure(error, stderrTail + startupLogTail) === 'filesystem-permission',
            exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null,
            stderrTail, startupLogTail, lastHealthFailure };
        try { await stop(); error.hostDiagnostics.hostStopped = true; }
        catch (cleanupError) { error.hostDiagnostics.cleanupError = sanitizeHostDiagnostic(cleanupError.message); }
        throw error;
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) { console.log(usage); return; }
    let host, report;
    try {
        if (options.hostNode) host = await startHost(options.hostNode);
        report = await validateAPI({ ...options, ...host });
        report.mode = host ? 'packaged-host' : 'native-or-external-backend';
        if (host) report.runtime = { nodeExecutable: options.hostNode, nodeVersion: host.nodeVersion, jitless: true, nativeIntlRemoved: true, wasmDisabled: true };
    } catch (error) {
        report = { formatVersion: 1, status: 'failed', mode: options.hostNode ? 'packaged-host' : 'native-or-external-backend',
            error: sanitizeHostDiagnostic(error.message), failureClass: error.hostDiagnostics?.failureClass ?? classifyHostFailure(error),
            hostDiagnostics: error.hostDiagnostics, scenarios: [], cleanup: {} };
    }
    finally {
        if (host) {
            try { await host.stop(); report.cleanup.hostStopped = true; }
            catch (error) { report.status = 'failed'; report.cleanup.error = error.message; }
        }
    }
    await fs.mkdir(path.dirname(options.report), { recursive: true });
    await fs.writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, passed: report.scenarios.filter(item => item.status === 'passed').length, total: report.scenarios.length, report: options.report }));
    if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
