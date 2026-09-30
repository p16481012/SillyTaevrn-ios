import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { read as readCard } from '../../src/character-card-parser.js';

const baseURL = 'http://127.0.0.1:8000';
const userRoot = 'Documents/SillyTavern/default-user';
const allowedRoutes = new Set([
    '/api/characters/import', '/api/characters/get', '/api/chats/get', '/api/chats/import',
    '/api/chats/export', '/api/chats/save', '/api/chats/delete', '/api/backups/chat/get',
    '/api/backups/chat/download', '/api/settings/get', '/api/settings/save',
    '/api/settings/get-snapshots', '/api/settings/make-snapshot', '/api/settings/load-snapshot',
    '/api/settings/restore-snapshot',
    '/api/users/backup',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeFilename = name => typeof name === 'string' && name.length > 0 && name.length <= 180
    && !/[\0/\\]/.test(name) && name !== '.' && name !== '..' && path.basename(name) === name;
const jsonl = bytes => bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));

/** The caller uses the real CSRF/session middleware and only the local, listed data-transfer routes. */
export async function createTransferClient({ fetchImpl = fetch, origin = baseURL } = {}) {
    if (origin !== baseURL) throw new Error('Transfer validation requires the owned native loopback origin.');
    const csrfResponse = await fetchImpl(`${origin}/csrf-token`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert.equal(csrfResponse.status, 200, 'Native CSRF endpoint failed');
    const token = (await csrfResponse.json()).token;
    assert.ok(typeof token === 'string' && token.length > 0 && token !== 'disabled', 'CSRF must remain enabled');
    const cookie = (csrfResponse.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,]+=)/)
        .map(value => value.split(';')[0].trim()).join('; ');
    assert.ok(cookie, 'Native CSRF session cookie is required');

    return async function request(route, { json, fields, upload, binary = false } = {}) {
        if (!allowedRoutes.has(route)) throw new Error(`Transfer route is not allowlisted: ${route}`);
        if (upload && (!safeFilename(upload.name) || !Buffer.isBuffer(upload.bytes) || upload.bytes.length > 4 * 1024 * 1024)) {
            throw new Error('Unsafe transfer upload');
        }
        if (upload && json !== undefined) throw new Error('Transfer request cannot mix JSON and multipart data');
        const headers = { 'X-CSRF-Token': token, Cookie: cookie, 'Accept-Encoding': 'identity' };
        let body;
        if (upload) {
            const form = new FormData();
            for (const [name, value] of Object.entries(fields ?? {})) {
                if (!/^[a-z_]+$/.test(name) || typeof value !== 'string') throw new Error('Unsafe transfer field');
                form.set(name, value);
            }
            form.set('avatar', new Blob([upload.bytes], { type: upload.type ?? 'application/octet-stream' }), upload.name);
            body = form;
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(json ?? {});
        }
        const response = await fetchImpl(`${origin}${route}`, { method: 'POST', headers, body,
            signal: AbortSignal.timeout(15000), redirect: 'error' });
        assert.ok(response.status === 200 || response.status === 204, `Transfer API failed: ${route} (${response.status})`);
        const bound = route === '/api/users/backup' ? 32 * 1024 * 1024 : 4 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        if (response.body) {
            const reader = response.body.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > bound) { await reader.cancel(); throw new Error(`Transfer API response exceeds ${bound} bytes: ${route}`); }
                chunks.push(Buffer.from(value));
            }
        }
        const bytes = Buffer.concat(chunks);
        if (binary) return bytes;
        if (response.status === 204) return null;
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    };
}

