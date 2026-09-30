import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeManifest, verifyRuntimeManifest } from '../scripts/runtime-manifest.mjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');

test('Manifest includes every asset, is stable, and rejects tampering or extra files', async () => {
    await fs.mkdir(testRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(testRoot, 'manifest-'));
    try {
        await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
        await fs.writeFile(path.join(directory, 'server-bundle.mjs'), 'export const startup = Promise.resolve();');
        await fs.writeFile(path.join(directory, 'assets', 'tokenizer.json'), '{"rank":123}');
        const first = await writeRuntimeManifest(directory, '1.19.0');
        const second = await writeRuntimeManifest(directory, '1.19.0');
        assert.deepEqual(first, second);
        assert.deepEqual(first.files.map(file => file.path), ['assets/tokenizer.json', 'server-bundle.mjs']);
        assert.equal((await verifyRuntimeManifest(directory)).deploymentId, first.deploymentId);
        await fs.writeFile(path.join(directory, 'assets', 'tokenizer.json'), '{"rank":999}');
        await assert.rejects(verifyRuntimeManifest(directory), /integrity/);
        await writeRuntimeManifest(directory, '1.19.0');
        await fs.writeFile(path.join(directory, 'extra'), 'unexpected');
        await assert.rejects(verifyRuntimeManifest(directory), /file list/);
    } finally {
        const relative = path.relative(testRoot, directory);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
        await fs.rm(directory, { recursive: true, force: true });
    }
});
