import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setConfigFilePath } from '../../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../../default/config.yaml', import.meta.url)));
const { copySettingsBackup, restoreSettingsSnapshot } = await import('../../src/endpoints/settings.js');

test('manual and automatic snapshots in one second get distinct names and retain both byte versions', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-settings-snapshot-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const backups = path.join(root, 'backups');
    const settings = path.join(root, 'settings.json');
    await fs.mkdir(backups);
    const original = Buffer.from('{"fixture":"before","text":"안녕 🙂"}\n');
    const changed = Buffer.from('{"fixture":"after","text":"café"}\n');
    await fs.writeFile(settings, original);
    const first = copySettingsBackup(settings, backups, 'default-user', '20260930-120000');
    await fs.writeFile(settings, changed);
    const second = copySettingsBackup(settings, backups, 'default-user', '20260930-120000');
    assert.equal(first, 'settings_default-user_20260930-120000.json');
    assert.equal(second, 'settings_default-user_20260930-120000_1.json');
    assert.deepEqual(await fs.readFile(path.join(backups, first)), original);
    assert.deepEqual(await fs.readFile(path.join(backups, second)), changed);
    restoreSettingsSnapshot(path.join(backups, first), settings);
    assert.deepEqual(await fs.readFile(settings), original);
});

test('failed or malformed restore leaves the live settings file intact', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-settings-restore-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const live = path.join(root, 'settings.json');
    const broken = path.join(root, 'broken.json');
    const original = Buffer.from('{"fixture":"live"}\n');
    await fs.writeFile(live, original);
    await fs.writeFile(broken, '{ invalid JSON');
    assert.throws(() => restoreSettingsSnapshot(broken, live), /Unexpected token|JSON/);
    assert.deepEqual(await fs.readFile(live), original);
    assert.throws(() => restoreSettingsSnapshot(path.join(root, 'missing.json'), live), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(live), original);
    assert.throws(() => copySettingsBackup(live, root, '../outside', '20260930-120000'), /Invalid settings backup name/);
});

test('colliding symbolic snapshot is neither overwritten nor accepted for restore', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-settings-symlink-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const backups = path.join(root, 'backups');
    const live = path.join(root, 'settings.json');
    const outside = path.join(root, 'outside.json');
    await fs.mkdir(backups);
    await fs.writeFile(live, '{"fixture":"live"}\n');
    await fs.writeFile(outside, '{"fixture":"outside"}\n');
    const first = copySettingsBackup(live, backups, 'default-user', '20260930-120000');
    const link = path.join(backups, 'settings_default-user_20260930-120000_1.json');
    try { await fs.symlink(outside, link); }
    catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
            t.diagnostic('Windows account lacks file-symlink privilege; macOS CI exercises this branch.');
            return;
        }
        throw error;
    }
    const third = copySettingsBackup(live, backups, 'default-user', '20260930-120000');
    assert.equal(third, 'settings_default-user_20260930-120000_2.json');
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.equal((await fs.readFile(outside, 'utf8')), '{"fixture":"outside"}\n');
    assert.throws(() => restoreSettingsSnapshot(link, live), /ordinary file/);
    assert.equal((await fs.readFile(live, 'utf8')), '{"fixture":"live"}\n');
    assert.deepEqual(await fs.readFile(path.join(backups, first)), await fs.readFile(path.join(backups, third)));
});