/** Decode only expected generated ZIP entries and reject secret/path leakage. */
export async function verifyFullBackupArchive(bytes, expected, excludedBackupFiles) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32 * 1024 * 1024);
    assert.ok(Array.isArray(excludedBackupFiles) && excludedBackupFiles.length >= 2,
        'Full-backup exclusion requires seeded synthetic secret files');
    const matched = new Set();
    const expectedNames = new Set(Object.keys(expected));
    const excluded = excludedBackupFiles.map(file => {
        const name = file.path.slice(`${userRoot}/`.length);
        assert.ok(file.path.startsWith(`${userRoot}/`) && Buffer.isBuffer(file.bytes)
            && typeof file.marker === 'string' && file.marker.length >= 16
            && file.bytes.includes(Buffer.from(file.marker)) && !expectedNames.has(name),
        'Synthetic secret fixture is missing or overlaps exported data');
        return { name, marker: Buffer.from(file.marker) };
    });
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
            if (openError) { reject(openError); return; }
            const seen = new Set();
            let settled = false;
            const fail = error => { if (!settled) { settled = true; zip.close(); reject(error); } };
            zip.on('error', fail);
            zip.on('entry', entry => {
                const name = entry.fileName;
                if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || seen.has(name)) {
                    fail(new Error(`Unsafe or duplicate full-backup ZIP entry: ${name}`)); return;
                }
                seen.add(name);
                if (name === 'secrets.json' || /^backups\/secrets_migration_.*\.json$/.test(name)
                    || excluded.some(file => file.name === name)) {
                    fail(new Error('Full-data backup exposed a secret file')); return;
                }
                if (name.endsWith('/')) {
                    if (entry.uncompressedSize !== 0) fail(new Error(`Full-backup directory contains bytes: ${name}`));
                    else zip.readEntry();
                    return;
                }
                zip.openReadStream(entry, (streamError, stream) => {
                    if (streamError) { fail(streamError); return; }
                    const chunks = [];
                    let size = 0;
                    stream.on('error', fail);
                    stream.on('data', chunk => {
                        if (settled) return;
                        size += chunk.length;
                        if (size > 4 * 1024 * 1024) { stream.destroy(); fail(new Error(`Generated ZIP entry exceeds 4 MiB: ${name}`)); }
                        else chunks.push(chunk);
                    });
                    stream.on('end', () => {
                        if (settled) return;
                        try {
                            const contents = Buffer.concat(chunks);
                            assert.ok(excluded.every(file => !contents.includes(file.marker)),
                                `Full-data backup exposed synthetic secret content in ${name}`);
                            if (expectedNames.has(name)) {
                                assert.deepEqual(contents, expected[name], `Full-backup ZIP entry changed: ${name}`);
                                matched.add(name);
                            }
                            zip.readEntry();
                        } catch (error) { fail(error); }
                    });
                });
            });
            zip.on('end', () => {
                if (settled) return;
                try { assert.deepEqual(matched, expectedNames, 'Full-backup ZIP missed generated user data'); }
                catch (error) { fail(error); return; }
                settled = true;
                resolve({ zipSHA256: sha256(bytes), bytes: bytes.length, matchedEntries: matched.size,
                    secretsExcluded: true, syntheticSecretFilesExcluded: excluded.length,
                    syntheticSecretPayloadsAbsent: true, automaticFullZipRestore: false });
            });
            zip.readEntry();
        });
    });
}

function fixtureFile(fixture, kind) {
    const file = fixture.files.find(item => item.kind === kind);
    assert.ok(file, `Missing generated ${kind} fixture`);
    return file;
}

function validateImportedCharacter(character, fixture) {
    assert.equal(character.name, fixture.card.data.name);
    assert.equal(character.data.description, fixture.card.data.description);
    assert.equal(character.data.first_mes, fixture.card.data.first_mes);
    assert.equal(character.data.extensions.fixtureId, fixture.id);
    const card = JSON.parse(character.json_data);
    assert.equal(card.data.name, fixture.card.data.name);
    assert.equal(card.data.description, fixture.card.data.description);
    assert.equal(card.data.extensions.fixtureId, fixture.id);
    return card;
}

