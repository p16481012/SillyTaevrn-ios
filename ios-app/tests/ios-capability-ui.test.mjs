import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const chrome = process.env.ST_CHROMIUM_PATH;
const sourceFiles = new Map(await Promise.all([
    'scripts/ios-capability-ui.js', 'scripts/events.js', 'lib/eventemitter.js',
].map(async name => [name, await readFile(path.join(repository, 'public', name), 'utf8')])));
const [index, vectors, caption, expressions] = await Promise.all([
    'public/index.html',
    'public/scripts/extensions/vectors/settings.html',
    'public/scripts/extensions/caption/settings.html',
    'public/scripts/extensions/expressions/settings.html',
].map(name => readFile(path.join(repository, name), 'utf8')));

test('the iOS capability guide is loaded by the real application document', () => {
    assert.match(index, /<script type="module" src="scripts\/ios-capability-ui\.js"><\/script>/);
    for (const [template, id, value] of [
        [vectors, 'vectors_source', 'transformers'],
        [caption, 'caption_source', 'local'],
        [expressions, 'expression_api', '0'],
    ]) {
        assert.match(template, new RegExp(`<select id="${id}"`));
        assert.match(template, new RegExp(`<option value="${value}"`));
    }
});

test('real browser disables only unsupported iOS choices after late extension injection; saved choices remain visible', {
    skip: !chrome && 'ST_CHROMIUM_PATH is required for browser UI checks',
}, async () => {
    const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
        const page = await browser.newPage();
        const requests = [];
        await page.route('http://localhost:8000/**', route => {
            const pathname = new URL(route.request().url()).pathname.slice(1);
            if (pathname === 'api/ios/capabilities') {
                requests.push(pathname);
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                    localTransformers: false,
                    tokenization: { openai: 'exact', sentencepiece: 'estimated', huggingface: 'estimated' },
                }) });
            }
            if (sourceFiles.has(pathname)) {
                return route.fulfill({ status: 200, contentType: 'application/javascript', body: sourceFiles.get(pathname) });
            }
            if (pathname !== 'capability-ui-fixture') return route.abort();
            return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html>
                <html lang="ko"><body>
                    <div id="extensions_settings"></div><div id="extensions_settings2"></div>
                    <label id="existing-tokenizer-note">Existing description</label>
                    <select id="tokenizer" aria-describedby="existing-tokenizer-note"><option value="99">Best match</option></select>
                    <script>window.__ST_IOS_APP__ = { deploymentId: 'fixture', version: '1.19.0' };</script>
                    <script type="module" src="/scripts/ios-capability-ui.js"></script>
                    <script type="module">
                        import { eventSource, event_types } from '/scripts/events.js';
                        await eventSource.emit(event_types.APP_READY);
                        window.__FIXTURE_READY__ = true;
                    </script>
                </body></html>` });
        });
        await page.goto('http://localhost:8000/capability-ui-fixture');
        await page.waitForFunction(() => document.getElementById('st-ios-tokenizer-estimate'));
        assert.deepEqual(requests, ['api/ios/capabilities']);
        await page.evaluate(({ vectors, caption, expressions }) => {
            document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', expressions);
            document.getElementById('extensions_settings').insertAdjacentHTML('beforeend', `
                <div class="tts_block"><select id="tts_provider"><option value="SpeechT5">SpeechT5</option>
                <option value="OpenAI">OpenAI</option></select><input id="tts_refresh" type="submit"></div>`);
            document.getElementById('extensions_settings2').insertAdjacentHTML('beforeend', caption + vectors);
            for (const [id, value] of [
                ['vectors_source', 'transformers'], ['caption_source', 'local'],
                ['expression_api', '0'], ['tts_provider', 'SpeechT5'],
            ]) document.getElementById(id).value = value;
        }, { vectors, caption, expressions });
        await page.waitForFunction(() => ['vectors_source', 'caption_source', 'expression_api', 'tts_provider']
            .every(id => document.getElementById(`st-ios-unavailable-${id}`)));
        const state = await page.evaluate(() => Object.fromEntries([
            ['vectors_source', 'transformers', 'openai'],
            ['caption_source', 'local', 'multimodal'],
            ['expression_api', '0', '2'],
            ['tts_provider', 'SpeechT5', 'OpenAI'],
        ].map(([id, blocked, supported]) => {
            const select = document.getElementById(id);
            const note = document.getElementById(`st-ios-unavailable-${id}`);
            return [id, {
                selected: select.value,
                blocked: [...select.options].find(option => option.value === blocked).disabled,
                supported: [...select.options].find(option => option.value === supported).disabled,
                described: select.getAttribute('aria-describedby')?.includes(note.id),
                note: note.textContent,
                noteCount: document.querySelectorAll(`#${note.id}`).length,
            }];
        })));
        for (const [id, blocked] of [
            ['vectors_source', 'transformers'], ['caption_source', 'local'],
            ['expression_api', '0'], ['tts_provider', 'SpeechT5'],
        ]) {
            assert.equal(state[id].selected, blocked, `The stored ${id} selection is preserved`);
            assert.equal(state[id].blocked, true, `The unsupported ${id} option cannot be chosen anew`);
            assert.equal(state[id].supported, false, `The supported ${id} option remains available`);
            assert.equal(state[id].described, true);
            assert.match(state[id].note, /로컬 추론 엔진/);
            assert.equal(state[id].noteCount, 1);
        }
        assert.match(await page.locator('#st-ios-tokenizer-estimate').innerText(), /SentencePiece 및 Hugging Face 계열 토큰 수가 추정치/);
        assert.equal(await page.locator('#tokenizer').getAttribute('aria-describedby'), 'existing-tokenizer-note st-ios-tokenizer-estimate');
        await page.selectOption('#vectors_source', 'openai');
        assert.equal(await page.locator('#vectors_source').inputValue(), 'openai');
        await page.evaluate(() => document.getElementById('extensions_settings').appendChild(document.createElement('div')));
        assert.equal(await page.locator('#st-ios-unavailable-tts_provider').count(), 1, 'An additional drawer mutation does not duplicate the warning');
    } finally {
        await browser.close();
    }
});

