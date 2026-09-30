import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const iosDirectory = fileURLToPath(new URL('../', import.meta.url));
const deploy = path.join(iosDirectory, 'nodejs-project-deploy');
const publicDirectory = path.join(iosDirectory, 'ios', 'App', 'App', 'public');
const temporaryRoot = path.join(iosDirectory, '.test-tmp');
const nodeExecutable = process.env.ST_TEST_NODE || process.execPath;
const builtinModules = path.join(iosDirectory, 'node_modules', '@choreruiz', 'capacitor-node-js', 'ios', 'Swift', 'builtin_modules');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('packaged runtime starts without JIT/WASM/Intl and preserves settings and vectors across restart', { timeout: 120000 }, async () => {
    assert.ok(fs.existsSync(path.join(deploy, 'runtime-manifest.json')), 'Run npm run prepare:ios first');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'startup-'));
    const runtime = path.join(directory, 'runtime');
    const support = path.join(directory, 'support');
    const documents = path.join(directory, 'Documents');
    fs.cpSync(deploy, runtime, { recursive: true });
    fs.mkdirSync(support);
    fs.mkdirSync(documents);
    const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
    const configFile = path.join(support, 'st_config.json');
    fs.writeFileSync(configFile, JSON.stringify({
        bundlePublicPath: publicDirectory,
        bundleServerRoot: path.join(publicDirectory, 'st-defaults'),
        documentsPath: documents,
        deploymentId: manifest.deploymentId,
    }));
    const base = 'http://127.0.0.1:8000';
    let child;
    let childClosed;
    let cookie = '';
    let csrfToken = '';
    let bridgeMessages = [];

    async function stop() {
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
        if (childClosed) await childClosed;
        child = undefined;
    }

    async function start() {
        const script = `
            if (typeof WebAssembly !== 'undefined') throw new Error('WASM must be disabled');
            globalThis.Intl = undefined;
            await import(${JSON.stringify(pathToFileURL(path.join(runtime, 'server-ios.js')).href)});
        `;
        let stderr = '';
        child = spawn(nodeExecutable, ['--jitless', '--input-type=module', '-e', script], {
            cwd: runtime,
            env: { ...process.env, ST_IOS_CONFIG_PATH: configFile, NODE_PATH: builtinModules },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        bridgeMessages = [];
        child.on('message', message => bridgeMessages.push({
            channel: message.channelName, ...JSON.parse(message.channelMessage),
        }));
        child.stderr.on('data', data => { stderr += data; });
        childClosed = new Promise(resolve => child.once('close', resolve));
        const logFile = path.join(support, 'logs', 'startup.log');
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) break;
            try {
                const response = await fetch(base + '/api/ios/health', { signal: AbortSignal.timeout(1000) });
                const health = await response.json();
                if (response.status === 200 && health.ready && health.deploymentId === manifest.deploymentId) {
                    assert.equal(health.version, '1.19.0');
                    const token = await fetch(base + '/csrf-token');
                    csrfToken = (await token.json()).token;
                    assert.notEqual(csrfToken, 'disabled');
                    cookie = (token.headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/).map(value => value.split(';')[0].trim()).join('; ');
                    assert.ok(bridgeMessages.some(message => message.channel === 'APP_CHANNEL' && message.eventName === 'ready'), 'Native plugin must receive its engine-ready handshake');
                    assert.ok(bridgeMessages.some(message => message.channel === 'EVENT_CHANNEL' && message.eventName === 'serverReady'
                        && JSON.parse(message.eventMessage)[0].deploymentId === manifest.deploymentId), 'Native bridge must report the initialized deployment');
                    return;
                }
            } catch { /* wait for initialization */ }
            await delay(100);
        }
        const startupLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no startup log)';
        assert.fail(`Runtime did not start with ${nodeExecutable}: ${stderr}\n${startupLog}`);
    }

    async function post(route, body) {
        return fetch(base + route, { method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: cookie,
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    }

    try {
        await start();
        assert.equal((await fetch(base + '/')).status, 200);
        assert.equal((await fetch(base + '/lib.js')).status, 200);
        assert.equal((await fetch(base + '/css/ios-overrides.css')).status, 200);
        assert.equal((await post('/api/sd/comfy/workflows', {})).status, 200);
        const backgrounds = await post('/api/backgrounds/all', {});
        assert.equal(backgrounds.status, 200);
        assert.ok((await backgrounds.json()).images.length > 0, 'Default backgrounds must load without full-image color decoding');
        const blocked = await post('/api/vector/insert', { collectionId: 'smoke', source: 'transformers', items: [] });
        assert.equal(blocked.status, 501);

        const tokens = await post('/api/tokenizers/openai/encode?model=gpt-4o', { text: '안녕하세요 🙂' });
        assert.equal(tokens.status, 200);
        const encoded = await tokens.json();
        assert.ok(encoded.ids.length > 0);
        const decoded = await post('/api/tokenizers/openai/decode?model=gpt-4o', { ids: encoded.ids });
        assert.equal((await decoded.json()).text, '안녕하세요 🙂');

        const vectorBody = { collectionId: 'smoke', source: 'webllm', embeddings: { hello: [1, 0] } };
        const inserted = await post('/api/vector/insert', { ...vectorBody, items: [{ hash: 123, text: 'hello', index: 0 }] });
        assert.equal(inserted.status, 200, await inserted.text());
        const saved = await post('/api/vector/list', vectorBody);
        assert.deepEqual(await saved.json(), [123]);

        const userConfig = path.join(documents, 'SillyTavern', 'config.yaml');
        fs.appendFileSync(userConfig, '\nsmokeSentinel: preserved\n');

        if (process.env.ST_BROWSER_SMOKE === '1') {
            const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
            const browser = await chromium.launch({ executablePath: process.env.ST_CHROMIUM_PATH || undefined, headless: true });
            try {
                const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
                const browserErrors = [];
                const browserLog = [];
                const pendingRequests = new Set();
                page.on('pageerror', error => browserErrors.push(error.message));
                page.on('console', message => {
                    browserLog.push(message.text());
                    if (browserLog.length > 40) browserLog.shift();
                    if (message.type() === 'error') browserErrors.push(message.text());
                });
                page.on('request', request => pendingRequests.add(request));
                page.on('requestfinished', request => pendingRequests.delete(request));
                page.on('requestfailed', request => pendingRequests.delete(request));
                page.on('response', response => { if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
                await page.route('**/*', route => {
                    const url = new URL(route.request().url());
                    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
                });
                await page.addInitScript(({ deploymentId, version }) => {
                    window.__ST_IOS_APP__ = { deploymentId, version };
                    window.__smokeReady = [];
                    window.__smokeErrors = [];
                    window.__smokeInteractions = [];
                    window.webkit = { messageHandlers: {
                        stReady: { postMessage: message => window.__smokeReady.push(message) },
                        stError: { postMessage: message => window.__smokeErrors.push(message) },
                        stInteraction: { postMessage: message => window.__smokeInteractions.push(message) },
                    } };
                }, { deploymentId: manifest.deploymentId, version: manifest.applicationVersion });
                await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
                await page.locator('.popup-input:visible').fill('iOS smoke user');
                await page.waitForFunction(() => window.__smokeInteractions.some(message => message.active === true), null, { timeout: 10000 });
                assert.notEqual(await page.evaluate(() => window.__ST_IOS_READY__), true, 'Onboarding must not declare APP_READY');
                await page.locator('.popup-button-ok:visible').click();
                try {
                    await page.waitForFunction(() => window.__ST_IOS_READY__ === true, null, { timeout: 30000 });
                } catch (error) {
                    if (process.env.ST_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.ST_SMOKE_SCREENSHOT });
                    const state = await page.evaluate(async () => {
                        const { eventSource } = await import('/scripts/events.js');
                        return {
                            ready: window.__smokeReady, errors: window.__smokeErrors, interactions: window.__smokeInteractions,
                            cachedEvents: [...eventSource.autoFireLastArgs.keys()],
                        };
                    });
                    throw new Error(`Frontend readiness failed: ${error.message}\n${JSON.stringify({
                        browserErrors, browserLog, state, pending: [...pendingRequests].map(request => request.url()),
                    })}\n${await page.locator('body').innerText()}`);
                }
                assert.deepEqual(await page.evaluate(() => window.__smokeErrors), []);
                assert.equal((await page.evaluate(() => window.__smokeReady)).length, 1);
                assert.deepEqual((await page.evaluate(() => window.__smokeInteractions)).map(message => message.active), [true, false]);
                assert.equal(await page.locator('body.st-ios').count(), 1);
                await page.locator('#leftNavDrawerIcon').click();
                const range = page.locator('#amount_gen');
                await range.waitFor({ state: 'visible' });
                assert.equal(await range.evaluate(element => getComputedStyle(element).touchAction), 'none');
                const oldValue = await range.inputValue();
                const bounds = await range.boundingBox();
                assert.ok(bounds, 'The visible slider must have a bounding box');
                // Locator tap waits for the drawer animation and hit target to be
                // stable while still dispatching a real touchscreen interaction.
                await range.tap({ position: { x: bounds.width * 0.8, y: bounds.height / 2 } });
                await page.waitForFunction(previousValue => {
                    const slider = document.querySelector('#amount_gen');
                    const counter = document.querySelector('#amount_gen_counter');
                    return slider && counter && slider.value !== previousValue && counter.value === slider.value;
                }, oldValue, { timeout: 10000 });
                assert.notEqual(await range.inputValue(), oldValue, 'A touch must change the slider value');
                assert.equal(await page.locator('#amount_gen_counter').inputValue(), await range.inputValue());
                if (process.env.ST_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.ST_SMOKE_SCREENSHOT });
            } finally {
                await browser.close();
            }
        }

        await stop();
        await start();
        assert.match(fs.readFileSync(userConfig, 'utf8'), /smokeSentinel: preserved/);
        const restored = await post('/api/vector/list', vectorBody);
        assert.deepEqual(await restored.json(), [123]);
    } finally {
        await stop();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(temporaryRoot));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