/** Uses the same import/backup/restore endpoints as the frontend, on generated data only. */
export async function runTransferScenario(fixture, { api, readFile, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
    assert.equal(fixture.legacy, false, 'Transfer scenario runs before synthetic legacy migration');
    const cardSource = fixtureFile(fixture, 'character-card');
    const chatSource = fixtureFile(fixture, 'chat');
    const settingsSource = fixtureFile(fixture, 'persona-settings');
    assert.deepEqual(await readFile(cardSource.path), cardSource.bytes, 'Source PNG bytes changed before import');
    assert.deepEqual(await readFile(chatSource.path), chatSource.bytes, 'Source JSONL bytes changed before export');
    assert.deepEqual(await readFile(settingsSource.path), settingsSource.bytes, 'Source settings changed before snapshot');
    for (const file of fixture.excludedBackupFiles) {
        assert.deepEqual(await readFile(file.path), file.bytes, `Synthetic secret fixture changed before export: ${file.kind}`);
    }

    const exported = await api('/api/chats/export', { json: { file: path.basename(chatSource.path),
        avatar_url: fixture.names.avatar, is_group: false, format: 'jsonl', exportfilename: 'synthetic-export.jsonl' } });
    assert.equal(exported.result, chatSource.bytes.toString('utf8'), 'JSONL export must preserve Unicode and source bytes');
    const imported = await api('/api/characters/import', { fields: { file_type: 'png', user_name: fixture.settings.username },
        upload: { name: fixture.names.avatar, bytes: cardSource.bytes, type: 'image/png' } });
    assert.ok(safeFilename(imported.file_name) && !path.extname(imported.file_name)
        && imported.file_name !== path.parse(fixture.names.avatar).name,
    'Character import must create a separate PNG basename');
    const avatar = `${imported.file_name}.png`;
    const card = await api('/api/characters/get', { json: { avatar_url: avatar } });
    validateImportedCharacter(card, fixture);
    const importedCardBytes = await readFile(`${userRoot}/characters/${avatar}`);
    const importedCard = JSON.parse(readCard(importedCardBytes));
    assert.equal(importedCard.data.extensions.fixtureId, fixture.id, 'Imported PNG must preserve card metadata');
    assert.equal(importedCard.data.description, fixture.card.data.description);
    const chatDirectory = path.parse(avatar).name;
    // Selecting an imported card normally creates its chat folder through this endpoint.
    await api('/api/chats/get', { json: { avatar_url: avatar } });
    const importFields = { file_type: 'jsonl', avatar_url: avatar, user_name: fixture.settings.username,
        character_name: fixture.card.data.name };
    const firstImport = await api('/api/chats/import', { fields: importFields,
        upload: { name: 'synthetic-export.jsonl', bytes: Buffer.from(exported.result) } });
    assert.equal(firstImport.res, true);
    assert.equal(firstImport.fileNames?.length, 1);
    const firstName = firstImport.fileNames[0];
    assert.ok(safeFilename(firstName) && firstName.endsWith('.jsonl'));
    assert.deepEqual(await readFile(`${userRoot}/chats/${chatDirectory}/${firstName}`), chatSource.bytes,
        'Imported JSONL must preserve exported bytes');
    assert.deepEqual(await api('/api/chats/get', { json: { avatar_url: avatar, file_name: path.parse(firstName).name } }), fixture.chat);

    // A real save creates the chat backup. The user's restore action downloads it and re-imports it.
    const saved = await api('/api/chats/save', { json: { avatar_url: avatar, file_name: path.parse(firstName).name, chat: fixture.chat } });
    assert.equal(saved.ok, true);
    const savedBytes = Buffer.from(fixture.chat.map(row => JSON.stringify(row)).join('\n'));
    assert.deepEqual(await readFile(`${userRoot}/chats/${chatDirectory}/${firstName}`), savedBytes);
    const backups = await api('/api/backups/chat/get');
    assert.ok(Array.isArray(backups));
    const backupPrefix = `chat_${chatDirectory.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_`;
    const matching = backups.filter(item => item.file_name?.startsWith(backupPrefix) && item.file_name?.endsWith('.jsonl'));
    assert.equal(matching.length, 1, 'Save must create exactly one owned chat backup');
    const backupName = matching[0].file_name;
    assert.ok(safeFilename(backupName));
    const backupBytes = await api('/api/backups/chat/download', { json: { name: backupName }, binary: true });
    assert.deepEqual(backupBytes, savedBytes, 'Downloaded backup must equal saved JSONL bytes');
    assert.deepEqual(await readFile(`${userRoot}/backups/${backupName}`), savedBytes);
    const deleted = await api('/api/chats/delete', { json: { avatar_url: avatar, chatfile: firstName } });
    assert.equal(deleted.ok, true);
    await assert.rejects(readFile(`${userRoot}/chats/${chatDirectory}/${firstName}`), { code: 'ENOENT' });
    const restored = await api('/api/chats/import', { fields: importFields,
        upload: { name: backupName, bytes: backupBytes } });
    assert.equal(restored.res, true);
    assert.equal(restored.fileNames?.length, 1);
    const restoredName = restored.fileNames[0];
    assert.ok(safeFilename(restoredName) && restoredName.endsWith('.jsonl'));
    const restoredBytes = await readFile(`${userRoot}/chats/${chatDirectory}/${restoredName}`);
    assert.deepEqual(restoredBytes, backupBytes, 'Restored JSONL must equal the downloaded backup');
    assert.deepEqual(await api('/api/chats/get', { json: { avatar_url: avatar, file_name: path.parse(restoredName).name } }), fixture.chat);

    // The upstream settings snapshot route restores the exact original file after an API mutation.
    const oldSnapshots = new Set((await api('/api/settings/get-snapshots')).map(item => item.name));
    let snapshotName;
    for (let attempt = 0; attempt < 2 && !snapshotName; attempt++) {
        await api('/api/settings/make-snapshot');
        const recent = (await api('/api/settings/get-snapshots')).map(item => item.name).filter(name => !oldSnapshots.has(name));
        if (recent.length === 1) snapshotName = recent[0];
        else if (recent.length > 1) throw new Error('Snapshot creation was ambiguous');
        else if (attempt === 0) await wait(1100); // Names have one-second resolution.
    }
    assert.ok(safeFilename(snapshotName) && /^settings_default-user_[0-9]{8}-[0-9]{6}(?:_[1-9][0-9]*)?\.json$/.test(snapshotName),
        'The fixture must own an identifiable settings snapshot');
    const snapshotBytes = Buffer.from(await api('/api/settings/load-snapshot', { json: { name: snapshotName }, binary: true }));
    assert.deepEqual(snapshotBytes, settingsSource.bytes, 'Snapshot must preserve original settings bytes');
    assert.deepEqual(await readFile(`${userRoot}/backups/${snapshotName}`), settingsSource.bytes);
    const changed = structuredClone(fixture.settings);
    changed.simulatorDataValidation.transferMutation = true;
    assert.equal((await api('/api/settings/save', { json: changed })).result, 'ok');
    assert.deepEqual(await readFile(`${userRoot}/backups/${snapshotName}`), settingsSource.bytes,
        'Automatic same-second save must not overwrite the manual snapshot');
    assert.notDeepEqual(await readFile(settingsSource.path), settingsSource.bytes);
    assert.equal(JSON.parse((await api('/api/settings/get')).settings).simulatorDataValidation.transferMutation, true);
    await api('/api/settings/restore-snapshot', { json: { name: snapshotName } });
    const restoredSettingsBytes = await readFile(settingsSource.path);
    assert.ok(restoredSettingsBytes.equals(settingsSource.bytes),
        `Restored settings bytes must equal the snapshot (current ${sha256(restoredSettingsBytes)}, snapshot ${sha256(snapshotBytes)}, currentMutation ${JSON.parse(restoredSettingsBytes).simulatorDataValidation?.transferMutation ?? false})`);
    assert.deepEqual(JSON.parse((await api('/api/settings/get')).settings), fixture.settings);

    const archived = Object.fromEntries(fixture.files.map(file => [file.path.slice(`${userRoot}/`.length), file.bytes]));
    archived[`characters/${avatar}`] = importedCardBytes;
    archived[`chats/${chatDirectory}/${restoredName}`] = restoredBytes;
    archived[`backups/${backupName}`] = backupBytes;
    archived[`backups/${snapshotName}`] = snapshotBytes;
    const archive = await verifyFullBackupArchive(await api('/api/users/backup', { json: { handle: 'default-user' }, binary: true }),
        archived, fixture.excludedBackupFiles);

    const state = { avatar, restoredName, backupName, snapshotName,
        originalCardSHA256: sha256(cardSource.bytes), importedCardSHA256: sha256(importedCardBytes),
        originalChatSHA256: sha256(chatSource.bytes), backupSHA256: sha256(backupBytes),
        restoredChatSHA256: sha256(restoredBytes), settingsSHA256: sha256(settingsSource.bytes) };
    const report = { importedCharacter: true, importedCardMetadata: true, exportedChatBytes: true,
        importedChatBytes: true, chatBackupCreatedBySave: true, chatBackupDownloaded: true,
        deletedImportedChat: true, restoredChatFromBackup: true, settingsSnapshotMutatedAndRestored: true,
        fullDataZipExportChecked: true, fullDataZipRestoreAvailable: false, archive, ...state };
    return { state, report };
}

/** Called only after an actual simulator app process has terminated and launched again. */
export async function verifyTransferReopen(fixture, state, { api, readFile }) {
    assert.ok(safeFilename(state?.avatar) && safeFilename(state?.restoredName)
        && safeFilename(state?.backupName) && safeFilename(state?.snapshotName), 'Missing owned transfer state');
    const chatDirectory = path.parse(state.avatar).name;
    const cardBytes = await readFile(`${userRoot}/characters/${state.avatar}`);
    assert.equal(sha256(cardBytes), state.importedCardSHA256, 'Imported PNG bytes changed after cold restart');
    validateImportedCharacter(await api('/api/characters/get', { json: { avatar_url: state.avatar } }), fixture);
    const chatBytes = await readFile(`${userRoot}/chats/${chatDirectory}/${state.restoredName}`);
    assert.equal(sha256(chatBytes), state.restoredChatSHA256, 'Restored chat bytes changed after cold restart');
    assert.deepEqual(jsonl(chatBytes), fixture.chat);
    assert.deepEqual(await api('/api/chats/get', { json: { avatar_url: state.avatar,
        file_name: path.parse(state.restoredName).name } }), fixture.chat);
    const backupBytes = await api('/api/backups/chat/download', { json: { name: state.backupName }, binary: true });
    assert.equal(sha256(backupBytes), state.backupSHA256, 'Chat backup bytes changed after cold restart');
    assert.deepEqual(backupBytes, chatBytes);
    const settingsBytes = await readFile(fixtureFile(fixture, 'persona-settings').path);
    assert.equal(sha256(settingsBytes), state.settingsSHA256, 'Restored settings bytes changed after cold restart');
    assert.deepEqual(JSON.parse((await api('/api/settings/get')).settings), fixture.settings);
    assert.deepEqual(await api('/api/settings/load-snapshot', { json: { name: state.snapshotName }, binary: true }), settingsBytes);
    for (const file of fixture.excludedBackupFiles) {
        assert.deepEqual(await readFile(file.path), file.bytes, `Synthetic secret fixture changed after cold restart: ${file.kind}`);
    }
    return { importedCharacterReopened: true, cardMetadataReopened: true, restoredChatReopened: true,
        chatBackupReopened: true, settingsSnapshotReopened: true, coldProcessRestart: true,
        syntheticSecretFixturesPreserved: true,
        avatar: state.avatar, restoredName: state.restoredName,
        restoredChatSHA256: state.restoredChatSHA256, settingsSHA256: state.settingsSHA256 };
}
