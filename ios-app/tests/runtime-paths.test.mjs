import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pathsModule = new URL('../../src/server-directory.js', import.meta.url).href;
const constantsModule = new URL('../../src/constants.js', import.meta.url).href;

function inspect(overrides = {}) {
    const env = { ...process.env };
    for (const key of ['ST_IOS', 'ST_SERVER_DIR', 'ST_PUBLIC_DIR', 'ST_DEFAULTS_DIR', 'ST_TOKENIZERS_DIR', 'ST_USER_DATA_DIR']) delete env[key];
    Object.assign(env, overrides);
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
        const directories = await import(${JSON.stringify(pathsModule)});
        const constants = await import(${JSON.stringify(constantsModule)});
        console.log(JSON.stringify({ ...directories, ...constants }));
    `], { env, encoding: 'utf8' });
}

test('desktop defaults resolve from the source tree', () => {
    const result = inspect();
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.serverDirectory, path.resolve(root));
    assert.equal(value.defaultDirectory, path.join(root, 'default'));
    assert.equal(value.publicDirectory, path.join(root, 'public'));
    assert.equal(value.DEFAULT_AVATAR_PATH, path.join(root, 'public', 'img', 'ai4.png'));
});

test('iOS readonly assets and writable extensions/backups remain separate', () => {
    const overrides = {
        ST_IOS: '1', ST_SERVER_DIR: path.resolve(root, 'fixture/runtime'),
        ST_PUBLIC_DIR: path.resolve(root, 'fixture/App/public'),
        ST_DEFAULTS_DIR: path.resolve(root, 'fixture/App/default'),
        ST_TOKENIZERS_DIR: path.resolve(root, 'fixture/runtime/models'),
        ST_USER_DATA_DIR: path.resolve(root, 'fixture/Documents/SillyTavern'),
    };
    const result = inspect(overrides);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.isIOS, true);
    assert.equal(value.publicDirectory, overrides.ST_PUBLIC_DIR);
    assert.equal(value.defaultDirectory, overrides.ST_DEFAULTS_DIR);
    assert.equal(value.tokenizersDirectory, overrides.ST_TOKENIZERS_DIR);
    assert.equal(value.PUBLIC_DIRECTORIES.backups, path.join(overrides.ST_USER_DATA_DIR, 'backups'));
    assert.equal(value.PUBLIC_DIRECTORIES.globalExtensions, path.join(overrides.ST_USER_DATA_DIR, '_global-extensions'));
    assert.equal(value.DEFAULT_AVATAR_PATH, path.join(overrides.ST_PUBLIC_DIR, 'img', 'ai4.png'));
});

test('relative environment paths fail before any startup writes', () => {
    const result = inspect({ ST_PUBLIC_DIR: 'relative/frontend' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ST_PUBLIC_DIR must be an absolute/);
});
