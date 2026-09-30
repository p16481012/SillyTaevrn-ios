import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import yaml from 'yaml';

export const legacySource = 'elouannd/SillyTavern-foriOS@97ba01f56a454c6a1c8a06c5017f22abef329d04';
export const fileDigest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 4) + '\n');
const userRoot = 'Documents/SillyTavern/default-user';

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
    const type = Buffer.from(name, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, crc]);
}

/** A generated 2x2 image; no user artwork or external binary fixture. */
export function fixturePNG(metadata) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(2, 4);
    header[8] = 8;
    header[9] = 6;
    const pixel = Buffer.from([45, 108, 191, 255]);
    const row = Buffer.concat([Buffer.from([0]), pixel, pixel]);
    const chunks = [chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat([row, row])))];
    if (metadata) chunks.push(chunk('tEXt', Buffer.from(`chara\0${Buffer.from(JSON.stringify(metadata)).toString('base64')}`, 'ascii')));
    chunks.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

/** Shapes are supported by the pinned 1.17 source: character cards, chats and personas. */
export function createDataFixture(id, initialSettings = {}, { legacy = false } = {}) {
    if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error('Unsafe fixture ID.');
    const names = { character: `st-card-${id}`, chat: `st-chat-${id}`, world: `st-world-${id}`,
        preset: `st-preset-${id}`, persona: `st-persona-${id}.png`, userFile: `simulator-validation-${id}.txt` };
    names.avatar = `${names.character}.png`;
    const characterFields = { name: `검증 캐릭터 ${id}`, description: '보존할 캐릭터 설명 🙂', personality: '테스트 전용',
        scenario: '오프라인 데이터 보존 검사', first_mes: '안녕하세요, 합성 fixture입니다.', mes_example: '',
        creator: 'SillyTavern Simulator validation', tags: ['synthetic-fixture'], character_version: '1',
        creator_notes: 'No user data, credentials or paid calls.', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], extensions: { fixtureId: id, fav: true, world: names.world, talkativeness: 0.5 } };
    const card = legacy ? { ...characterFields, creatorcomment: characterFields.creator_notes, chat: names.chat,
        fav: true, talkativeness: 0.5 } : { spec: 'chara_card_v2', spec_version: '2.0', data: characterFields, chat: names.chat };
    const personaName = `검증 사용자 ${id}`;
    const chat = [{ user_name: personaName, character_name: characterFields.name,
        chat_metadata: { fixtureId: id, persona: names.persona } },
    { name: personaName, is_user: true, is_system: false, send_date: '2026-09-29T00:00:00.000Z', mes: '보존할 한국어 채팅 🙂', extra: {} },
    { name: characterFields.name, is_user: false, is_system: false, send_date: '2026-09-29T00:00:01.000Z', mes: '합성 응답입니다.', extra: {}, swipes: ['합성 응답입니다.'], swipe_id: 0 }];
    const world = { name: names.world, extensions: { fixtureId: id }, entries: { 0: { uid: 0, key: ['fixture'], keysecondary: [],
        comment: '합성 설정집', content: '보존할 월드정보 내용 🙂', constant: true, selective: false, order: 100, position: 0, disable: false } } };
    const preset = { temp_openai: 0.61, top_p_openai: 0.93, openai_max_tokens: 128, stream_openai: true, fixtureId: id };
    const settings = structuredClone(initialSettings);
    settings.firstRun = true; // The data check does not complete or bypass native onboarding.
    settings.username = personaName;
    settings.user_avatar = names.persona;
    settings.simulatorDataValidation = { id, legacy, source: legacy ? legacySource : 'generated-current-format' };
    settings.power_user ??= {};
    settings.power_user.personas = { ...settings.power_user.personas, [names.persona]: personaName };
    settings.power_user.persona_descriptions = { ...settings.power_user.persona_descriptions,
        [names.persona]: { description: '보존할 페르소나 설명 🙂', position: 0, depth: 2, role: 0, title: '합성 검증' } };
    settings.power_user.default_persona = names.persona;
    const files = [
        { kind: 'chat', path: `${userRoot}/chats/${names.character}/${names.chat}.jsonl`, bytes: Buffer.from(chat.map(line => JSON.stringify(line)).join('\n') + '\n') },
        { kind: 'character-card', path: `${userRoot}/characters/${names.avatar}`, bytes: fixturePNG(card) },
        { kind: 'world-info', path: `${userRoot}/worlds/${names.world}.json`, bytes: json(world) },
        { kind: 'preset', path: `${userRoot}/OpenAI Settings/${names.preset}.json`, bytes: json(preset) },
        { kind: 'persona-image', path: `${userRoot}/User Avatars/${names.persona}`, bytes: fixturePNG() },
        { kind: 'persona-settings', path: `${userRoot}/settings.json`, bytes: json(settings) },
        { kind: 'user-file', path: `${userRoot}/user/files/${names.userFile}`, bytes: Buffer.from(`Synthetic ${id}\nNo secrets or external API calls.\n`) },
    ];
    // These generated values are deliberately unlike credentials. They prove that
    // the real full-data export omits both live and migrated secret files.
    const excludedBackupFiles = [
        { kind: 'synthetic-secret', path: `${userRoot}/secrets.json`, marker: `synthetic-live-secret-${id}`,
            bytes: json({ simulator_validation: [{ id, value: `synthetic-live-secret-${id}`, label: 'Generated validation data', active: true }] }) },
        { kind: 'synthetic-migrated-secret', path: `${userRoot}/backups/secrets_migration_${id}.json`,
            marker: `synthetic-migrated-secret-${id}`, bytes: json({ simulator_validation: `synthetic-migrated-secret-${id}` }) },
    ];
    return { id, legacy, names, card, chat, world, preset, settings, files, excludedBackupFiles };
}

