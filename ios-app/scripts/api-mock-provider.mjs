import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const fixtureText = '안녕하세요 🙂 café';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A provider, never a replacement for SillyTavern's route or runtime. */
export async function createMockProvider() {
    const credential = `generated-fixture-${randomUUID()}`;
    const observations = new Map();
    const sockets = new Set();
    const timers = new Set();
    function later(callback, ms) {
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms);
        timers.add(timer);
        return timer;
    }
    function event(provider, text) {
        return provider === 'openai'
            ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
            : `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
    }
    const server = http.createServer(async (request, response) => {
        // Use complete request bodies; IncomingMessage.close is not cancellation.
        let raw = '';
        for await (const chunk of request) {
            raw += chunk;
            if (raw.length > 65536) { response.writeHead(413); response.end(); return; }
        }
        let body;
        try { body = JSON.parse(raw); } catch { response.writeHead(400); response.end(); return; }
        const provider = request.url === '/v1/messages' ? 'claude' : 'openai';
        const identifier = body.model;
        if (!['/v1/messages', '/v1/chat/completions'].includes(request.url)
            || typeof identifier !== 'string' || !identifier.startsWith('st-api-fixture:')) {
            response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Invalid fixture request' } })); return;
        }
        const scenario = identifier.split(':')[1];
        const observation = {
            provider, scenario, path: request.url, stream: body.stream === true,
            authMatched: (provider === 'claude' ? request.headers['x-api-key'] : request.headers.authorization) === (provider === 'claude' ? credential : `Bearer ${credential}`),
            messagesReceived: Array.isArray(body.messages) && body.messages.length > 0,
            closed: false, completed: false, utf8Split: false,
        };
        observations.set(identifier, observation);
        response.on('close', () => {
            observation.closed = true;
            observation.completed = response.writableFinished;
        });
        if (!observation.authMatched) { response.writeHead(401); response.end(JSON.stringify({ error: { message: 'Fixture authentication mismatch' } })); return; }
        if (scenario === 'disconnect-before') { request.socket.destroy(); return; }
        if (scenario === 'timeout') return; // The caller must enforce/abort its deadline.
        if (scenario.startsWith('error-')) {
            const status = Number(scenario.slice(6));
            response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
            response.end(JSON.stringify({ error: { message: `Fixture error ${status}`, type: status === 429 ? 'insufficient_quota' : 'authentication_error' } }));
            return;
        }
        if (!body.stream) {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(provider === 'claude'
                ? { id: 'fixture', type: 'message', role: 'assistant', content: [{ type: 'text', text: fixtureText }], stop_reason: 'end_turn' }
                : { id: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: fixtureText }, finish_reason: 'stop' }] }));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (scenario === 'stream-error') {
            response.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Fixture streamed error' } })}\n\n`);
            return;
        }
        if (scenario === 'cancel' || scenario === 'disconnect-mid') {
            response.write(event(provider, '첫 조각 🙂'));
            if (scenario === 'disconnect-mid') later(() => response.destroy(), 150);
            else {
                const timer = setInterval(() => { if (!response.destroyed) response.write(': fixture heartbeat\n\n'); }, 50);
                response.once('close', () => clearInterval(timer));
            }
            return;
        }
        const bytes = Buffer.from(event(provider, fixtureText));
        const unicode = bytes.findIndex(value => value >= 128);
        // Write incomplete UTF-8 characters across separate timed network writes.
        const cuts = [unicode + 1, unicode + 2, unicode + 3, bytes.length - 1, bytes.length];
        let start = 0;
        observation.utf8Split = true;
        for (const end of cuts) {
            if (response.destroyed) return;
            response.write(bytes.subarray(start, end)); start = end;
            await pause(5);
        }
        response.end(provider === 'claude'
            ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
            : 'data: [DONE]\n\n');
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
        baseURL: `http://127.0.0.1:${server.address().port}/v1`, credential, observations,
        async close() {
            for (const timer of timers) clearTimeout(timer);
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
