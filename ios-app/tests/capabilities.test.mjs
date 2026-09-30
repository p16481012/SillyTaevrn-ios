import assert from 'node:assert/strict';
import test from 'node:test';
import express from '../../node_modules/express/index.js';

process.env.ST_IOS = '1';
const { installIOSRoutes } = await import('../../src/ios-runtime.js');

test('unsupported local operations fail before downstream handlers; remote speech remains reachable', async () => {
    const app = express();
    app.use(express.json());
    installIOSRoutes(app);
    let downstreamCalls = 0;
    app.use((_, response) => { downstreamCalls++; response.sendStatus(204); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const pathname of ['/api/extra/classify', '/api/extra/caption', '/api/speech/recognize', '/api/speech/synthesize', '/api/vector/insert', '/api/vector/query']) {
            const response = await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'transformers' }) });
            assert.equal(response.status, 501, pathname);
            assert.equal((await response.json()).code, 'IOS_LOCAL_INFERENCE_UNAVAILABLE');
        }
        assert.equal(downstreamCalls, 0);
        assert.equal((await fetch(base + '/api/vector/insert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'openai' }) })).status, 204);
        assert.equal((await fetch(base + '/api/speech/elevenlabs/models')).status, 204);
        // Supported Git operations must reach their real endpoint instead of
        // being intercepted by the old iOS unsupported-feature middleware.
        for (const pathname of ['/api/extensions/branches', '/api/extensions/switch']) {
            assert.equal((await fetch(base + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 204, pathname);
        }
        const capabilities = await (await fetch(base + '/api/ios/capabilities')).json();
        assert.equal(capabilities.localTransformers, false);
        assert.equal(capabilities.tokenization.sentencepiece, 'estimated');
        assert.equal(capabilities.tokenization.huggingface, 'estimated');
        assert.deepEqual(capabilities.extensionGitManagement, { version: true, update: true, branches: true });
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