/** Deprecated options accepted by 1.17's config-init, not a real user's export. */
export function legacyConfig(id) {
    if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error('Unsafe fixture ID.');
    return Buffer.from(yaml.stringify({ port: 8000, listen: false, enableIPv4: true, enableIPv6: false,
        enableUserAccounts: false, basicAuthMode: false, whitelistMode: false,
        browserLaunch: { enabled: false }, dataRoot: './data',
        disableThumbnails: true, thumbnailsQuality: 43, avatarThumbnailsPng: true,
        disableChatBackup: false, numberOfBackups: 17,
        enableExtensions: true, enableExtensionsAutoUpdate: false,
        simulatorDataValidation: { id, source: legacySource, synthetic: true } }));
}

export function verifyLegacyConfig(bytes, id) {
    const config = yaml.parse(bytes.toString('utf8'));
    assert.equal(config.simulatorDataValidation.id, id);
    assert.equal(config.simulatorDataValidation.synthetic, true);
    assert.equal(config.thumbnails.enabled, false);
    assert.equal(config.thumbnails.quality, 43);
    assert.equal(config.thumbnails.format, 'png');
    assert.equal(config.backups.chat.enabled, true);
    assert.equal(config.backups.common.numberOfBackups, 17);
    assert.equal(config.extensions.enabled, true);
    assert.equal(config.extensions.autoUpdate, false);
    for (const key of ['disableThumbnails', 'thumbnailsQuality', 'avatarThumbnailsPng', 'disableChatBackup',
        'numberOfBackups', 'enableExtensions', 'enableExtensionsAutoUpdate']) assert.equal(Object.hasOwn(config, key), false);
    return { syntheticSourceVersion: '1.17', sourceReference: legacySource, deprecatedKeysMigrated: 7,
        valuesPreserved: true, configSHA256: fileDigest(bytes) };
}

export async function createReadClient({ baseURL = 'http://127.0.0.1:8000', fetchImpl = fetch } = {}) {
    const base = new URL(baseURL);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.pathname !== '/') {
        throw new Error('Fixture API reads require a local HTTP server.');
    }
    const response = await fetchImpl(new URL('/csrf-token', base), { signal: AbortSignal.timeout(15000), redirect: 'error' });
    assert.equal(response.status, 200, 'CSRF token endpoint failed');
    const token = (await response.json()).token;
    assert.ok(typeof token === 'string' && token.length > 0 && token !== 'disabled', 'CSRF must remain enabled');
    const cookie = (response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,]+=)/).map(value => value.split(';')[0].trim()).join('; ');
    assert.ok(cookie, 'CSRF session cookie is required');
    return async (route, body, binary = false) => {
        if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Unsafe fixture API route.');
        const result = await fetchImpl(new URL(route, base), { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: cookie },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' });
        assert.equal(result.status, 200, `Fixture API failed: ${route}`);
        return binary ? Buffer.from(await result.arrayBuffer()) : result.json();
    };
}

export async function verifyReadableFixture(fixture, client) {
    const settingsResult = await client('/api/settings/get', {});
    const settings = JSON.parse(settingsResult.settings);
    assert.deepEqual(settings, fixture.settings, 'Full saved settings must reopen');
    const presetIndex = settingsResult.openai_setting_names.indexOf(fixture.names.preset);
    assert.ok(presetIndex >= 0, 'Saved preset is missing');
    const preset = settingsResult.openai_settings[presetIndex];
    assert.deepEqual(typeof preset === 'string' ? JSON.parse(preset) : preset, fixture.preset);
    const character = await client('/api/characters/get', { avatar_url: fixture.names.avatar });
    assert.equal(character.name, fixture.legacy ? fixture.card.name : fixture.card.data.name);
    assert.deepEqual(JSON.parse(character.json_data), fixture.card, 'PNG character metadata must reopen unchanged');
    assert.equal(character.data.description, '보존할 캐릭터 설명 🙂');
    assert.deepEqual(await client('/api/chats/get', { avatar_url: fixture.names.avatar, file_name: fixture.names.chat }), fixture.chat);
    assert.deepEqual(await client('/api/worldinfo/get', { name: fixture.names.world }), fixture.world);
    assert.ok((await client('/api/avatars/get', {})).includes(fixture.names.persona));
    const persona = fixture.files.find(file => file.kind === 'persona-image');
    const userFile = fixture.files.find(file => file.kind === 'user-file');
    assert.deepEqual(await client(`/User%20Avatars/${encodeURIComponent(fixture.names.persona)}`, undefined, true), persona.bytes);
    assert.deepEqual(await client(`/user/files/${encodeURIComponent(fixture.names.userFile)}`, undefined, true), userFile.bytes);
    return { apiReadCheck: 'passed', chatRead: true, characterMetadataRead: true, worldInfoRead: true,
        presetRead: true, personaImageAndSettingsRead: true, userFileRead: true, paidCalls: false };
}
