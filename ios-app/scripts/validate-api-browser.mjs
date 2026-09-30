#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMockProvider, fixtureText } from './api-mock-provider.mjs';
import { classifyHostFailure, requestHTTP, sanitizeHostDiagnostic, startHost } from './validate-api.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const usage = `Usage: node ios-app/scripts/validate-api-browser.mjs
  --chromium </absolute/chrome> --host-node </absolute/Node18> --report </absolute/result.json>
  [--timeout-ms 12000]
Uses the prepared Node18 JITless package on owned port8000, real onboarding and
APP_READY, and the actual imported frontend sendOpenAIRequest/generator pipeline.
No backend response interception or real provider keys. Run separately from other
port8000 checks. This is Chromium frontend-module coverage, not native WKWebView
or a full conversation started through the application's Send button.`;

export function parseAPIBrowserArguments(args) {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    const result = { timeoutMs: 12000 };
    const names = { '--chromium': 'chromium', '--host-node': 'hostNode', '--report': 'report', '--timeout-ms': 'timeoutMs' };
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]], value = args[index + 1];
        if (!name || seen.has(name) || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`);
        seen.add(name); result[name] = name === 'timeoutMs' ? Number(value) : value;
    }
    for (const name of ['chromium', 'hostNode', 'report']) if (!path.isAbsolute(result[name] ?? '')) throw new Error(`${name} must be an explicit absolute path.`);
    if (!result.report.endsWith('.json')) throw new Error('A JSON report path is required.');
    if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 2000 || result.timeoutMs > 60000) throw new Error('Timeout must be 2000..60000 milliseconds.');
    return result;
}

async function bounded(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Frontend operation exceeded its bounded deadline')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

/** Calls the shipped module without replacing its fetch, parser or UI notices. */
async function requestThroughFrontend(page, { scenario, stream, model, provider, timeoutMs }) {
    return bounded(page.evaluate(async ({ scenario, stream, model, baseURL, credential, timeoutMs }) => {
        const api = await import('/scripts/openai.js');
        const { eventSource, event_types } = await import('/scripts/events.js');
        const fields = {
            chat_completion_source: api.chat_completion_sources.OPENAI,
            openai_model: model, reverse_proxy: baseURL, proxy_password: credential,
            stream_openai: stream, openai_max_tokens: 32, n: 1,
            function_calling: false, enable_web_search: false, request_images: false,
        };
        const original = Object.fromEntries(Object.keys(fields).map(key => [key, api.oai_settings[key]]));
        Object.assign(api.oai_settings, fields);
        const controller = new AbortController();
        let expired = false, settingsReadyObserved = false, cancellationTriggered = false, chunks = 0, text = '';
        const observer = payload => {
            settingsReadyObserved = payload.model === model && payload.stream === stream
                && payload.reverse_proxy === baseURL && payload.proxy_password === credential;
        };
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, observer);
        const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
        try {
            const reply = await api.sendOpenAIRequest('normal', [{ role: 'user', content: 'Generated browser API validation fixture' }], controller.signal);
            if (stream) {
                if (typeof reply !== 'function') throw new Error('The real frontend must return its stream generator');
                for await (const chunk of reply()) {
                    chunks++; text = chunk.text;
                    if (scenario === 'cancel' && chunks === 1) {
                        cancellationTriggered = true;
                        controller.abort();
                    }
                }
            } else text = reply?.choices?.[0]?.message?.content ?? '';
            return { failed: false, text, chunks, settingsReadyObserved, cancellationTriggered, expired };
        } catch (error) {
            return { failed: true, text, chunks, settingsReadyObserved, cancellationTriggered, expired,
                errorName: error.name, errorMessage: String(error.message).slice(0, 400) };
        } finally {
            clearTimeout(timer);
            eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, observer);
            Object.assign(api.oai_settings, original);
        }
    }, { scenario, stream, model, baseURL: provider.baseURL, credential: provider.credential, timeoutMs }), timeoutMs + 5000);
}

export async function validateAPIBrowser({ host, chromiumPath, timeoutMs = 12000 }) {
    const report = { formatVersion: 1, mode: 'packaged-host-chromium-frontend-module', status: 'failed',
        startedAt: new Date().toISOString(), deploymentId: host.deploymentId, scenarios: [], cleanup: {},
        frontendModule: '/scripts/openai.js', entryPoint: 'sendOpenAIRequest',
        configuration: 'Temporary exported oai_settings fixture with generated credentials; real browser CSRF/session and proxy confirmation',
        limits: ['Actual imported frontend request/generator pipeline; not a Send-button conversation or saved-chat assertion',
            'Chromium with an observed iOS helper harness; not native WKWebView or iPhone verification',
            'Owned loopback OpenAI-compatible mock provider; no real provider, key, paid call or server timeout-policy assertion'] };
    let browser, provider, page;
    const httpResponses = new Map(), pageErrors = [], blockedExternalOrigins = new Set();
    try {
        const health = JSON.parse((await requestHTTP(`${host.baseURL}/api/ios/health`, { timeoutMs })).text);
        assert.equal(health.ready, true); assert.equal(health.version, '1.19.0'); assert.equal(health.deploymentId, host.deploymentId);
        const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
        browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--disable-background-networking'] });
        report.browserVersion = browser.version();
        page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' });
        page.setDefaultTimeout(timeoutMs);
        page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push(sanitizeHostDiagnostic(error.message)); });
        page.on('response', response => {
            if (new URL(response.url()).pathname !== '/api/backends/chat-completions/generate') return;
            try { httpResponses.set(response.request().postDataJSON().model, { httpStatus: response.status() }); } catch { /* Invalid requests fail the provider-observation assertion. */ }
        });
        // This guard only continues the real local backend or aborts external
        // traffic. It never fulfills or substitutes any application response.
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === host.baseURL) return route.continue();
            if (blockedExternalOrigins.size < 10) blockedExternalOrigins.add(url.origin);
            return route.abort();
        });
        await page.addInitScript(({ deploymentId, version }) => {
            window.__ST_IOS_APP__ = { deploymentId, version };
            window.__apiNativeHarness = { ready: [], errors: [], interactions: [] };
            window.webkit = { messageHandlers: {
                stReady: { postMessage: message => window.__apiNativeHarness.ready.push(message) },
                stError: { postMessage: message => window.__apiNativeHarness.errors.push(message) },
                stInteraction: { postMessage: message => window.__apiNativeHarness.interactions.push(message) },
            } };
        }, { deploymentId: host.deploymentId, version: health.version });
        await page.goto(host.baseURL + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.locator('#onboarding-persona-name:visible').waitFor({ timeout: 90000 });
        await page.waitForFunction(() => window.__apiNativeHarness.interactions.some(item => item.active === true), null, { timeout: 15000 });
        assert.notEqual(await page.evaluate(() => window.__ST_IOS_READY__), true, 'First-run input must precede actual app readiness');
        await page.locator('#onboarding-persona-name:visible').fill('Browser API validation user');
        await page.locator('#onboarding-confirm:visible').click();
        await page.waitForFunction(() => window.__ST_IOS_READY__ === true, null, { timeout: 90000 });
        const readiness = await page.evaluate(async () => {
            const { eventSource, event_types } = await import('/scripts/events.js');
            return { ready: window.__apiNativeHarness.ready, errors: window.__apiNativeHarness.errors,
                interactions: window.__apiNativeHarness.interactions.map(item => item.active),
                appReadyEventObserved: eventSource.autoFireLastArgs.has(event_types.APP_READY) };
        });
        assert.deepEqual(readiness.errors, []); assert.equal(readiness.ready.length, 1);
        assert.deepEqual(readiness.interactions, [true, false]); assert.equal(readiness.appReadyEventObserved, true);
        report.onboarding = { completedThroughVisibleControls: true, appReadyEventObserved: true,
            helperReadyMessages: 1, deploymentId: readiness.ready[0].deploymentId };
        assert.equal(readiness.ready[0].deploymentId, host.deploymentId);
        provider = await createMockProvider();
        let proxyConsentObserved = false;
        for (const [scenario, stream] of [['success', false], ['success', true], ['stream-error', true],
            ['error-401', true], ['error-401', false], ['error-429', true], ['error-429', false], ['disconnect-mid', true], ['cancel', true]]) {
            const item = { provider: 'openai', scenario, stream, status: 'failed' }, started = Date.now();
            report.scenarios.push(item);
            const model = `st-api-fixture:${scenario}:${randomUUID()}`;
            try {
                const evaluation = requestThroughFrontend(page, { scenario, stream, model, provider, timeoutMs });
                // Observe and approve the real proxy warning. Its normal
                // accountStorage handler remembers this generated proxy.
                evaluation.catch(() => {});
                if (!proxyConsentObserved) {
                    const confirmation = page.locator('dialog.popup[open]:not([closing])').filter({ hasText: 'Connecting To Proxy' });
                    await confirmation.waitFor({ state: 'visible' });
                    assert.ok((await confirmation.innerText()).includes(provider.baseURL));
                    await confirmation.locator('.popup-button-ok').click();
                    proxyConsentObserved = true;
                    report.proxyConsentThroughVisibleControls = true;
                }
                const outcome = await evaluation;
                assert.equal(outcome.settingsReadyObserved, true, 'The shipped frontend must build and emit the real generation parameters');
                assert.equal(outcome.expired, false, 'Client deadline expiry cannot masquerade as an expected API error');
                const observation = provider.observations.get(model);
                assert.ok(observation, 'The real frontend and shipped backend must contact the owned provider');
                assert.equal(observation.authMatched, true); assert.equal(observation.messagesReceived, true);
                const http = httpResponses.get(model);
                assert.ok(http, 'Record the actual generation HTTP response');
                item.httpStatus = http.httpStatus; item.settingsReadyObserved = true;
                if (scenario === 'success') {
                    assert.equal(outcome.failed, false); assert.equal(outcome.text, fixtureText); assert.equal(http.httpStatus, 200);
                    if (stream) { assert.ok(outcome.chunks > 0); assert.equal(observation.utf8Split, true); item.utf8Preserved = true; }
                    item.frontendReply = outcome.text;
                } else {
                    assert.equal(outcome.failed, true, 'Actual frontend generation must fail, not silently finish');
                    assert.ok(outcome.errorMessage && outcome.errorMessage !== '[object Object]');
                    item.frontendError = sanitizeHostDiagnostic(outcome.errorMessage); item.errorName = outcome.errorName;
                    if (scenario === 'cancel') {
                        assert.equal(outcome.cancellationTriggered, true); assert.ok(outcome.chunks > 0);
                        const deadline = Date.now() + timeoutMs;
                        while (!observation.closed && Date.now() < deadline) await delay(20);
                        assert.equal(observation.closed, true); assert.equal(observation.completed, false);
                        item.upstreamStopped = true;
                    } else if (scenario === 'disconnect-mid') {
                        assert.ok(outcome.chunks > 0); item.interruptedStreamFailed = true;
                    } else if (scenario === 'error-429' && !stream) {
                        assert.equal(http.httpStatus, 200); assert.equal(outcome.errorMessage, 'Too Many Requests');
                        const quota = page.locator('dialog.popup[open]:not([closing])').filter({ hasText: 'Quota Error' });
                        await quota.waitFor({ state: 'visible' });
                        assert.ok((await quota.innerText()).includes('Encountered an error while processing your request.'));
                        item.quotaPopupObserved = true;
                        await quota.locator('.popup-button-ok').click();
                        await quota.waitFor({ state: 'hidden' });
                    } else {
                        const expectedMessage = scenario === 'stream-error' ? 'Fixture streamed error'
                            : (!stream ? 'Unauthorized' : `Fixture error ${scenario.slice(6)}`);
                        assert.equal(outcome.errorMessage, expectedMessage);
                        assert.equal(http.httpStatus, scenario === 'stream-error' || !stream ? 200 : (scenario === 'error-401' ? 400 : 429));
                        await page.locator('.toast-error .toast-message').filter({ hasText: expectedMessage }).last().waitFor({ state: 'visible' });
                        item.errorToastObserved = true;
                    }
                }
                const after = JSON.parse((await requestHTTP(`${host.baseURL}/api/ios/health`, { timeoutMs })).text);
                assert.equal(after.ready, true); assert.equal(after.deploymentId, host.deploymentId);
                item.status = 'passed';
            } catch (error) {
                item.error = sanitizeHostDiagnostic(error.message);
                if (!proxyConsentObserved || error.message === 'Frontend operation exceeded its bounded deadline') {
                    item.elapsedMs = Date.now() - started;
                    break; // Do not overlap another request with an unresolved popup/generator.
                }
            }
            item.elapsedMs = Date.now() - started;
        }
        report.status = report.scenarios.every(item => item.status === 'passed') ? 'passed' : 'failed';
    } catch (error) { report.error = sanitizeHostDiagnostic(error.message); }
    finally {
        report.pageErrors = pageErrors; report.blockedExternalOrigins = [...blockedExternalOrigins];
        if (browser) {
            try { await bounded(browser.close(), 5000); report.cleanup.browserClosed = true; }
            catch (error) { report.status = 'failed'; report.cleanup.browserError = sanitizeHostDiagnostic(error.message); }
        }
        if (provider) {
            try { await provider.close(); report.cleanup.mockProviderClosed = true; }
            catch (error) { report.status = 'failed'; report.cleanup.providerError = sanitizeHostDiagnostic(error.message); }
        }
        report.finishedAt = new Date().toISOString();
    }
    return report;
}

async function main() {
    const options = parseAPIBrowserArguments(process.argv.slice(2));
    if (options.help) { console.log(usage); return; }
    let host, report;
    try {
        await fs.access(options.chromium); await fs.access(options.hostNode);
        host = await startHost(options.hostNode);
        report = await validateAPIBrowser({ host, chromiumPath: options.chromium, timeoutMs: options.timeoutMs });
        report.runtime = { nodeVersion: host.nodeVersion, jitless: true, wasmDisabled: true, nativeIntlRemoved: true };
    } catch (error) {
        report = { formatVersion: 1, mode: 'packaged-host-chromium-frontend-module', status: 'failed',
            error: sanitizeHostDiagnostic(error.message), failureClass: error.hostDiagnostics?.failureClass ?? classifyHostFailure(error),
            hostDiagnostics: error.hostDiagnostics, scenarios: [], cleanup: {} };
    } finally {
        if (host) {
            try { await host.stop(); report.cleanup.hostStopped = true; }
            catch (error) { report.status = 'failed'; report.cleanup.error = sanitizeHostDiagnostic(error.message); }
        }
    }
    await fs.mkdir(path.dirname(options.report), { recursive: true });
    await fs.writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, passed: report.scenarios.filter(item => item.status === 'passed').length,
        total: report.scenarios.length, report: options.report }));
    if (report.status !== 'passed') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(sanitizeHostDiagnostic(error.message)); process.exitCode = 1; });
