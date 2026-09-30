import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const backendRoutes = new Set(['/api/settings/get', '/api/settings/save', '/api/characters/create', '/api/characters/get', '/api/chats/get', '/api/secrets/write']);

export function createChatContract(fixtureId = randomUUID()) {
    if (!uuidPattern.test(fixtureId)) throw new Error('An independent chat fixture UUID is required.');
    fixtureId = fixtureId.toLowerCase();
    const short = fixtureId.slice(0, 8);
    const firstPrefix = `Native stream ${short}: `;
    return Object.freeze({ schemaVersion: 1, fixtureId, model: `st-chat-fixture:${fixtureId}`,
        characterName: `ST Native Chat ${short}`, avatar: `st-native-chat-${fixtureId}.png`,
        greeting: 'Synthetic chat fixture ready.', firstPrompt: `Generate stream fixture ${fixtureId}.`,
        firstPrefix, firstResponse: `${firstPrefix}안녕하세요 🙂 café.`,
        cancelPrompt: `Generate stop fixture ${fixtureId}.`, cancelPrefix: `Native cancel ${short}: 첫 조각 🙂`,
        forbiddenSuffix: ` FORBIDDEN_AFTER_STOP_${fixtureId}` });
}

export function validateChatContract(contract) {
    const expected = createChatContract(contract?.fixtureId);
    for (const [key, value] of Object.entries(expected)) assert.equal(contract[key], value, `Invalid chat fixture ${key}`);
    if (Object.keys(contract).some(key => !Object.hasOwn(expected, key) && key !== 'initialChatName')) throw new Error('Unexpected chat fixture field; credentials must not enter the XCTest contract.');
    if (contract.initialChatName !== undefined && (typeof contract.initialChatName !== 'string' || !contract.initialChatName || /[\0/\\]/.test(contract.initialChatName))) throw new Error('Unsafe initial chat name.');
    return contract;
}

export function fixtureProviderURL(value) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.port === '8000'
        || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/v1') throw new Error('The generated provider must use its own loopback HTTP port and /v1 path.');
    return parsed.href.replace(/\/$/, '');
}

/** Settings/get includes real preset files; keep its larger bound fixture-local. */
export function requestChatFixtureHTTP(value, { body, headers = {}, timeoutMs = 15000 } = {}) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
        || url.search || url.hash || !(url.pathname === '/csrf-token' || backendRoutes.has(url.pathname))) throw new Error('Fixture reads require an allowlisted loopback HTTP API route.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Invalid fixture HTTP deadline.');
    return new Promise((resolve, reject) => {
        const maximum = 4 * 1024 * 1024, decoder = new TextDecoder('utf-8', { fatal: true });
        let settled = false, size = 0, text = '';
        const settle = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) reject(error); else resolve(result);
        };
        const request = http.request(url, { method: body === undefined ? 'GET' : 'POST', agent: false,
            headers: { ...headers, 'Accept-Encoding': 'identity', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) } }, response => {
            response.on('data', chunk => {
                try {
                    size += chunk.length;
                    if (size > maximum) throw Object.assign(new Error('Chat fixture API response exceeds its4MiB limit'), { code: 'ST_CHAT_RESPONSE_LIMIT' });
                    text += decoder.decode(chunk, { stream: true });
                } catch (error) { request.destroy(error); settle(error); }
            });
            response.once('aborted', () => settle(Object.assign(new Error('Chat fixture API response was aborted'), { code: 'ST_CHAT_RESPONSE_ABORTED' })));
            response.once('error', error => settle(error));
            response.once('end', () => {
                try { text += decoder.decode(); settle(null, { status: response.statusCode, headers: response.headers, text, bytes: size }); } catch (error) { settle(error); }
            });
        });
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('Chat fixture API deadline expired'), { code: 'ST_CHAT_CLIENT_TIMEOUT' })), timeoutMs);
        request.once('error', error => settle(error));
        request.end(body);
    });
}

