import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const backendDirectory = fileURLToPath(new URL('../nodejs-project/', import.meta.url));
// A 2x1 solid red PNG: the actual decoder must produce #ff0000, not the skip fallback.
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWP8z8DwnwEIAA0FAgA+gZVNAAAAAElFTkSuQmCC', 'base64');
const colorSetting = 'SILLYTAVERN_IMAGEMETADATA_DOMINANTCOLOR';

test('iOS metadata restores skipped colors without discarding cached colors or folders', async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'st-image-metadata-'));
    const previousEnvironment = { ST_IOS: process.env.ST_IOS, [colorSetting]: process.env[colorSetting] };
    t.after(async () => {
        for (const [name, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        // Only remove the exact test directory created above.
        assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('st-image-metadata-'));
        await rm(temporary, { recursive: true, force: true });
    });
    process.env.ST_IOS = '1';
    delete process.env[colorSetting];

    const configPath = path.join(temporary, 'config.yaml');
    await writeFile(configPath, '{}\n');
    const modulePath = path.join(temporary, 'image-metadata.mjs');
    // Exercise the actual service with the same pure-JS image codecs used by
    // the iOS bundle. This focused bundle leaves packaged application files alone.
    await build({
        absWorkingDir: backendDirectory,
        stdin: {
            contents: [
                "import { setConfigFilePath } from './src/util.js';",
                `setConfigFilePath(${JSON.stringify(configPath)});`,
                "export const metadata = await import('./src/endpoints/image-metadata.js');",
            ].join('\n'),
            resolveDir: repository,
            sourcefile: 'image-metadata-test-entry.mjs',
        },
        outfile: modulePath,
        bundle: true,
        platform: 'node',
        target: 'node18',
        tsconfigRaw: {},
        format: 'esm',
        mainFields: ['main', 'module'],
        conditions: ['node', 'require', 'default'],
        alias: {
            '@jimp/wasm-png': '@jimp/js-png',
            '@jimp/wasm-jpeg': '@jimp/js-jpeg',
            '@jimp/wasm-webp': path.join(repository, 'ios-app/nodejs-project/adapters/webp.mjs'),
            '@jimp/wasm-avif': path.join(repository, 'ios-app/nodejs-project/adapters/avif.mjs'),
        },
        banner: { js: [
            "import { createRequire as __testCreateRequire } from 'node:module';",
            "import { fileURLToPath as __testFileURLToPath } from 'node:url';",
            "import { dirname as __testDirname } from 'node:path';",
            'const require = __testCreateRequire(import.meta.url);',
            'const __filename = __testFileURLToPath(import.meta.url);',
            'const __dirname = __testDirname(__filename);',
        ].join('\n') },
        logLevel: 'silent',
    });
    const { metadata } = await import(pathToFileURL(modulePath).href);
    const userRoot = path.join(temporary, 'user');
    await mkdir(path.join(userRoot, 'backgrounds'), { recursive: true });
    const relativePath = 'backgrounds/red.png';
    const imagePath = path.join(userRoot, relativePath);
    await writeFile(imagePath, redPng);
    const originalMtime = (await stat(imagePath)).mtimeMs;
    const hash = createHash('sha256').update(redPng).digest('hex');
    let skipped;
    let restored;

    await t.test('iOS default skips optional color decoding but retains image metadata', async () => {
        const batch = await metadata.getOrGenerateMetadataBatch(userRoot, [relativePath], 'bg');
        assert.equal(batch.generatedCount, 1);
        skipped = batch.results[relativePath];
        assert.equal(skipped.dominantColor, '#808080');
        assert.equal(skipped.dominantColorSkipped, true);
        assert.equal(skipped.hash, hash);
        assert.equal(skipped.aspectRatio, 2);
        assert.equal(skipped.isAnimated, false);
        assert.equal(skipped.thumbnailResolution, 160 * 90);
        assert.equal(skipped.mtime, originalMtime);
    });

    await t.test('string false stays disabled and preserves the unchanged cached entry', async () => {
        const index = await metadata.readMetadataIndex(userRoot);
        index.images[relativePath].folderIds = ['favorites'];
        index.folders = [{ id: 'favorites', name: 'Favorites', thumbnailFile: 'red.png' }];
        await metadata.writeMetadataIndex(userRoot, index);
        skipped = index.images[relativePath];
        process.env[colorSetting] = 'false';
        const batch = await metadata.getOrGenerateMetadataBatch(userRoot, [relativePath], 'bg');
        assert.equal(batch.generatedCount, 0);
        assert.deepEqual(batch.results[relativePath], skipped);
    });

    await t.test('re-enabling computes the actual PNG color despite unchanged file mtime', async () => {
        process.env[colorSetting] = 'true';
        const batch = await metadata.getOrGenerateMetadataBatch(userRoot, [relativePath], 'bg');
        assert.equal(batch.generatedCount, 1);
        restored = batch.results[relativePath];
        assert.equal(restored.dominantColor, '#ff0000');
        assert.equal(restored.dominantColorSkipped, false);
        assert.deepEqual(restored.folderIds, ['favorites']);
        assert.equal(restored.hash, skipped.hash);
        assert.equal(restored.aspectRatio, skipped.aspectRatio);
        assert.equal(restored.isAnimated, skipped.isAnimated);
        assert.equal(restored.mtime, originalMtime);
        assert.equal((await stat(imagePath)).mtimeMs, originalMtime);
        const index = await metadata.readMetadataIndex(userRoot);
        assert.deepEqual(index.images[relativePath], restored);
        assert.equal(index.folders[0].thumbnailFile, 'red.png');
    });

    await t.test('computed colors remain cached when enabled or subsequently disabled', async () => {
        for (const value of ['true', 'false']) {
            process.env[colorSetting] = value;
            const batch = await metadata.getOrGenerateMetadataBatch(userRoot, [relativePath], 'bg');
            assert.equal(batch.generatedCount, 0);
            assert.deepEqual(batch.results[relativePath], restored);
        }
    });

    await t.test('legacy cache entries without the internal flag retain their computed color', async () => {
        const index = await metadata.readMetadataIndex(userRoot);
        delete index.images[relativePath].dominantColorSkipped;
        await metadata.writeMetadataIndex(userRoot, index);
        process.env[colorSetting] = 'true';
        const batch = await metadata.getOrGenerateMetadataBatch(userRoot, [relativePath], 'bg');
        assert.equal(batch.generatedCount, 0);
        assert.deepEqual(batch.results[relativePath], index.images[relativePath]);
        assert.equal(batch.results[relativePath].dominantColor, '#ff0000');
        assert.deepEqual(JSON.parse(await readFile(path.join(userRoot, metadata.METADATA_FILE), 'utf8')).images[relativePath], batch.results[relativePath]);
    });
});