test('desktop and Android-like localhost sessions leave upstream choices intact', {
    skip: !chrome && 'ST_CHROMIUM_PATH is required for browser UI checks',
}, async () => {
    const { chromium } = await import('../../tests/node_modules/playwright-core/index.mjs');
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
        const page = await browser.newPage();
        let capabilitiesRequested = false;
        await page.route('http://localhost:8000/**', route => {
            const pathname = new URL(route.request().url()).pathname.slice(1);
            if (pathname === 'api/ios/capabilities') {
                capabilitiesRequested = true;
                return route.fulfill({ status: 200, contentType: 'application/json', body: '{"localTransformers":false}' });
            }
            if (sourceFiles.has(pathname)) {
                return route.fulfill({ status: 200, contentType: 'application/javascript', body: sourceFiles.get(pathname) });
            }
            return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html><body>
                <div id="extensions_settings"><select id="caption_source"><option value="local">Local</option></select></div>
                <script>window.Capacitor = {};</script>
                <script type="module" src="/scripts/ios-capability-ui.js"></script>
                <script type="module">
                    import { eventSource, event_types } from '/scripts/events.js';
                    await eventSource.emit(event_types.APP_READY);
                    window.__FIXTURE_READY__ = true;
                </script></body></html>` });
        });
        await page.goto('http://localhost:8000/capability-ui-fixture');
        await page.waitForFunction(() => window.__FIXTURE_READY__);
        assert.equal(capabilitiesRequested, false);
        assert.equal(await page.locator('#caption_source option').isDisabled(), false);
        assert.equal(await page.locator('[id^="st-ios-unavailable-"]').count(), 0);
    } finally {
        await browser.close();
    }
});