/** Only a provider is mocked: the native server, frontend Send and SSE parser stay real. */
export async function createChatMockProvider(contract, { prefixHoldMs = 5000, prefixFrameDelayMs = 150, chunkDelayMs = 350, cancelTimeoutMs = 30000 } = {}) {
    validateChatContract(contract);
    if (![prefixHoldMs, prefixFrameDelayMs, chunkDelayMs, cancelTimeoutMs].every(value => Number.isInteger(value) && value >= 0 && value <= 60000)
        || cancelTimeoutMs < 50) throw new Error('Invalid fixture timing.');
    const credential = `generated-fixture-${randomUUID()}`;
    const observations = [];
    const sockets = new Set(), timers = new Map();
    let closing = false;
    function pause(milliseconds) {
        if (closing) return Promise.resolve(false);
        return new Promise(resolve => {
            const timer = setTimeout(() => { timers.delete(timer); resolve(!closing); }, milliseconds);
            timers.set(timer, () => { clearTimeout(timer); resolve(false); });
        });
    }
    async function content(response, observation, text) {
        const bytes = Buffer.from(`data: ${JSON.stringify({ id: `chat-${contract.fixtureId}`, object: 'chat.completion.chunk', model: contract.model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        const unicode = bytes.findIndex(byte => byte >= 128);
        const cuts = unicode < 0 ? [bytes.length] : [unicode + 1, unicode + 2, bytes.length];
        let start = 0;
        for (const end of cuts) {
            if (closing || response.destroyed) return false;
            response.write(bytes.subarray(start, end)); start = end;
            if (unicode >= 0 && end !== bytes.length) {
                observation.utf8Split = true;
                if (!await pause(10)) return false;
            }
        }
        observation.contentFrames++;
        observation.sentText += text;
        return true;
    }
    const server = http.createServer(async (request, response) => {
        const authenticated = request.headers.authorization === `Bearer ${credential}`;
        if (request.method === 'GET' && request.url === '/v1/models') {
            observations.push({ kind: 'models', authMatched: authenticated, status: authenticated ? 200 : 401 });
            response.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(authenticated ? { object: 'list', data: [{ id: contract.model, object: 'model', owned_by: 'generated-loopback-fixture' }] }
                : { error: { message: 'Generated fixture authentication mismatch' } }));
            return;
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
        const parts = [];
        let size = 0;
        try {
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 131072) { response.writeHead(413); response.end(); return; }
                parts.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
            const lastUser = [...(Array.isArray(body.messages) ? body.messages : [])].reverse().find(message => message.role === 'user');
            const userText = typeof lastUser?.content === 'string' ? lastUser.content
                : Array.isArray(lastUser?.content) ? lastUser.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
            const scenario = userText.includes(contract.cancelPrompt) ? 'cancel' : userText.includes(contract.firstPrompt) ? 'stream' : 'unknown';
            const observation = { kind: 'generation', scenario, authMatched: authenticated, modelMatched: body.model === contract.model,
                stream: body.stream === true, promptMatched: scenario !== 'unknown', contentFrames: 0, sentText: '', utf8Split: false,
                priorExchangeReceived: scenario === 'cancel' && body.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(contract.firstResponse))
                    && body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(contract.firstPrompt)),
                closed: false, completed: false, doneSent: false, closedBeforeShutdown: false, timedOut: false };
            observations.push(observation);
            response.once('close', () => {
                observation.closed = true; observation.completed = response.writableFinished;
                observation.closedAt = Date.now();
                observation.closedBeforeShutdown = !closing;
            });
            if (!authenticated || !observation.modelMatched || !observation.stream || !observation.promptMatched) {
                response.writeHead(authenticated ? 400 : 401, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'Unexpected generated chat fixture request' } })); return;
            }
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            if (scenario === 'stream') {
                // The real frontend can defer displaying a prefix-only stream.
                // Send two actual Unicode response frames before the hold, so
                // the unchanged UI check can observe an incomplete response.
                const split = 'Native stream '.length;
                if (!await content(response, observation, contract.firstPrefix.slice(0, split)) || !await pause(prefixFrameDelayMs)
                    || !await content(response, observation, contract.firstPrefix.slice(split)) || !await pause(chunkDelayMs)
                    || !await content(response, observation, '안') || !await pause(chunkDelayMs)
                    || !await content(response, observation, '녕') || !await pause(prefixHoldMs)) return;
                for (const text of ['하', '세', '요 ', '🙂 ', 'café.']) {
                    if (!await content(response, observation, text) || !await pause(chunkDelayMs)) return;
                }
                if (response.destroyed || closing) return;
                observation.doneSent = true;
                response.end('data: [DONE]\n\n');
            } else {
                const split = contract.cancelPrefix.indexOf('첫');
                if (!await content(response, observation, contract.cancelPrefix.slice(0, split)) || !await pause(prefixFrameDelayMs)
                    || !await content(response, observation, contract.cancelPrefix.slice(split))) return;
                const heartbeat = setInterval(() => { if (!response.destroyed && !closing) response.write(': native cancellation fixture\n\n'); }, 250);
                response.once('close', () => clearInterval(heartbeat));
                if (!await pause(cancelTimeoutMs) || response.destroyed || closing) return;
                observation.timedOut = true;
                if (!await content(response, observation, contract.forbiddenSuffix)) return;
                observation.doneSent = true;
                response.end('data: [DONE]\n\n');
            }
        } catch {
            if (!response.headersSent) response.writeHead(400);
            response.end();
        }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { baseURL: fixtureProviderURL(`http://127.0.0.1:${server.address().port}/v1`), credential, observations,
        async close() {
            closing = true;
            for (const cancel of timers.values()) cancel();
            timers.clear();
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        } };
}

/** Real CSRF/session pair, allowlisted fixture writes and read-only chat queries. */
export async function createChatBackendClient(baseURL = 'http://127.0.0.1:8000') {
    const base = new URL(baseURL);
    if (base.origin !== 'http://127.0.0.1:8000' || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('Chat fixture API must be the native loopback port8000 origin.');
    const response = await requestChatFixtureHTTP(new URL('/csrf-token', base));
    assert.equal(response.status, 200, 'Native CSRF endpoint failed');
    const token = JSON.parse(response.text).token;
    assert.ok(typeof token === 'string' && token && token !== 'disabled', 'Native CSRF must remain enabled');
    const cookie = (response.headers['set-cookie'] ?? []).map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'Native CSRF requires its session cookie');
    return async (route, body) => {
        if (!backendRoutes.has(route)) throw new Error('Chat fixture API route is not allowlisted; generation and saved-message injection are prohibited.');
        const result = await requestChatFixtureHTTP(new URL(route, base), { body: JSON.stringify(body ?? {}), headers: { Cookie: cookie, 'X-CSRF-Token': token } });
        assert.equal(result.status, 200, `Native fixture API failed: ${route}`);
        try { return JSON.parse(result.text); } catch { return result.text; }
    };
}

export function chatFixtureSettings(baseline, providerURL, contract) {
    validateChatContract(contract);
    const settings = structuredClone(baseline);
    assert.equal(settings.firstRun, true, 'The empty fixture must retain real first-run onboarding');
    settings.main_api = 'openai';
    settings.oai_settings = { ...settings.oai_settings, chat_completion_source: 'custom', custom_url: fixtureProviderURL(providerURL),
        custom_model: contract.model, custom_include_body: '', custom_exclude_body: '', custom_include_headers: '', custom_prompt_post_processing: '',
        reverse_proxy: '', proxy_password: '', stream_openai: true, n: 1, function_calling: false, bypass_status_check: false,
        openai_max_context: 4095, openai_max_tokens: 300, enable_web_search: false, request_images: false, send_if_empty: '' };
    settings.power_user = { ...settings.power_user, auto_connect: false, auto_load_chat: true };
    return settings;
}

export async function seedChatFixture(client, provider, contract) {
    const loaded = await client('/api/settings/get', {});
    const baseline = typeof loaded.settings === 'string' ? JSON.parse(loaded.settings) : loaded.settings;
    const saved = await client('/api/settings/save', chatFixtureSettings(baseline, provider.baseURL, contract));
    assert.equal(saved.result, 'ok');
    assert.match(provider.credential, /^generated-fixture-[a-f0-9-]+$/i);
    const secret = await client('/api/secrets/write', { key: 'api_key_custom', value: provider.credential, label: 'Generated owned loopback chat fixture' });
    assert.ok(typeof secret.id === 'string' && secret.id);
    const avatar = await client('/api/characters/create', { ch_name: contract.characterName, file_name: contract.avatar.slice(0, -4),
        first_mes: contract.greeting, description: 'Generated native UI validation character.', personality: '', scenario: '', mes_example: '', tags: ['owned-native-chat-fixture'] });
    assert.equal(avatar, contract.avatar);
    const character = await client('/api/characters/get', { avatar_url: avatar });
    assert.equal(character.name, contract.characterName);
    assert.equal(character.first_mes, contract.greeting);
    assert.ok(typeof character.chat === 'string' && character.chat && !/[\0/\\]/.test(character.chat));
    const seeded = { ...contract, initialChatName: character.chat };
    validateChatContract(seeded);
    return seeded;
}

export function verifyChatTranscript(rows, contract) {
    validateChatContract(contract);
    assert.ok(Array.isArray(rows) && rows.length === 6, 'Expected actual JSONL header, greeting and two user/assistant exchanges');
    assert.equal(rows[0].character_name, 'unused');
    assert.equal(rows[0].user_name, 'unused');
    assert.ok(uuidPattern.test(rows[0].chat_metadata?.integrity ?? ''), 'The saved chat must have its actual integrity UUID');
    const expected = [[false, contract.greeting], [true, contract.firstPrompt], [false, contract.firstResponse], [true, contract.cancelPrompt], [false, contract.cancelPrefix]];
    expected.forEach(([user, text], index) => {
        assert.equal(rows[index + 1].is_user, user, `Saved message role ${index + 1}`);
        assert.equal(rows[index + 1].mes, text, `Saved message text ${index + 1}`);
    });
    assert.ok(!JSON.stringify(rows).includes(contract.forbiddenSuffix), 'Stop must prevent the provider suffix from reaching saved chat');
    for (const message of [rows[3], rows[5]]) {
        assert.equal(message.extra?.model, contract.model);
        assert.ok(Number.isFinite(Date.parse(message.gen_started)) && Number.isFinite(Date.parse(message.gen_finished)), 'Generated reply timings must be saved');
        assert.equal(message.swipes?.[message.swipe_id], message.mes, 'The active swipe must match the actual generated reply');
    }
    return { rows: rows.length, integrity: rows[0].chat_metadata.integrity, userMessages: 2, generatedAssistantMessages: 2,
        fullUnicodeResponse: true, cancelledPrefixPersisted: true, generationMetadataAndSwipes: true };
}

export function verifyChatProvider(observations, contract, { stopTappedAt, beforeColdRelaunchAt } = {}) {
    validateChatContract(contract);
    assert.ok(observations.some(item => item.kind === 'models' && item.authMatched && item.status === 200), 'Actual authenticated Connect/model request was not observed');
    const generated = observations.filter(item => item.kind === 'generation');
    assert.equal(generated.length, 2, 'Exactly two real Send requests must reach the owned provider');
    assert.deepEqual(generated.map(item => item.scenario), ['stream', 'cancel']);
    for (const item of generated) assert.ok(item.authMatched && item.modelMatched && item.stream && item.promptMatched && item.utf8Split);
    assert.equal(generated[0].sentText, contract.firstResponse);
    assert.ok(generated[0].contentFrames > 1 && generated[0].doneSent && generated[0].closed && generated[0].completed && generated[0].closedBeforeShutdown);
    assert.equal(generated[1].sentText, contract.cancelPrefix);
    assert.ok(generated[1].priorExchangeReceived, 'The second real Send must construct context from the first saved exchange');
    assert.ok(generated[1].closed && generated[1].closedBeforeShutdown && !generated[1].completed && !generated[1].doneSent && !generated[1].timedOut,
        'Stop must close the actual upstream before DONE/provider cleanup/deadline completion');
    if (beforeColdRelaunchAt !== undefined) {
        assert.ok(Number.isFinite(stopTappedAt) && Number.isFinite(beforeColdRelaunchAt) && Number.isFinite(generated[1].closedAt)
            && stopTappedAt <= generated[1].closedAt && generated[1].closedAt < beforeColdRelaunchAt,
        'Stop must close upstream after its actual tap and before XCTest app termination, not because of cold relaunch');
    }
    return { authenticatedConnection: true, realSendRequests: 2, incrementalUnicode: true, upstreamCancellationBeforeCleanup: true,
        upstreamCancellationBeforeAppTermination: beforeColdRelaunchAt !== undefined };
}
