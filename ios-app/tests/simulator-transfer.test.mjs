import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import archiver from 'archiver';
import { createDataFixture } from '../scripts/simulator-data-fixture.mjs';
import { createTransferClient, runTransferScenario, verifyFullBackupArchive } from '../scripts/simulator-transfer-fixture.mjs';

async function zipFiles(files) {
    const archive = archiver('zip');
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    archive.pipe(output);
    for (const [name, bytes] of Object.entries(files)) archive.append(bytes, { name });
    const ended = new Promise((resolve, reject) => { output.once('end', resolve); output.once('error', reject); archive.once('error', reject); });
    await archive.finalize();
    await ended;
    return Buffer.concat(chunks);
}

test('full-data ZIP verification compares generated entries and rejects missing data and secrets', async () => {
    const generated = { 'settings.json': Buffer.from('{"firstRun":true}'),
        'characters/test.png': Buffer.from('generated PNG fixture'), 'chats/test/chat.jsonl': Buffer.from('한국어 🙂\n') };
    const excluded = [
        { path: 'Documents/SillyTavern/default-user/secrets.json', marker: 'synthetic-live-secret-fixture',
            bytes: Buffer.from('{"value":"synthetic-live-secret-fixture"}') },
        { path: 'Documents/SillyTavern/default-user/backups/secrets_migration_fixture.json',
            marker: 'synthetic-migrated-secret-fixture', bytes: Buffer.from('{"value":"synthetic-migrated-secret-fixture"}') },
    ];
    const report = await verifyFullBackupArchive(await zipFiles(generated), generated, excluded);
    assert.equal(report.matchedEntries, 3);
    assert.equal(report.secretsExcluded, true);
    assert.equal(report.syntheticSecretFilesExcluded, 2);
    assert.equal(report.syntheticSecretPayloadsAbsent, true);
    assert.equal(report.automaticFullZipRestore, false);
    await assert.rejects(verifyFullBackupArchive(await zipFiles(generated), { ...generated,
        'worlds/missing.json': Buffer.from('{}') }, excluded), /missed generated user data/);
    await assert.rejects(verifyFullBackupArchive(await zipFiles({ ...generated, 'secrets.json': excluded[0].bytes }), generated, excluded),
        /exposed a secret file/);
    await assert.rejects(verifyFullBackupArchive(await zipFiles({ ...generated, 'backups/secrets_migration_test.json': excluded[1].bytes }), generated, excluded),
        /exposed a secret file/);
    await assert.rejects(verifyFullBackupArchive(await zipFiles({ ...generated,
        'user/files/leak.txt': excluded[0].bytes }), generated, excluded), /exposed synthetic secret content/);
    await assert.rejects(verifyFullBackupArchive(await zipFiles({ ...generated, 'settings.json': Buffer.from('changed') }), generated, excluded),
        /Full-backup ZIP entry changed/);
    await assert.rejects(verifyFullBackupArchive(await zipFiles(generated), generated, []),
        /requires seeded synthetic secret files/);
});

test('transfer client accepts only listed local routes and bounded generated uploads', async () => {
    const csrf = () => new Response(JSON.stringify({ token: 'generated-csrf' }),
        { status: 200, headers: { 'set-cookie': 'connect.sid=generated-session; Path=/; HttpOnly' } });
    const calls = [];
    const api = await createTransferClient({ fetchImpl: async (url, options) => {
        calls.push([url, options]);
        if (url.endsWith('/csrf-token')) return csrf();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } });
    await assert.rejects(api('/api/chats/generate', { json: {} }), /not allowlisted/);
    await assert.rejects(api('/api/chats/import', { fields: { file_type: 'jsonl' },
        upload: { name: '../outside.jsonl', bytes: Buffer.from('{}') } }), /Unsafe transfer upload/);
    await assert.rejects(api('/api/chats/import', { fields: { unsafeField: 'x' },
        upload: { name: 'safe.jsonl', bytes: Buffer.from('{}') } }), /Unsafe transfer field/);
    assert.deepEqual(await api('/api/chats/save', { json: { owned: true } }), { ok: true });
    assert.equal(calls.length, 2, 'Rejected operations cannot reach HTTP');
    assert.match(calls[1][1].headers.Cookie, /generated-session/);
    assert.equal(calls[1][1].headers['X-CSRF-Token'], 'generated-csrf');
    await assert.rejects(createTransferClient({ origin: 'https://api.example.com' }), /owned native loopback/);
});

test('transfer refuses a changed original card/chat/settings before any import', async () => {
    const fixture = createDataFixture('transfer-guard', { firstRun: true, username: 'User', power_user: {} });
    let calls = 0;
    const readFile = async relative => {
        const file = fixture.files.find(item => item.path === relative);
        return relative.endsWith('/settings.json') ? Buffer.from('changed settings') : file.bytes;
    };
    await assert.rejects(runTransferScenario(fixture, { readFile,
        api: async () => { calls++; throw new Error('No API writes allowed'); } }), /Source settings changed/);
    assert.equal(calls, 0);
});
