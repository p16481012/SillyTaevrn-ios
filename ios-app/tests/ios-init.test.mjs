import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const expected = { deploymentId: 'a'.repeat(64), version: '1.19.0' };
const flush = () => new Promise(resolve => setImmediate(resolve));

class EventTargetStub {
    listeners = new Map();
    addEventListener(name, callback, options = {}) {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push({ callback, once: options.once });
        this.listeners.set(name, listeners);
    }
    emit(name, event = {}) {
        const listeners = this.listeners.get(name) ?? [];
        this.listeners.set(name, listeners.filter(listener => !listener.once));
        for (const { callback } of listeners) callback(event);
    }
}

async function environment({ native = expected, origin = 'http://localhost:8000', health = { ready: true, ...expected }, status = 200, lateReady = false, lateInteraction, width = 400, height = 800, visualViewport = true } = {}) {
    const window = new EventTargetStub();
    const document = new EventTargetStub();
    const classes = new Set();
    const rootClasses = new Set();
    const styles = new Map();
    const styleWrites = [];
    const rootScrolls = [];
    const stylesheets = [];
    const messages = [];
    const fetches = [];
    window.__ST_IOS_APP__ = native;
    window.Capacitor = {}; // Its presence alone must not enable iOS behavior.
    window.innerHeight = height;
    window.innerWidth = width;
    window.scrollX = 0;
    window.scrollY = 0;
    window.scrollTo = (left, top) => {
        rootScrolls.push({ left, top });
        window.scrollX = left;
        window.scrollY = top;
    };
    window.visualViewport = visualViewport
        ? Object.assign(new EventTargetStub(), { width, height, offsetTop: 0, offsetLeft: 0, scale: 1 })
        : undefined;
    window.webkit = { messageHandlers: {
        stReady: { postMessage: body => messages.push({ type: 'ready', body }) },
        stError: { postMessage: body => messages.push({ type: 'error', body }) },
        stInteraction: { postMessage: body => messages.push({ type: 'interaction', body }) },
    } };
    document.hidden = false;
    document.body = { classList: {
        add: name => classes.add(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    } };
    document.documentElement = {
        classList: { add: name => rootClasses.add(name) },
        style: { setProperty: (name, value) => {
            styles.set(name, value);
            styleWrites.push({ name, value });
        } },
    };
    document.createElement = () => new EventTargetStub();
    document.head = { appendChild: element => stylesheets.push(element) };
    const location = new URL(origin);
    const context = vm.createContext({
        window, document, location, URL, AbortController, setTimeout, clearTimeout,
        requestAnimationFrame: callback => { callback(); return 1; },
        cancelAnimationFrame: () => {},
        localStorage: { getItem: () => null },
        console: { debug() {}, error() {}, trace() {} },
        fetch: async (url, options) => {
            fetches.push({ url, options });
            return { status, url: `${origin}/api/ios/health`, json: async () => health };
        },
    });
    const modules = new Map();
    async function moduleAt(filename) {
        if (modules.has(filename)) return modules.get(filename);
        const module = new vm.SourceTextModule(await readFile(filename, 'utf8'), { context, identifier: filename });
        modules.set(filename, module);
        await module.link((specifier, parent) => moduleAt(path.resolve(path.dirname(parent.identifier), specifier)));
        return module;
    }
    const main = await moduleAt(path.join(repository, 'public/scripts/ios-init.js'));
    const events = modules.get(path.join(repository, 'public/scripts/events.js'));
    if (lateReady || typeof lateInteraction === 'boolean') {
        await events.evaluate();
        if (lateReady) await events.namespace.eventSource.emit(events.namespace.event_types.APP_READY);
        if (typeof lateInteraction === 'boolean') {
            await events.namespace.eventSource.emit(events.namespace.event_types.APP_INITIALIZATION_INTERACTION, { active: lateInteraction, reason: 'onboarding' });
        }
    }
    await main.evaluate();
    return {
        window, document, stylesheets, classes, rootClasses, styles, styleWrites, rootScrolls, messages, fetches,
        appReady: () => events.namespace.eventSource.emit(events.namespace.event_types.APP_READY),
        interaction: active => events.namespace.eventSource.emit(events.namespace.event_types.APP_INITIALIZATION_INTERACTION, { active, reason: 'onboarding' }),
    };
}

test('desktop and Android Capacitor localhost sessions remain unchanged without a native marker', async () => {
    const env = await environment({ native: null });
    await env.interaction(true);
    await env.interaction(false);
    await env.appReady();
    await flush();
    assert.equal(env.classes.size, 0);
    assert.equal(env.rootClasses.size, 0);
    assert.equal(env.stylesheets.length, 0);
    assert.equal(env.fetches.length, 0);
    assert.equal(env.messages.length, 0);
});

test('a native marker is ignored outside the embedded local server origin', async () => {
    const env = await environment({ origin: 'https://example.com' });
    await env.appReady();
    await flush();
    assert.equal(env.stylesheets.length, 0);
    assert.equal(env.messages.length, 0);
});

test('APP_READY and stylesheet loading must both complete before matching health can announce readiness', async () => {
    const env = await environment();
    await env.appReady();
    await flush();
    assert.equal(env.messages.length, 0);
    assert.equal(env.fetches.length, 0);
    env.stylesheets[0].emit('load');
    await flush();
    assert.equal(env.fetches.length, 1);
    assert.equal(env.fetches[0].options.cache, 'no-store');
    assert.equal(env.messages.length, 1);
    assert.equal(env.messages[0].type, 'ready');
    assert.equal(env.messages[0].body.deploymentId, expected.deploymentId);
    assert.equal(env.messages[0].body.version, expected.version);
    assert.equal(env.window.__ST_IOS_READY__, true);
});

test('a helper loaded after APP_READY receives the real cached upstream event', async () => {
    const env = await environment({ lateReady: true });
    env.stylesheets[0].emit('load');
    await flush();
    assert.equal(env.messages[0]?.type, 'ready');
});

test('first-run onboarding requests input without announcing readiness, then resumes waiting for APP_READY', async () => {
    const env = await environment();
    env.stylesheets[0].emit('load');
    await env.interaction(true);
    await flush();
    assert.equal(env.messages.length, 1);
    assert.equal(env.messages[0].type, 'interaction');
    assert.equal(env.messages[0].body.active, true);
    assert.equal(env.messages[0].body.reason, 'onboarding');
    assert.equal(env.messages[0].body.deploymentId, expected.deploymentId);
    assert.equal(env.messages[0].body.version, expected.version);
    assert.equal(env.window.__ST_IOS_INTERACTION__, true);
    assert.notEqual(env.window.__ST_IOS_READY__, true);
    assert.equal(env.fetches.length, 0);

    await env.interaction(false);
    await flush();
    assert.equal(env.window.__ST_IOS_INTERACTION__, false);
    assert.notEqual(env.window.__ST_IOS_READY__, true);
    assert.equal(env.fetches.length, 0);
    await env.appReady();
    await flush();
    assert.deepEqual(env.messages.map(message => message.type), ['interaction', 'interaction', 'ready']);
    assert.equal(env.messages[1].body.active, false);
    assert.equal(env.window.__ST_IOS_READY__, true);
});

test('a late helper sees the current onboarding interaction instead of hiding a pending user prompt', async () => {
    const env = await environment({ lateInteraction: true });
    assert.equal(env.window.__ST_IOS_INTERACTION__, true);
    env.stylesheets[0].emit('load');
    await flush();
    assert.equal(env.messages[0]?.type, 'interaction');
    assert.equal(env.messages[0].body.active, true);
    assert.notEqual(env.window.__ST_IOS_READY__, true);
});

test('a stale backend deployment cannot dismiss the native startup overlay', async () => {
    const env = await environment({ health: { ready: true, ...expected, deploymentId: 'b'.repeat(64) } });
    env.stylesheets[0].emit('load');
    await env.appReady();
    await flush();
    assert.equal(env.messages.length, 1);
    assert.equal(env.messages[0].type, 'error');
    assert.match(env.messages[0].body.message, /do not match/);
    assert.notEqual(env.window.__ST_IOS_READY__, true);
});

test('HTTP errors and a backend still initializing are errors, rather than frontend readiness', async () => {
    for (const options of [{ status: 404 }, { health: { ready: false, ...expected } }]) {
        const env = await environment(options);
        env.stylesheets[0].emit('load');
        await env.appReady();
        await flush();
        assert.equal(env.messages[0]?.type, 'error');
        assert.notEqual(env.window.__ST_IOS_READY__, true);
    }
});

test('missing CSS reports a useful error and never announces readiness', async () => {
    const env = await environment();
    env.stylesheets[0].emit('error');
    await env.appReady();
    await flush();
    assert.equal(env.messages[0]?.type, 'error');
    assert.match(env.messages[0].body.message, /stylesheet/);
    assert.equal(env.fetches.length, 0);
});

test('keyboard viewport changes update layout; pinch zoom does not shrink it', async () => {
    const env = await environment();
    env.window.visualViewport.height = 450;
    env.window.visualViewport.emit('resize');
    assert.equal(env.styles.get('--st-viewport-height'), '450px');
    assert.equal(env.classes.has('st-ios-keyboard'), true);
    env.window.visualViewport.scale = 2;
    env.window.visualViewport.emit('resize');
    assert.equal(env.styles.get('--st-viewport-height'), '800px');
    assert.equal(env.classes.has('st-ios-keyboard'), false);
});

test('a focused-field viewport pan updates modal bounds without another resize', async () => {
    const env = await environment({ width: 402, height: 874 });
    Object.assign(env.window.visualViewport, { height: 391, width: 380, offsetTop: 80, offsetLeft: 12 });
    env.window.visualViewport.emit('scroll');
    assert.equal(env.styles.get('--st-viewport-height'), '391px');
    assert.equal(env.styles.get('--st-viewport-width'), '380px');
    assert.equal(env.styles.get('--st-viewport-offset-top'), '80px');
    assert.equal(env.styles.get('--st-viewport-offset-left'), '12px');
    assert.equal(env.styles.get('--st-viewport-inset-bottom'), '403px');
    assert.equal(env.styles.get('--st-viewport-inset-right'), '10px');
    assert.equal(env.classes.has('st-ios-keyboard'), true);

    env.window.visualViewport.scale = 2;
    env.window.visualViewport.emit('scroll');
    assert.equal(env.styles.get('--st-viewport-height'), '874px');
    assert.equal(env.styles.get('--st-viewport-width'), '402px');
    for (const side of ['offset-top', 'offset-left', 'inset-bottom', 'inset-right']) {
        assert.equal(env.styles.get(`--st-viewport-${side}`), '0px');
    }
    assert.equal(env.classes.has('st-ios-keyboard'), false);
});

test('without the visual viewport API layout changes and resume still use window bounds', async () => {
    const env = await environment({ visualViewport: false });
    env.window.innerHeight = 360;
    env.window.innerWidth = 800;
    env.window.emit('resize');
    assert.equal(env.styles.get('--st-viewport-height'), '360px');
    assert.equal(env.styles.get('--st-viewport-width'), '800px');
    assert.equal(env.styles.get('--st-viewport-offset-top'), '0px');
    assert.equal(env.styles.get('--st-viewport-inset-bottom'), '0px');
    env.window.innerHeight = 800;
    env.window.innerWidth = 400;
    env.window.__ST_IOS_RESUME__();
    assert.equal(env.styles.get('--st-viewport-height'), '800px');
    assert.equal(env.styles.get('--st-viewport-width'), '400px');
});

test('unzoomed root pan is restored without repeated CSS writes; pinch zoom panning is preserved', async () => {
    const env = await environment();
    const initialWrites = env.styleWrites.length;
    env.window.scrollY = 403;
    env.window.emit('scroll');
    assert.deepEqual(env.rootScrolls, [{ left: 0, top: 0 }]);
    assert.equal(env.styleWrites.length, initialWrites);
    env.window.emit('scroll');
    env.window.visualViewport.emit('scroll');
    assert.equal(env.rootScrolls.length, 1);
    assert.equal(env.styleWrites.length, initialWrites, 'Unchanged measurements cannot keep invalidating viewport styles.');
    env.window.visualViewport.scale = 2;
    env.window.scrollX = 50;
    env.window.scrollY = 200;
    env.window.emit('scroll');
    assert.equal(env.window.scrollX, 50);
    assert.equal(env.window.scrollY, 200);
    assert.equal(env.rootScrolls.length, 1);
    env.window.visualViewport.scale = 1;
    env.window.visualViewport.emit('resize');
    assert.deepEqual(env.rootScrolls, [{ left: 0, top: 0 }, { left: 0, top: 0 }]);
});

// This optional browser fixture renders the real upstream popup/onboarding HTML
// and CSS with the helper's measured bounds. It simulates keyboard geometry, not
// a native keyboard or application readiness; XCUITest covers real WKWebView.
test('rendered onboarding keeps its input and Save inside keyboard, pan and safe-area bounds', {
    skip: process.env.ST_CHROMIUM_PATH ? false : 'Set ST_CHROMIUM_PATH to run the rendered popup geometry fixture.',
    timeout: 30000,
}, async () => {
    const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
    const browser = await chromium.launch({ executablePath: process.env.ST_CHROMIUM_PATH, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
        // Keep the fixture self-contained; it never starts or contacts a server.
        await page.route('**/*', route => route.abort());
        const sources = await Promise.all([
            'public/lib/dialog-polyfill.css',
            'public/css/popup-safari-fix.css',
            'public/css/popup.css',
            'public/style.css',
            'public/css/mobile-styles.css',
            'public/css/ios-overrides.css',
            'public/index.html',
        ].map(filename => readFile(path.join(repository, filename), 'utf8')));
        const html = sources.pop();
        const korean = JSON.parse(await readFile(path.join(repository, 'public/locales/ko-kr.json'), 'utf8'));
        const css = sources.map(source => source.replace(/^@import[^;]+;/gm, '')).join('\n');
        await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="safari"></body></html>`);
        await page.evaluate(html => {
            const source = new DOMParser().parseFromString(html, 'text/html');
            const popup = source.querySelector('#popup_template').content.querySelector('.popup').cloneNode(true);
            popup.id = 'geometry-popup';
            popup.classList.add('wider_dialogue_popup');
            popup.querySelector('.popup-content').replaceChildren(source.querySelector('#onboarding_template .onboarding').cloneNode(true));
            for (const selector of ['.popup-crop-wrap', '.popup-inputs', '.popup-button-cancel', '.popup-button-close']) {
                popup.querySelector(selector).style.display = 'none';
            }
            popup.querySelector('.popup-input').setAttribute('aria-label', 'Persona name');
            popup.querySelector('.popup-button-ok').textContent = 'Save';
            popup.querySelector('.popup-button-ok').dataset.i18n = 'Save';
            document.body.appendChild(popup);
            popup.showModal();
        }, html);
        const originalSave = await page.locator('.popup-button-ok').boundingBox();
        assert.ok(originalSave.y + originalSave.height > 471, 'The upstream layout reproduces the input/Save below the keyboard.');

        const scenarios = [
            { name: 'portrait keyboard', width: 402, height: 874, visual: { width: 402, height: 471, offsetTop: 0, offsetLeft: 0 }, safe: { top: 62, left: 0, right: 0, bottom: 34 }, scroll: true },
            { name: 'focused-field pan', width: 402, height: 874, visual: { width: 380, height: 391, offsetTop: 80, offsetLeft: 12 }, safe: { top: 62, left: 0, right: 0, bottom: 34 }, scroll: true },
            { name: 'landscape keyboard', width: 874, height: 402, visual: { width: 874, height: 250, offsetTop: 12, offsetLeft: 0 }, safe: { top: 0, left: 59, right: 59, bottom: 21 }, scroll: true },
            { name: 'keyboard dismissed', width: 402, height: 874, visual: { width: 402, height: 874, offsetTop: 0, offsetLeft: 0 }, safe: { top: 62, left: 0, right: 0, bottom: 34 } },
            { name: 'small iPhone keyboard', width: 375, height: 667, visual: { width: 375, height: 321, offsetTop: 0, offsetLeft: 0 }, safe: { top: 20, left: 0, right: 0, bottom: 0 }, scroll: true },
            { name: 'iPad portrait keyboard', width: 820, height: 1180, visual: { width: 820, height: 755, offsetTop: 0, offsetLeft: 0 }, safe: { top: 24, left: 0, right: 0, bottom: 20 } },
            { name: 'iPad landscape keyboard', width: 1180, height: 820, visual: { width: 1180, height: 430, offsetTop: 0, offsetLeft: 0 }, safe: { top: 24, left: 0, right: 0, bottom: 20 }, scroll: true },
            { name: 'Korean small iPhone keyboard', width: 375, height: 667, visual: { width: 375, height: 321, offsetTop: 0, offsetLeft: 0 }, safe: { top: 20, left: 0, right: 0, bottom: 0 }, scroll: true, korean: true },
        ];
        for (const scenario of scenarios) {
            const env = await environment({ width: scenario.width, height: scenario.height });
            Object.assign(env.window.visualViewport, scenario.visual);
            env.window.visualViewport.emit('scroll');
            await page.setViewportSize({ width: scenario.width, height: scenario.height });
            const bottomInset = env.classes.has('st-ios-keyboard') ? 0 : scenario.safe.bottom;
            await page.evaluate(({ styles, classes, safe, bottomInset, locale }) => {
                document.body.className = ['safari', ...classes].join(' ');
                for (const [name, value] of styles) document.documentElement.style.setProperty(name, value);
                for (const side of ['top', 'left', 'right']) document.body.style.setProperty(`--st-safe-${side}`, `${safe[side]}px`);
                document.body.style.setProperty('--st-safe-bottom', `${bottomInset}px`);
                document.querySelector('.popup-content').scrollTop = 0;
                // This is only a geometry fixture using shipped translations;
                // the actual language selector/reload is covered by XCUITest.
                if (locale) {
                    for (const element of document.querySelectorAll('.popup [data-i18n]')) {
                        const key = element.getAttribute('data-i18n');
                        if (Object.hasOwn(locale, key)) element.textContent = locale[key];
                    }
                }
            }, { styles: [...env.styles], classes: [...env.classes], safe: scenario.safe, bottomInset, locale: scenario.korean ? korean : null });
            const geometry = await page.evaluate(() => {
                const rectangle = selector => {
                    const bounds = document.querySelector(selector).getBoundingClientRect();
                    return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, height: bounds.height };
                };
                const content = document.querySelector('.popup-content');
                return {
                    dialog: rectangle('.popup'), input: rectangle('.popup-input'), save: rectangle('.popup-button-ok'),
                    heading: rectangle('.onboarding > h3'),
                    scrollable: content.scrollHeight > content.clientHeight,
                    overflowY: getComputedStyle(content).overflowY,
                    inputShrink: getComputedStyle(document.querySelector('.popup-input')).flexShrink,
                    controlsShrink: getComputedStyle(document.querySelector('.popup-controls')).flexShrink,
                };
            });
            const visible = {
                top: scenario.visual.offsetTop + scenario.safe.top + 12,
                bottom: scenario.visual.offsetTop + scenario.visual.height - bottomInset - 12,
                left: scenario.visual.offsetLeft + scenario.safe.left + 12,
                right: scenario.visual.offsetLeft + scenario.visual.width - scenario.safe.right - 12,
            };
            for (const [name, bounds] of Object.entries({ dialog: geometry.dialog, input: geometry.input, save: geometry.save })) {
                assert.ok(bounds.top >= visible.top - 1 && bounds.bottom <= visible.bottom + 1, `${scenario.name}: ${name} stays above the keyboard and below the safe top: ${JSON.stringify({ bounds, visible })}`);
                assert.ok(bounds.left >= visible.left - 1 && bounds.right <= visible.right + 1, `${scenario.name}: ${name} respects horizontal viewport/safe-area bounds.`);
            }
            assert.ok(geometry.input.height >= 24, `${scenario.name}: the input retains a usable height.`);
            assert.ok(geometry.save.height >= 24, `${scenario.name}: Save retains a usable height.`);
            assert.ok(geometry.heading.top >= visible.top && geometry.heading.bottom <= geometry.input.top, `${scenario.name}: the welcome heading remains readable inside the content area.`);
            if (scenario.korean) {
                assert.equal(await page.locator('.onboarding > h3[data-i18n="Welcome to SillyTavern!"]').textContent(), korean['Welcome to SillyTavern!']);
                assert.equal(await page.locator('.popup-button-ok').textContent(), korean.Save);
            }
            assert.equal(geometry.inputShrink, '0');
            assert.equal(geometry.controlsShrink, '0');
            if (scenario.scroll) {
                assert.equal(geometry.overflowY, 'auto');
                assert.equal(geometry.scrollable, true, `${scenario.name}: long onboarding instructions can scroll.`);
                const scrollTop = await page.locator('.popup-content').evaluate(content => {
                    content.scrollTop = content.scrollHeight;
                    return content.scrollTop;
                });
                assert.ok(scrollTop > 0, `${scenario.name}: instruction scrolling actually moves the content.`);
            }
        }
    } finally {
        await browser.close();
    }
});

test('rendered chat input uses the configured text size without inheriting its surrounding icon size', {
    skip: process.env.ST_CHROMIUM_PATH ? false : 'Set ST_CHROMIUM_PATH to run the rendered chat-input geometry fixture.',
    timeout: 30000,
}, async () => {
    const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
    const browser = await chromium.launch({ executablePath: process.env.ST_CHROMIUM_PATH, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
        await page.route('**/*', route => route.abort());
        const [html, upstream, mobile, ios] = await Promise.all([
            'public/index.html', 'public/style.css', 'public/css/mobile-styles.css', 'public/css/ios-overrides.css',
        ].map(filename => readFile(path.join(repository, filename), 'utf8')));
        const css = [upstream, mobile].map(source => source.replace(/^@import[^;]+;/gm, '')).join('\n');
        await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body></body></html>`);
        await page.evaluate(html => {
            const source = new DOMParser().parseFromString(html, 'text/html');
            document.body.appendChild(source.querySelector('#sheld').cloneNode(true));
            const input = document.querySelector('#send_textarea');
            input.placeholder = input.getAttribute('connected_text');
            document.querySelector('#send_but').classList.remove('displayNone');
        }, html);
        const metrics = () => page.evaluate(() => {
            const input = document.querySelector('#send_textarea');
            const style = getComputedStyle(input);
            const bounds = input.getBoundingClientRect();
            const context = document.createElement('canvas').getContext('2d');
            context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const glyphs = context.measureText(input.placeholder);
            return {
                fontSize: Number.parseFloat(style.fontSize),
                placeholderSize: Number.parseFloat(getComputedStyle(input, '::placeholder').fontSize),
                iconSize: Number.parseFloat(getComputedStyle(document.querySelector('#nonQRFormItems')).fontSize),
                contentHeight: input.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
                glyphHeight: glyphs.actualBoundingBoxAscent + glyphs.actualBoundingBoxDescent,
                top: bounds.top, bottom: bounds.bottom, width: bounds.width,
            };
        });
        await page.evaluate(() => {
            // This is the actual user's fontScale setting used by --mainFontSize.
            document.documentElement.style.setProperty('--fontScale', '0.8');
        });
        const desktop = await metrics();
        assert.equal(desktop.fontSize, 12);
        await page.addStyleTag({ content: ios });
        assert.deepEqual(await metrics(), desktop, 'Loading iOS CSS without the native marker leaves desktop geometry unchanged.');
        await page.evaluate(() => { window.Capacitor = {}; });
        assert.deepEqual(await metrics(), desktop, 'An Android Capacitor session also keeps its upstream input font and geometry.');

        const native = await environment({ width: 402, height: 874 });
        await page.evaluate(({ classes, styles }) => {
            document.body.className = [...classes, 'safari'].join(' ');
            for (const [name, value] of styles) document.documentElement.style.setProperty(name, value);
        }, { classes: [...native.classes], styles: [...native.styles] });
        for (const scenario of [
            { scale: 0.5, expected: 16 },
            { scale: 0.8, expected: 16 },
            { scale: 1, expected: 16 },
            { scale: 1, expected: 16, iconSize: 64 },
            { scale: 1.5, expected: 22.5 },
            { scale: 1.6, expected: 24 },
            { scale: 2, expected: 30 },
        ]) {
            await page.evaluate(({ scale, iconSize }) => {
                document.documentElement.style.setProperty('--fontScale', String(scale));
                if (iconSize) document.documentElement.style.setProperty('--bottomFormIconSize', `${iconSize}px`);
                else document.documentElement.style.removeProperty('--bottomFormIconSize');
            }, scenario);
            const measured = await metrics();
            assert.equal(measured.fontSize, scenario.expected, `Text follows the configured size with a 16px floor: ${JSON.stringify(scenario)}`);
            assert.equal(measured.placeholderSize, scenario.expected);
            const expectedIconSize = scenario.iconSize || scenario.scale * 15 * 1.9;
            assert.ok(Math.abs(measured.iconSize - expectedIconSize) < 0.01, 'The configured icon size remains independent from message text.');
            assert.ok(measured.glyphHeight <= measured.contentHeight, `Placeholder glyphs fit vertically: ${JSON.stringify(measured)}`);
            assert.ok(measured.top >= 0 && measured.bottom <= 874, 'The real message control stays inside the viewport.');
            assert.ok(measured.width > 150, 'The input retains usable width alongside the upstream controls.');
        }
        // Exercise normal browser focus and typing too; native keyboard focus
        // still needs the real WKWebView Simulator test, not this fixture.
        await page.locator('#send_textarea').tap();
        await page.locator('#send_textarea').pressSequentially('Draft survives Home');
        assert.equal(await page.locator('#send_textarea').inputValue(), 'Draft survives Home');
    } finally {
        await browser.close();
    }
});

test('the real helper anchors chat above a panned keyboard and restores only root scroll', {
    skip: process.env.ST_CHROMIUM_PATH ? false : 'Set ST_CHROMIUM_PATH to run the root-pan and nested-chat scrolling fixture.',
    timeout: 30000,
}, async () => {
    const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
    const browser = await chromium.launch({ executablePath: process.env.ST_CHROMIUM_PATH, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const names = [
            'index.html', 'style.css', 'css/st-tailwind.css', 'css/mobile-styles.css', 'css/ios-overrides.css',
            'scripts/ios-init.js', 'scripts/events.js', 'lib/eventemitter.js',
        ];
        const contents = await Promise.all(names.map(name => readFile(path.join(repository, 'public', name), 'utf8')));
        const files = new Map(names.map((name, index) => [`/${name}`, contents[index]]));
        const css = [files.get('/style.css'), files.get('/css/st-tailwind.css'), files.get('/css/mobile-styles.css')]
            .map(source => source.replace(/^@import[^;]+;/gm, '')
                // Exercise Safari's real mobile rules in this Chromium fixture.
                .replace('@supports (-webkit-touch-callout: none)', '@supports (display: block)')).join('\n');
        const indexArgument = JSON.stringify(files.get('/index.html')).replaceAll('<', '\\u003c');
        const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="safari"><script>
            const source = new DOMParser().parseFromString(${indexArgument}, 'text/html');
            for (const id of ['top-bar', 'top-settings-holder']) document.body.appendChild(source.getElementById(id).cloneNode(false));
            document.getElementById('top-settings-holder').appendChild(source.getElementById('persona-management-button').cloneNode(true));
            document.body.appendChild(source.getElementById('sheld').cloneNode(true));
            const history = document.createElement('div');
            history.style.cssText = 'min-height:1600px; flex-shrink:0';
            history.textContent = 'Earlier messages remain scrollable';
            document.getElementById('chat').appendChild(history);
            document.body.style.setProperty('--topBarBlockSize', '97px');
            document.getElementById('send_but').classList.remove('displayNone');
        </script><script type="module" src="/scripts/ios-init.js"></script></body></html>`;
        await page.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin !== 'http://localhost:8000') return route.abort();
            if (url.pathname === '/viewport-fixture') return route.fulfill({ contentType: 'text/html', body: fixture });
            const body = files.get(url.pathname);
            if (!body || url.pathname === '/index.html') return route.abort();
            return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
        });
        await page.addInitScript(native => {
            window.__ST_IOS_APP__ = native;
            // The browser renders real CSS and executes the real helper. Only
            // the OS keyboard's viewport dimensions/pan are simulated here.
            const viewport = Object.assign(new EventTarget(), { width: 402, height: 874, offsetTop: 0, offsetLeft: 0, scale: 1 });
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
            window.__fixtureRootScrolls = [];
            window.addEventListener('scroll', () => window.__fixtureRootScrolls.push(window.scrollY));
        }, expected);
        // All requests are fulfilled above; there is no local backend/server.
        await page.goto('http://localhost:8000/viewport-fixture');
        await page.waitForFunction(() => document.querySelector('#st-ios-css')?.sheet && document.documentElement.style.getPropertyValue('--st-viewport-height') === '874px');

        // Render the real Persona drawer with the Simulator's 62px top inset.
        // Only env() values are supplied here; layout comes from upstream CSS
        // and the actual helper's viewport measurements.
        await page.evaluate(() => {
            document.body.style.setProperty('--st-safe-bottom', '34px');
            document.getElementById('top-settings-holder').style.paddingTop = '62px';
            const drawer = document.getElementById('PersonaManagement');
            drawer.classList.replace('closedDrawer', 'openDrawer');
            drawer.style.transition = 'none';
            const history = document.createElement('div');
            history.style.height = '1100px';
            history.textContent = 'Many saved personas require drawer scrolling';
            drawer.appendChild(history);
            document.getElementById('st-ios-css').sheet.disabled = true;
        });
        const unsafeTitle = await page.locator('#PersonaManagement h3').boundingBox();
        assert.equal(unsafeTitle.y, 42, 'The unpatched Safari drawer reproduces the actual AX title at y=42.');
        await page.evaluate(() => {
            document.body.classList.remove('st-ios');
            document.documentElement.classList.remove('st-ios');
        });
        const unmarkedBefore = await page.locator('#PersonaManagement').boundingBox();
        await page.evaluate(() => { document.getElementById('st-ios-css').sheet.disabled = false; });
        assert.deepEqual(await page.locator('#PersonaManagement').boundingBox(), unmarkedBefore, 'The native override cannot change an unmarked desktop/Android drawer.');
        await page.evaluate(() => {
            document.body.classList.add('st-ios');
            document.documentElement.classList.add('st-ios');
        });
        for (const scenario of [
            { name: 'portrait', width: 402, height: 874, visualHeight: 874, offsetTop: 0, safeTop: 62, safeBottom: 34 },
            { name: 'portrait keyboard', width: 402, height: 874, visualHeight: 471, offsetTop: 0, safeTop: 62, safeBottom: 0 },
            { name: 'panned keyboard', width: 402, height: 874, visualHeight: 471, offsetTop: 403, safeTop: 62, safeBottom: 0 },
            { name: 'landscape keyboard', width: 874, height: 402, visualHeight: 250, offsetTop: 12, safeTop: 0, safeBottom: 0 },
            { name: 'small iPhone keyboard', width: 375, height: 667, visualHeight: 321, offsetTop: 0, safeTop: 20, safeBottom: 0 },
            { name: 'iPad portrait keyboard', width: 820, height: 1180, visualHeight: 755, offsetTop: 0, safeTop: 24, safeBottom: 0 },
            { name: 'iPad landscape keyboard', width: 1180, height: 820, visualHeight: 430, offsetTop: 0, safeTop: 24, safeBottom: 0 },
        ]) {
            await page.setViewportSize({ width: scenario.width, height: scenario.height });
            await page.evaluate(({ width, visualHeight, offsetTop, safeTop, safeBottom }) => {
                Object.assign(window.visualViewport, { width, height: visualHeight, offsetTop });
                document.body.style.setProperty('--topBarBlockSize', `${35 + safeTop}px`);
                document.body.style.setProperty('--st-safe-bottom', `${safeBottom}px`);
                document.getElementById('top-settings-holder').style.paddingTop = `${safeTop}px`;
                // Saved moving-UI positions and maximized important rules must
                // not put a toolbar drawer back inside the status bar.
                const drawer = document.getElementById('PersonaManagement');
                drawer.style.top = '0px';
                drawer.classList.add('maximized');
                window.visualViewport.dispatchEvent(new Event('resize'));
                window.visualViewport.dispatchEvent(new Event('scroll'));
            }, scenario);
            await page.waitForFunction(({ visualHeight, offsetTop }) =>
                document.documentElement.style.getPropertyValue('--st-viewport-height') === `${visualHeight}px`
                && document.documentElement.style.getPropertyValue('--st-viewport-offset-top') === `${offsetTop}px`, scenario);
            const measured = await page.evaluate(() => {
                const drawer = document.getElementById('PersonaManagement');
                drawer.scrollTop = 0;
                const panel = drawer.getBoundingClientRect();
                const title = drawer.querySelector('h3').getBoundingClientRect();
                const toggle = document.getElementById('personaManagementDrawerIcon').getBoundingClientRect();
                drawer.scrollTop = 160;
                return { top: panel.top, bottom: panel.bottom, titleTop: title.top, toggleBottom: toggle.bottom, scroll: drawer.scrollTop };
            });
            assert.ok(measured.titleTop >= measured.toggleBottom, `${scenario.name}: the title stays below the actual toolbar toggle: ${JSON.stringify(measured)}`);
            assert.ok(measured.top >= scenario.offsetTop + scenario.safeTop + 35, `${scenario.name}: the panel follows the visible toolbar after pan.`);
            assert.ok(measured.bottom <= scenario.offsetTop + scenario.visualHeight - scenario.safeBottom + 1, `${scenario.name}: the panel stays above the keyboard/home safe area.`);
            assert.ok(measured.scroll > 0, `${scenario.name}: overflowing personas remain scrollable.`);
        }
        await page.setViewportSize({ width: 402, height: 874 });
        await page.evaluate(() => {
            Object.assign(window.visualViewport, { width: 402, height: 874, offsetTop: 0 });
            document.body.style.setProperty('--topBarBlockSize', '97px');
            document.body.style.removeProperty('--st-safe-bottom');
            document.getElementById('top-settings-holder').style.paddingTop = '62px';
            const drawer = document.getElementById('PersonaManagement');
            drawer.classList.replace('openDrawer', 'closedDrawer');
            drawer.classList.remove('maximized');
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--st-viewport-height') === '874px');
        await page.evaluate(() => { document.getElementById('chat').scrollTop = 300; });
        for (const keyboard of [{ height: 471, offsetTop: 0 }, { height: 471, offsetTop: 403 }]) {
            await page.evaluate(keyboard => {
                Object.assign(window.visualViewport, keyboard);
                window.visualViewport.dispatchEvent(new Event('resize'));
                window.visualViewport.dispatchEvent(new Event('scroll'));
            }, keyboard);
            await page.waitForFunction(({ height, offsetTop }) =>
                document.documentElement.style.getPropertyValue('--st-viewport-height') === `${height}px`
                && document.documentElement.style.getPropertyValue('--st-viewport-offset-top') === `${offsetTop}px`, keyboard);
            const measured = await page.evaluate(() => {
                const input = document.querySelector('#send_textarea').getBoundingClientRect();
                const toolbar = document.querySelector('#top-bar').getBoundingClientRect();
                return {
                    inputTop: input.top - window.visualViewport.offsetTop,
                    inputBottom: input.bottom - window.visualViewport.offsetTop,
                    toolbarTop: toolbar.top - window.visualViewport.offsetTop,
                    chatScroll: document.getElementById('chat').scrollTop,
                };
            });
            assert.ok(measured.inputTop >= 97 && measured.inputBottom <= keyboard.height, `The composer stays below the toolbar and above the keyboard after pan: ${JSON.stringify(measured)}`);
            assert.ok(measured.inputBottom >= keyboard.height - 3, 'The composer remains at the bottom of the visible chat space.');
            assert.equal(measured.toolbarTop, 0);
            assert.equal(measured.chatScroll, 300, 'Viewport layout cannot reset the nested chat history scroll position.');
        }

        // Force a genuine document scroll range to simulate WebKit's root
        // auto-scroll even though the production CSS prevents ordinary scrolling.
        const displaced = await page.evaluate(() => {
            document.documentElement.style.height = '1400px';
            document.documentElement.style.overflow = 'auto';
            window.visualViewport.offsetTop = 0;
            window.visualViewport.dispatchEvent(new Event('scroll'));
            window.scrollTo(0, 403);
            return window.scrollY;
        });
        assert.equal(displaced, 403, 'The fixture actually displaced the root document.');
        await page.waitForFunction(() => window.scrollY === 0);
        assert.equal(await page.evaluate(() => document.getElementById('chat').scrollTop), 300);
        assert.ok(await page.evaluate(() => window.__fixtureRootScrolls.includes(403)), 'The real root scroll event reached the helper.');

        await page.evaluate(() => {
            window.visualViewport.scale = 2;
            window.scrollTo(0, 200);
        });
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--st-viewport-height') === '874px');
        assert.equal(await page.evaluate(() => window.scrollY), 200, 'Root pan is preserved during pinch zoom.');
        await page.evaluate(() => {
            window.visualViewport.scale = 1;
            window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(() => window.scrollY === 0);
        assert.equal(await page.evaluate(() => document.getElementById('chat').scrollTop), 300);
        assert.notEqual(await page.evaluate(() => window.__ST_IOS_READY__), true, 'This geometry fixture never fabricates application readiness.');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});
