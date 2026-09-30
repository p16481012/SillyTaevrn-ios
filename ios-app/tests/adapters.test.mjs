import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { get_encoding, encoding_for_model } from '../nodejs-project/adapters/tiktoken.mjs';
import { LocalIndex } from '../nodejs-project/adapters/vectra.mjs';
import { pipeline } from '../nodejs-project/adapters/transformers.mjs';
import { Tokenizer } from '../nodejs-project/adapters/web-tokenizers.mjs';
import { SentencePieceProcessor } from '../nodejs-project/adapters/sentencepiece.mjs';
import webp from '../nodejs-project/adapters/webp.mjs';
import avif from '../nodejs-project/adapters/avif.mjs';
import simpleGit from '../nodejs-project/adapters/simple-git.mjs';
import { PacProxyAgent } from '../nodejs-project/adapters/pac-proxy-agent.mjs';
import { read, write } from '../../src/character-card-parser.js';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(appDirectory, 'nodejs-project', 'package.json'));
const rootRequire = createRequire(path.join(appDirectory, '..', 'package.json'));
process.env.ST_RUNTIME_DIR = path.join(appDirectory, 'nodejs-project');
const testDirectory = path.join(appDirectory, '.test-tmp');
const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/tiktoken-reference.json', import.meta.url), 'utf8'));

for (const fixture of fixtures.encodings) {
    test(`Exact BPE ids and raw bytes: ${fixture.name}`, () => {
        const tokenizer = get_encoding(fixture.name);
        for (const sample of fixture.samples) {
            const tokens = tokenizer.encode(sample.text, 'all');
            assert.deepEqual(Array.from(tokens), sample.ids);
            assert.equal(new TextDecoder().decode(tokenizer.decode(tokens)), sample.text);
            assert.deepEqual(Array.from(tokenizer.decode([sample.ids[0]])), sample.firstTokenBytes);
        }
        tokenizer.free();
        assert.throws(() => tokenizer.encode('freed'), /freed/);
    });
}

test('JS tokenizer matches the pinned upstream WASM implementation, including split UTF-8 tokens', { skip: typeof WebAssembly === 'undefined' }, () => {
    const wasm = rootRequire('tiktoken');
    for (const fixture of fixtures.encodings) {
        const reference = wasm.get_encoding(fixture.name);
        const actual = get_encoding(fixture.name);
        for (const sample of fixture.samples) {
            const ids = reference.encode(sample.text, 'all');
            assert.deepEqual(Array.from(actual.encode(sample.text, 'all')), Array.from(ids));
            for (const id of ids) assert.deepEqual(actual.decode([id]), reference.decode(new Uint32Array([id])));
        }
        reference.free(); actual.free();
    }
});

test('Model selection and special-token restrictions match the tiktoken interface', () => {
    const tokenizer = encoding_for_model('gpt-4o');
    assert.deepEqual(Array.from(tokenizer.encode('hello world')), [24912, 2375]);
    assert.throws(() => tokenizer.encode('<|endoftext|>'), /special token/);
    assert.throws(() => tokenizer.decode([4294967295]), /Unknown token/);
    tokenizer.free();
    assert.throws(() => encoding_for_model('not-a-model'), /Unknown model/);
});

test('PNG/JPEG encode, resize and character-card metadata work without WebAssembly', async () => {
    const { createJimp } = require('@jimp/core');
    const png = require('@jimp/js-png').default;
    const jpeg = require('@jimp/js-jpeg').default;
    const { methods } = require('@jimp/plugin-resize');
    const Jimp = createJimp({ formats: [png, jpeg], plugins: [methods] });
    const image = new Jimp({ width: 8, height: 6, color: 0x3366aaff });
    const pngBuffer = await image.getBuffer('image/png');
    const decoded = await Jimp.read(pngBuffer);
    assert.deepEqual(decoded.bitmap.data, image.bitmap.data);
    decoded.resize({ w: 4, h: 3 });
    const jpegBuffer = await decoded.getBuffer('image/jpeg', { quality: 90 });
    const jpegImage = await Jimp.read(jpegBuffer);
    assert.equal(jpegImage.bitmap.width, 4);
    assert.equal(jpegImage.bitmap.height, 3);
    const card = { data: { name: '테스트', description: 'PNG metadata' }, spec: 'chara_card_v2', spec_version: '2.0' };
    const originalCard = write(pngBuffer, JSON.stringify(card));
    const resized = await Jimp.read(originalCard);
    resized.resize({ w: 4, h: 3 });
    const exportedCard = write(await resized.getBuffer('image/png'), read(originalCard));
    const metadata = JSON.parse(read(exportedCard));
    assert.equal(metadata.data.name, card.data.name);
    assert.equal(metadata.data.description, card.data.description);
    assert.equal(metadata.spec, 'chara_card_v3');
});

test('Vector index persists, reopens, searches, updates and deletes', async () => {
    await fs.mkdir(testDirectory, { recursive: true });
    const directory = await fs.mkdtemp(path.join(testDirectory, 'vectors-'));
    try {
        const index = new LocalIndex(directory);
        await index.createIndex();
        await index.beginUpdate();
        await index.upsertItem({ id: 'first', vector: [1, 0, 0], metadata: { collection: 'a', text: 'first' } });
        await index.upsertItem({ id: 'second', vector: [0, 1, 0], metadata: { collection: 'b', text: 'second' } });
        await index.endUpdate();
        const reopened = new LocalIndex(directory);
        const result = await reopened.queryItems([0.9, 0.1, 0], 1);
        assert.equal(result[0].item.id, 'first');
        assert.ok(result[0].score > 0.9);
        assert.equal((await reopened.listItemsByMetadata({ collection: 'b' }))[0].id, 'second');
        await reopened.upsertItem({ id: 'first', vector: [0, 0, 1], metadata: { collection: 'a', text: 'changed' } });
        assert.equal((await new LocalIndex(directory).getItem('first')).metadata.text, 'changed');
        await reopened.deleteItem('second');
        assert.equal((await new LocalIndex(directory).listItems()).length, 1);
        await reopened.beginUpdate();
        await reopened.upsertItem({ id: 'cancelled', vector: [1, 0, 0] });
        await reopened.cancelUpdate();
        assert.equal((await new LocalIndex(directory).listItems()).length, 1);
        await reopened.deleteIndex();
        assert.equal(await reopened.isIndexCreated(), false);
    } finally {
        const relative = path.relative(testDirectory, directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('Unsupported native/WASM APIs fail explicitly instead of returning empty success', async () => {
    const unsupported = error => error.code === 'IOS_UNSUPPORTED_FEATURE' && error.status === 501;
    await assert.rejects(pipeline('feature-extraction'), unsupported);
    await assert.rejects(Tokenizer.fromJSON('{}'), unsupported);
    await assert.rejects(new SentencePieceProcessor().load('model'), unsupported);
    assert.throws(() => webp().decode(Buffer.alloc(0)), unsupported);
    assert.throws(() => avif().encode({}), unsupported);
    assert.throws(() => simpleGit(), unsupported);
    assert.throws(() => new PacProxyAgent('pac+http://localhost/proxy.pac'), unsupported);
});
