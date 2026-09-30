import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';

import express from 'express';
import git from 'isomorphic-git';
import defaultHttp from 'isomorphic-git/http/node';
import { IOSGitClient } from '../../src/git/ios-client.js';

const remoteUrl = 'https://fixture.invalid/extension.git';
const author = { name: 'Extension fixture', email: 'fixture@example.invalid' };
let temporaryRoot;
let router;
let installIOSRoutes;
let fixtureNumber = 0;
const originalRequest = defaultHttp.request;
const originalCompressionStream = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');

before(async () => {
    // Fixture commits exercise Git object encoding (not an extension API operation).
    // Node18's optional CompressionStream path instantiates its WASM-backed Undici
    // Response. Use the real pure-JS pako encoder when validating without WASM.
    // Clone/fetch/checkout and the actual Node HTTP transport stay unchanged.
    if (typeof WebAssembly === 'undefined') Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: undefined });
    temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-ios-extension-git-'));
    process.env.ST_IOS = '1';
    process.env.ST_USER_DATA_DIR = temporaryRoot;
    process.env.SILLYTAVERN_EXTENSIONS_ENABLED = 'true';
    process.env.SILLYTAVERN_GIT_BACKEND = 'system';
    ({ router } = await import('../../src/endpoints/extensions.js'));
    ({ installIOSRoutes } = await import('../../src/ios-runtime.js'));
});

after(async () => {
    if (originalCompressionStream) Object.defineProperty(globalThis, 'CompressionStream', originalCompressionStream);
    defaultHttp.request = originalRequest;
    if (temporaryRoot) {
        const resolved = await fs.promises.realpath(temporaryRoot);
        const parent = await fs.promises.realpath(os.tmpdir());
        assert.equal(path.dirname(resolved), parent);
        assert.match(path.basename(resolved), /^st-ios-extension-git-/);
        await fs.promises.rm(resolved, { recursive: true, force: true });
    }
});

function packet(value) {
    const data = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}

async function commitFile(directory, filepath, content, message) {
    await fs.promises.writeFile(path.join(directory, filepath), content);
    await git.add({ fs, dir: directory, filepath });
    return git.commit({ fs, dir: directory, author, message });
}

// A smart-HTTP Git transport backed by actual local Git objects. The real clone,
// fetch, pack parsing and checkout run without sockets, DNS or API credentials.
function localTransport(directory) {
    let requests = 0;
    return {
        get requests() { return requests; },
        async request({ url, method = 'GET', body }) {
            requests++;
            const branches = await git.listBranches({ fs, dir: directory });
            const oid = await git.resolveRef({ fs, dir: directory, ref: 'refs/heads/main' });
            if (method === 'GET') {
                assert.match(url, /info\/refs\?service=git-upload-pack$/);
                const advertised = Buffer.concat([
                    packet('# service=git-upload-pack\n'),
                    Buffer.from('0000'),
                    packet(`${oid} HEAD\0multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:refs/heads/main\n`),
                    ...await Promise.all(branches.map(async name => packet(`${await git.resolveRef({ fs, dir: directory, ref: `refs/heads/${name}` })} refs/heads/${name}\n`))),
                    ...await Promise.all((await git.listTags({ fs, dir: directory })).map(async name => packet(`${await git.resolveRef({ fs, dir: directory, ref: `refs/tags/${name}` })} refs/tags/${name}\n`))),
                    Buffer.from('0000'),
                ]);
                return { url, method, statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/x-git-upload-pack-advertisement' }, body: [advertised] };
            }
            assert.equal(method, 'POST');
            assert.match(url, /git-upload-pack$/);
            const requestParts = [];
            for await (const part of body) requestParts.push(Buffer.from(part));
            const requestText = Buffer.concat(requestParts).toString('utf8');
            const objectDirectory = path.join(directory, '.git', 'objects');
            const objects = [];
            for (const folder of await fs.promises.readdir(objectDirectory)) {
                if (!/^[0-9a-f]{2}$/.test(folder)) continue;
                for (const object of await fs.promises.readdir(path.join(objectDirectory, folder))) {
                    if (/^[0-9a-f]{38}$/.test(object)) objects.push(folder + object);
                }
            }
            let packedObjects = objects;
            if (requestText.includes('deepen 1')) {
                const wanted = [...new Set([...requestText.matchAll(/want ([a-f0-9]{40})/g)].map(match => match[1]))];
                assert.ok(wanted.length > 0, 'Real fetch must request advertised commit objects');
                const treeObjects = new Set(wanted);
                async function collectTree(treeOid) {
                    treeObjects.add(treeOid);
                    const { tree } = await git.readTree({ fs, dir: directory, oid: treeOid });
                    for (const entry of tree) {
                        if (entry.type === 'tree') await collectTree(entry.oid);
                        else if (entry.type === 'blob') treeObjects.add(entry.oid);
                    }
                }
                for (const wantedOid of wanted) {
                    const commit = await git.readCommit({ fs, dir: directory, oid: wantedOid });
                    await collectTree(commit.commit.tree);
                }
                packedObjects = [...treeObjects];
            }
            const { packfile } = await git.packObjects({ fs, dir: directory, oids: packedObjects });
            const responseParts = [];
            if (requestText.includes('deepen 1')) {
                for (const wanted of [...new Set([...requestText.matchAll(/want ([a-f0-9]{40})/g)].map(match => match[1]))]) {
                    responseParts.push(packet(`shallow ${wanted}\n`));
                }
                responseParts.push(Buffer.from('0000'));
            }
            responseParts.push(packet('NAK\n'));
            const pack = Buffer.from(packfile);
            for (let offset = 0; offset < pack.length; offset += 65514) {
                responseParts.push(packet(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + 65514)])));
            }
            responseParts.push(Buffer.from('0000'));
            return { url, method, statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/x-git-upload-pack-result' }, body: [Buffer.concat(responseParts)] };
        },
    };
}

async function makeFixture({ clone = true, priorHistory = false } = {}) {
    const base = path.join(temporaryRoot, String(++fixtureNumber));
    const remote = path.join(base, 'remote');
    const extensions = path.join(base, 'extensions');
    const local = path.join(extensions, 'extension');
    await fs.promises.mkdir(remote, { recursive: true });
    await fs.promises.mkdir(extensions);
    await git.init({ fs, dir: remote, defaultBranch: 'main' });
    let previousCommit;
    if (priorHistory) previousCommit = await commitFile(remote, 'manifest.json', '{"version":"0"}', 'Earlier manifest');
    const firstCommit = await commitFile(remote, 'manifest.json', JSON.stringify({ display_name: 'Fixture', version: '1' }), 'Initial manifest');
    const transport = localTransport(remote);
    if (clone) {
        await git.clone({ fs, http: transport, dir: local, url: remoteUrl, depth: 1, singleBranch: true });
    }
    return { remote, extensions, local, firstCommit, previousCommit, transport, client: new IOSGitClient(local, { http: transport }) };
}

async function makeRemoteBranch(fixture, name = 'next') {
    await git.branch({ fs, dir: fixture.remote, ref: name, object: fixture.firstCommit });
    await git.checkout({ fs, dir: fixture.remote, ref: name });
    const oid = await commitFile(fixture.remote, 'manifest.json', JSON.stringify({ display_name: 'Fixture', version: name }), `Commit on ${name}`);
    await git.checkout({ fs, dir: fixture.remote, ref: 'main' });
    return oid;
}

async function assertNoTemporaryDirectories(fixture) {
    assert.deepEqual((await fs.promises.readdir(fixture.extensions)).filter(name => name.startsWith('.st-ios-git-')), []);
}

function postJSON(url, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const request = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('error', reject);
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: response.statusCode, body: text && response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text });
            });
        });
        request.on('error', reject);
        request.end(data);
    });
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function fixtureSnapshot(directory) {
    const entries = [];
    async function visit(relative) {
        const absolute = path.join(directory, relative);
        const stat = await fs.promises.lstat(absolute);
        const entry = { path: relative.split(path.sep).join('/'), mode: stat.mode };
        if (stat.isDirectory()) {
            entry.kind = 'directory'; entries.push(entry);
            for (const child of (await fs.promises.readdir(absolute)).sort()) await visit(path.join(relative, child));
        } else {
            entry.kind = stat.isSymbolicLink() ? 'link' : 'file';
            if (entry.kind === 'file') entry.size = stat.size;
            entry.sha256 = createHash('sha256').update(entry.kind === 'link' ? await fs.promises.readlink(absolute) : await fs.promises.readFile(absolute)).digest('hex');
            entries.push(entry);
        }
    }
    await visit('');
    return { fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

async function interruptedSwitch(fixture, phase) {
    const remoteCommit = await makeRemoteBranch(fixture);
    const snapshot = await fixtureSnapshot(fixture.local);
    const directory = await fs.promises.mkdtemp(path.join(fixture.extensions, '.st-ios-git-switch-'));
    const prepared = path.join(directory, 'prepared');
    const previous = path.join(directory, 'previous');
    const journal = { formatVersion: 1, operation: 'switch', target: 'extension', phase,
        originalFingerprint: snapshot.fingerprint, originalEntries: snapshot.entries };
    if (phase === 'preparing') {
        await fs.promises.mkdir(prepared);
        await fs.promises.copyFile(path.join(fixture.local, 'manifest.json'), path.join(prepared, 'manifest.json'));
    } else {
        await fs.promises.cp(fixture.local, prepared, { recursive: true, verbatimSymlinks: true });
        await git.fetch({ fs, http: fixture.transport, dir: prepared, remote: 'origin', ref: 'next', remoteRef: 'refs/heads/next', singleBranch: true, depth: 1 });
        await git.writeRef({ fs, dir: prepared, ref: 'refs/heads/next', value: remoteCommit });
        await git.setConfig({ fs, dir: prepared, path: 'branch.next.remote', value: 'origin' });
        await git.setConfig({ fs, dir: prepared, path: 'branch.next.merge', value: 'refs/heads/next' });
        await git.checkout({ fs, dir: prepared, ref: 'refs/heads/next', track: false });
        journal.preparedFingerprint = (await fixtureSnapshot(prepared)).fingerprint;
        if (['previous', 'installed', 'committed'].includes(phase)) await fs.promises.rename(fixture.local, previous);
        if (['installed', 'committed'].includes(phase)) await fs.promises.rename(prepared, fixture.local);
    }
    await fs.promises.writeFile(path.join(directory, 'journal.json'), JSON.stringify(journal));
    return { directory, prepared, previous, journal, remoteCommit };
}

function requestEndpoint(method, url, body, fixture, { admin = true } = {}) {
    return new Promise((resolve, reject) => {
        const request = { method, url, body, user: { profile: { admin, handle: 'fixture' }, directories: { extensions: fixture.extensions } } };
        const response = {
            statusCode: 200,
            status(status) { this.statusCode = status; return this; },
            send(value) { resolve({ status: this.statusCode, body: value }); return this; },
            json(value) { return this.send(value); },
            sendStatus(status) { return this.status(status).send(status); },
        };
        router.handle(request, response, error => reject(error ?? new Error('Endpoint did not respond')));
    });
}

test('real shallow clone retains history and reports its branch and commit', async () => {
    const fixture = await makeFixture();
    assert.equal(await fixture.client.checkIsRepo(), true);
    assert.deepEqual(await fixture.client.status(), []);
    assert.deepEqual(await fixture.client.version(), {
        currentBranchName: 'main', currentCommitHash: fixture.firstCommit, isUpToDate: true, remoteUrl,
    });
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
});

test('fetch detects new commits and fast-forward updates files and Git history', async () => {
    const fixture = await makeFixture({ priorHistory: true });
    await assert.rejects(git.readCommit({ fs, dir: fixture.local, oid: fixture.previousCommit }), error => error.code === 'NotFoundError');
    await commitFile(fixture.remote, 'manifest.json', JSON.stringify({ display_name: 'Fixture', version: '1.5' }), 'Intermediate update');
    const nextCommit = await commitFile(fixture.remote, 'manifest.json', JSON.stringify({ display_name: 'Fixture', version: '2' }), 'Update manifest');
    assert.equal((await fixture.client.version()).isUpToDate, false);
    const updated = await fixture.client.update();
    assert.equal(updated.isUpToDate, false);
    assert.equal(updated.shortCommitHash, nextCommit.slice(0, 7));
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(fixture.local, 'manifest.json'), 'utf8')).version, '2');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), nextCommit);
    assert.equal(await git.currentBranch({ fs, dir: fixture.local }), 'main');
    assert.equal((await fixture.client.version()).isUpToDate, true);
    assert.equal((await fixture.client.update()).isUpToDate, true);
    assert.deepEqual(await fixture.client.status(), []);
});

for (const change of ['modified', 'staged', 'untracked', 'ignored']) {
    test(`update rejects ${change} files before fetching and preserves their bytes and HEAD`, async () => {
        const fixture = await makeFixture();
        await commitFile(fixture.remote, 'manifest.json', '{"version":"2"}', 'Remote update');
        const filename = change === 'modified' || change === 'staged' ? 'manifest.json' : 'notes.txt';
        const file = path.join(fixture.local, filename);
        const content = 'User changes that must be preserved';
        await fs.promises.writeFile(file, content);
        if (change === 'staged') await git.add({ fs, dir: fixture.local, filepath: filename });
        if (change === 'ignored') await fs.promises.writeFile(path.join(fixture.local, '.git', 'info', 'exclude'), 'notes.txt\n');
        const previousRequests = fixture.transport.requests;
        await assert.rejects(fixture.client.update(), error => error.code === 'IOS_EXTENSION_GIT_DIRTY' && error.status === 409);
        assert.equal(fixture.transport.requests, previousRequests);
        assert.equal(await fs.promises.readFile(file, 'utf8'), content);
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    });
}

for (const change of ['deleted tracked', 'staged-only']) {
    test(`update rejects ${change} files without restoring or removing local changes`, async () => {
        const fixture = await makeFixture();
        await commitFile(fixture.remote, 'manifest.json', '{"version":"2"}', 'Remote update');
        const filename = change === 'deleted tracked' ? 'manifest.json' : 'notes.txt';
        const file = path.join(fixture.local, filename);
        if (change === 'staged-only') {
            await fs.promises.writeFile(file, 'Staged user content');
            await git.add({ fs, dir: fixture.local, filepath: filename });
        }
        await fs.promises.unlink(file);
        const staged = await git.listFiles({ fs, dir: fixture.local });
        await assert.rejects(fixture.client.update(), error => error.code === 'IOS_EXTENSION_GIT_DIRTY');
        await assert.rejects(fs.promises.access(file), error => error.code === 'ENOENT');
        assert.deepEqual(await git.listFiles({ fs, dir: fixture.local }), staged);
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    });
}

test('local edits made while fetching block checkout and preserve HEAD', async () => {
    const fixture = await makeFixture();
    await commitFile(fixture.remote, 'manifest.json', '{"version":"2"}', 'Remote update');
    const file = path.join(fixture.local, 'manifest.json');
    const client = new IOSGitClient(fixture.local, {
        http: {
            async request(request) {
                const response = await fixture.transport.request(request);
                if (request.method === 'POST') await fs.promises.writeFile(file, 'Edit made during fetch');
                return response;
            },
        },
    });
    await assert.rejects(client.update(), error => error.code === 'IOS_EXTENSION_GIT_DIRTY');
    assert.equal(await fs.promises.readFile(file, 'utf8'), 'Edit made during fetch');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
});

test('diverged local commits are not merged, reset or overwritten', async () => {
    const fixture = await makeFixture();
    const localCommit = await commitFile(fixture.local, 'manifest.json', '{"version":"local"}', 'Local change');
    await commitFile(fixture.remote, 'manifest.json', '{"version":"remote"}', 'Remote change');
    await assert.rejects(fixture.client.update(), error => error.code === 'IOS_EXTENSION_GIT_DIVERGED');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), localCommit);
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'manifest.json'), 'utf8'), '{"version":"local"}');
});

test('locally committed extensions ahead of the remote are preserved', async () => {
    const fixture = await makeFixture();
    const localCommit = await commitFile(fixture.local, 'manifest.json', '{"version":"local"}', 'Local change');
    assert.equal((await fixture.client.version()).isUpToDate, true);
    assert.equal((await fixture.client.update()).isUpToDate, true);
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), localCommit);
});

test('detached HEAD, missing Git history and missing origin return actionable conflicts', async () => {
    const fixture = await makeFixture();
    await git.checkout({ fs, dir: fixture.local, ref: fixture.firstCommit });
    await assert.rejects(fixture.client.version(), error => error.code === 'IOS_EXTENSION_GIT_DETACHED');
    const noGit = path.join(temporaryRoot, 'no-git');
    await fs.promises.mkdir(noGit);
    const noGitClient = new IOSGitClient(noGit, { http: fixture.transport });
    assert.equal(await noGitClient.checkIsRepo(), false);
    await assert.rejects(noGitClient.update(), error => error.code === 'IOS_EXTENSION_NO_GIT_REPOSITORY');
    await git.checkout({ fs, dir: fixture.local, ref: 'main' });
    await git.deleteRemote({ fs, dir: fixture.local, remote: 'origin' });
    await assert.rejects(fixture.client.version(), error => error.code === 'IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE');
});

test('fetch failures are not reported as successfully up to date', async () => {
    const fixture = await makeFixture();
    const client = new IOSGitClient(fixture.local, { http: { request: async () => { throw new Error('Fixture is offline'); } } });
    await assert.rejects(client.version(), error => error.code === 'IOS_EXTENSION_GIT_FETCH_FAILED' && error.status === 502);
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
});

test('concurrent update requests serialize and keep a clean repository', async () => {
    const fixture = await makeFixture();
    const nextCommit = await commitFile(fixture.remote, 'manifest.json', '{"version":"2"}', 'Remote update');
    const anotherClient = new IOSGitClient(fixture.local, { http: fixture.transport });
    const results = await Promise.all([fixture.client.update(), anotherClient.update()]);
    assert.deepEqual(results.map(result => result.isUpToDate), [false, true]);
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), nextCommit);
    assert.deepEqual(await fixture.client.status(), []);
});

test('iOS install, version and update endpoints use builtin Git and preserve response shape', async () => {
    const fixture = await makeFixture({ clone: false });
    defaultHttp.request = fixture.transport.request.bind(fixture.transport);
    try {
        const installed = await requestEndpoint('POST', '/install', { url: remoteUrl }, fixture);
        assert.equal(installed.status, 200);
        assert.equal(installed.body.folderName, 'extension');
        assert.equal(installed.body.version, '1');
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
        const version = await requestEndpoint('POST', '/version', { extensionName: '/extension' }, fixture);
        assert.equal(version.status, 200);
        assert.equal(version.body.currentCommitHash, fixture.firstCommit);
        assert.equal(version.body.isUpToDate, true);
        const nextCommit = await commitFile(fixture.remote, 'manifest.json', '{"display_name":"Fixture","version":"2"}', 'Remote update');
        const updated = await requestEndpoint('POST', '/update', { extensionName: '/extension' }, fixture);
        assert.equal(updated.status, 200);
        assert.equal(updated.body.shortCommitHash, nextCommit.slice(0, 7));
        assert.equal(updated.body.isUpToDate, false);
        assert.equal(updated.body.extensionPath, fixture.local);
        assert.equal(updated.body.remoteUrl, remoteUrl);
        await fs.promises.writeFile(path.join(fixture.local, 'manifest.json'), 'User edit');
        const dirty = await requestEndpoint('POST', '/update', { extensionName: '/extension' }, fixture);
        assert.equal(dirty.status, 409);
        assert.equal(dirty.body.code, 'IOS_EXTENSION_GIT_DIRTY');
        const denied = await requestEndpoint('POST', '/update', { extensionName: '/extension', global: true }, fixture, { admin: false });
        assert.equal(denied.status, 403);
    } finally {
        defaultHttp.request = originalRequest;
    }
});

test('branch listing reports real local/remote commit labels without changing shallow history or dirty files', async () => {
    const fixture = await makeFixture({ priorHistory: true });
    const remoteCommit = await makeRemoteBranch(fixture, 'feature/mobile');
    await fs.promises.writeFile(path.join(fixture.local, 'notes.txt'), 'Untracked user content');
    const shallow = await fs.promises.readFile(path.join(fixture.local, '.git', 'shallow'));
    const branches = await fixture.client.branches();
    assert.deepEqual(branches, [
        { current: true, commit: fixture.firstCommit.slice(0, 7), name: 'main', label: 'Initial manifest' },
        { current: false, commit: remoteCommit.slice(0, 7), name: 'origin/feature/mobile', label: 'Commit on feature/mobile' },
        { current: false, commit: fixture.firstCommit.slice(0, 7), name: 'origin/main', label: 'Initial manifest' },
    ]);
    assert.deepEqual(await fs.promises.readFile(path.join(fixture.local, '.git', 'shallow')), shallow);
    await assert.rejects(git.readCommit({ fs, dir: fixture.local, oid: fixture.previousCommit }), error => error.code === 'NotFoundError');
    await assert.rejects(git.readCommit({ fs, dir: fixture.local, oid: remoteCommit }), error => error.code === 'NotFoundError');
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'notes.txt'), 'utf8'), 'Untracked user content');
    await assertNoTemporaryDirectories(fixture);
});

test('remote branch switch creates real tracking history and local switches preserve local commits', async () => {
    const fixture = await makeFixture({ priorHistory: true });
    const remoteCommit = await makeRemoteBranch(fixture, 'feature/mobile');
    await fixture.client.switchBranch('origin/feature/mobile');
    assert.equal(await git.currentBranch({ fs, dir: fixture.local }), 'feature/mobile');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), remoteCommit);
    assert.equal(await git.getConfig({ fs, dir: fixture.local, path: 'branch.feature/mobile.remote' }), 'origin');
    assert.equal(await git.getConfig({ fs, dir: fixture.local, path: 'branch.feature/mobile.merge' }), 'refs/heads/feature/mobile');
    assert.equal((await fixture.client.version()).isUpToDate, true);
    const localCommit = await commitFile(fixture.local, 'manifest.json', '{"version":"user-commit"}', 'User commit on mobile');
    await fixture.client.switchBranch('main');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    const requests = fixture.transport.requests;
    await fixture.client.switchBranch('origin/feature/mobile');
    assert.equal(fixture.transport.requests, requests, 'Existing local branches do not reset to the remote tip');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), localCommit);
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'manifest.json'), 'utf8'), '{"version":"user-commit"}');
    await assertNoTemporaryDirectories(fixture);
});

for (const change of ['modified', 'staged', 'untracked', 'ignored', 'deleted', 'staged-only']) {
    test(`branch switch rejects ${change} user changes before network access`, async () => {
        const fixture = await makeFixture();
        await makeRemoteBranch(fixture);
        const filename = ['modified', 'staged', 'deleted'].includes(change) ? 'manifest.json' : 'notes.txt';
        const file = path.join(fixture.local, filename);
        if (change !== 'deleted') await fs.promises.writeFile(file, 'User changes');
        if (['staged', 'staged-only'].includes(change)) await git.add({ fs, dir: fixture.local, filepath: filename });
        if (change === 'ignored') await fs.promises.writeFile(path.join(fixture.local, '.git', 'info', 'exclude'), 'notes.txt\n');
        if (['deleted', 'staged-only'].includes(change)) await fs.promises.unlink(file);
        const staged = await git.listFiles({ fs, dir: fixture.local });
        const requests = fixture.transport.requests;
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_DIRTY' && error.status === 409);
        assert.equal(fixture.transport.requests, requests);
        if (['deleted', 'staged-only'].includes(change)) await assert.rejects(fs.promises.access(file), error => error.code === 'ENOENT');
        else assert.equal(await fs.promises.readFile(file, 'utf8'), 'User changes');
        assert.deepEqual(await git.listFiles({ fs, dir: fixture.local }), staged);
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
        await assertNoTemporaryDirectories(fixture);
    });
}

test('invalid or unknown branches, detached HEAD and unsupported tracking remotes are rejected safely', async () => {
    const fixture = await makeFixture();
    const requests = fixture.transport.requests;
    for (const branch of ['../main', 'origin/../main', '/main', 'main.lock', 'HEAD', 'origin/HEAD', 'refs/heads/main', '-main', 'main//x', 'main@{x}', 'a\\b', 'main\nnext', 7]) {
        await assert.rejects(fixture.client.switchBranch(branch), error => error.code === 'IOS_EXTENSION_GIT_INVALID_BRANCH' && error.status === 400);
    }
    for (const branch of ['topic"quoted', 'topic#comment', 'topic;comment']) {
        await assert.rejects(fixture.client.switchBranch(`origin/${branch}`), error => error.code === 'IOS_EXTENSION_GIT_UNSUPPORTED_BRANCH' && error.status === 400);
    }
    assert.equal(fixture.transport.requests, requests);
    await assert.rejects(fixture.client.switchBranch('upstream/next'), error => error.code === 'IOS_EXTENSION_GIT_BRANCH_UNAVAILABLE' && error.status === 404);
    await assert.rejects(fixture.client.switchBranch('origin/deleted'), error => error.code === 'IOS_EXTENSION_GIT_BRANCH_UNAVAILABLE' && error.status === 404);
    await git.setConfig({ fs, dir: fixture.local, path: 'branch.main.remote', value: 'unknown' });
    const beforeUnknownRemote = fixture.transport.requests;
    await assert.rejects(fixture.client.switchBranch('origin/main'), error => error.code === 'IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE');
    await assert.rejects(fixture.client.update(), error => error.code === 'IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE');
    assert.equal(fixture.transport.requests, beforeUnknownRemote);
    await git.setConfig({ fs, dir: fixture.local, path: 'branch.main.remote', value: 'origin' });
    await git.checkout({ fs, dir: fixture.local, ref: fixture.firstCommit });
    await assert.rejects(fixture.client.switchBranch('main'), error => error.code === 'IOS_EXTENSION_GIT_DETACHED');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    await assertNoTemporaryDirectories(fixture);
});

test('advertised valid Git names that cannot round-trip through config are rejected before switching', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture, 'topic#comment');
    await makeRemoteBranch(fixture, 'topic;comment');
    const listed = await fixture.client.branches();
    assert.ok(listed.some(item => item.name === 'origin/topic#comment'));
    assert.ok(listed.some(item => item.name === 'origin/topic;comment'));
    const requests = fixture.transport.requests;
    for (const name of ['topic#comment', 'topic;comment']) {
        await assert.rejects(fixture.client.switchBranch(`origin/${name}`), error => error.code === 'IOS_EXTENSION_GIT_UNSUPPORTED_BRANCH');
    }
    assert.equal(fixture.transport.requests, requests);
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
});

test('network and incomplete-checkout failures leave installed files, HEAD and tracking configuration untouched', async () => {
    const fixture = await makeFixture();
    const config = await fs.promises.readFile(path.join(fixture.local, '.git', 'config'));
    const failed = new IOSGitClient(fixture.local, { http: { request: async () => { throw new Error('Fixture connection failed'); } } });
    await assert.rejects(failed.branches(), error => error.code === 'IOS_EXTENSION_GIT_FETCH_FAILED');
    await assert.rejects(failed.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_FETCH_FAILED');
    await git.writeRef({ fs, dir: fixture.local, ref: 'refs/heads/incomplete', value: '4'.repeat(40) });
    await assert.rejects(fixture.client.switchBranch('incomplete'), error => error.code === 'IOS_EXTENSION_GIT_HISTORY_INCOMPLETE');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'manifest.json'), 'utf8'), '{"display_name":"Fixture","version":"1"}');
    assert.deepEqual(await fs.promises.readFile(path.join(fixture.local, '.git', 'config')), config);
    await assertNoTemporaryDirectories(fixture);
});

test('edits during remote branch fetch preserve user bytes and prevent replacement', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture);
    const file = path.join(fixture.local, 'manifest.json');
    const client = new IOSGitClient(fixture.local, { http: { async request(request) {
        const result = await fixture.transport.request(request);
        if (request.method === 'POST') await fs.promises.writeFile(file, 'User edit during branch fetch');
        return result;
    } } });
    await assert.rejects(client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_DIRTY');
    assert.equal(await fs.promises.readFile(file, 'utf8'), 'User edit during branch fetch');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    await assertNoTemporaryDirectories(fixture);
});

test('failed prepared-directory installation rolls back the original extension', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture);
    const originalRename = fs.promises.rename;
    let injected = false;
    fs.promises.rename = async (from, to) => {
        if (!injected && path.basename(from) === 'prepared' && to === fixture.local) {
            injected = true;
            throw Object.assign(new Error('Fixture filesystem interruption'), { code: 'EIO' });
        }
        return originalRename(from, to);
    };
    try {
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_SWITCH_FAILED');
    } finally { fs.promises.rename = originalRename; }
    assert.equal(injected, true);
    assert.equal(await git.currentBranch({ fs, dir: fixture.local }), 'main');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    assert.deepEqual(await fixture.client.status(), []);
    await assertNoTemporaryDirectories(fixture);
});

test('a user edit discovered after the original directory rename is restored without data loss', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture);
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
        await originalRename(from, to);
        if (from === fixture.local && path.basename(to) === 'previous') {
            await fs.promises.writeFile(path.join(to, 'notes.txt'), 'Last-moment user content');
        }
    };
    try {
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_CHANGED');
    } finally { fs.promises.rename = originalRename; }
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'notes.txt'), 'utf8'), 'Last-moment user content');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    await assertNoTemporaryDirectories(fixture);
});

test('a failed rollback preserves both the original repository and a concurrently created user directory', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture);
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (from, to) => {
        if (path.basename(from) === 'prepared' && to === fixture.local) {
            await fs.promises.mkdir(fixture.local);
            await fs.promises.writeFile(path.join(fixture.local, 'notes.txt'), 'Concurrent writer data');
            throw Object.assign(new Error('Fixture directory collision'), { code: 'EEXIST' });
        }
        return originalRename(from, to);
    };
    try {
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED' && error.status === 409);
    } finally { fs.promises.rename = originalRename; }
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'notes.txt'), 'utf8'), 'Concurrent writer data');
    const recovery = (await fs.promises.readdir(fixture.extensions)).filter(name => name.startsWith('.st-ios-git-switch-'));
    assert.equal(recovery.length, 1);
    const previous = path.join(fixture.extensions, recovery[0], 'previous');
    assert.equal(await git.resolveRef({ fs, dir: previous, ref: 'HEAD' }), fixture.firstCommit);
    assert.equal(await fs.promises.readFile(path.join(previous, 'manifest.json'), 'utf8'), '{"display_name":"Fixture","version":"1"}');
});

test('rollback preserves clean user commits and Git configuration written after installation', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture);
    const originalRename = fs.promises.rename;
    let previous, userCommit;
    fs.promises.rename = async (from, to) => {
        await originalRename(from, to);
        if (from === fixture.local && path.basename(to) === 'previous') previous = to;
        if (path.basename(from) === 'prepared' && to === fixture.local) {
            userCommit = await commitFile(fixture.local, 'manifest.json', '{"version":"new-user-commit"}', 'Commit during installation');
            await git.setConfig({ fs, dir: fixture.local, path: 'user.name', value: 'User configuration during installation' });
            await fs.promises.writeFile(path.join(previous, 'notes.txt'), 'Old-directory writer data');
        }
    };
    try {
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED');
    } finally { fs.promises.rename = originalRename; }
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), userCommit);
    assert.equal(await git.getConfig({ fs, dir: fixture.local, path: 'user.name' }), 'User configuration during installation');
    assert.equal(await fs.promises.readFile(path.join(previous, 'notes.txt'), 'utf8'), 'Old-directory writer data');
});

test('new user files arriving during committed-journal publication are preserved during cleanup', async () => {
    const fixture = await makeFixture();
    const remoteCommit = await makeRemoteBranch(fixture);
    const originalRename = fs.promises.rename;
    let previous;
    fs.promises.rename = async (from, to) => {
        await originalRename(from, to);
        if (path.basename(from) === 'journal.json.tmp') {
            const journal = JSON.parse(await fs.promises.readFile(to));
            if (journal.phase === 'committed') {
                previous = path.join(path.dirname(to), 'previous');
                await fs.promises.writeFile(path.join(previous, 'notes.txt'), 'User bytes during journal publication');
            }
        }
    };
    try {
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED');
    } finally { fs.promises.rename = originalRename; }
    assert.equal(await fs.promises.readFile(path.join(previous, 'notes.txt'), 'utf8'), 'User bytes during journal publication');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), remoteCommit);
});

test('a new filename arriving during backup removal is never recursively deleted', async () => {
    const fixture = await makeFixture();
    const remoteCommit = await makeRemoteBranch(fixture);
    const originalRemove = fs.promises.rmdir;
    let previous;
    fs.promises.rmdir = async directory => {
        if (path.basename(directory) === '.git' && path.basename(path.dirname(directory)) === 'previous') {
            previous = path.dirname(directory);
            await fs.promises.writeFile(path.join(previous, 'notes.txt'), 'Late backup writer bytes');
        }
        return originalRemove(directory);
    };
    try {
        await assert.rejects(fixture.client.switchBranch('origin/next'), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED');
    } finally { fs.promises.rmdir = originalRemove; }
    assert.equal(await fs.promises.readFile(path.join(previous, 'notes.txt'), 'utf8'), 'Late backup writer bytes');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), remoteCommit);
});

test('update follows an advertised branch rather than a different tag with the same name', async () => {
    const fixture = await makeFixture();
    const nextCommit = await commitFile(fixture.remote, 'manifest.json', '{"version":"branch-tip"}', 'Updated main branch');
    await git.tag({ fs, dir: fixture.remote, ref: 'main', object: fixture.firstCommit });
    assert.equal((await fixture.client.version()).isUpToDate, false);
    const updated = await fixture.client.update();
    assert.equal(updated.shortCommitHash, nextCommit.slice(0, 7));
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), nextCommit);
});

for (const phase of ['preparing', 'prepared', 'previous', 'installed', 'committed']) {
    test(`interrupted ${phase} switch recovers real Git state and removes only owned transaction files`, async () => {
        const fixture = await makeFixture();
        const interrupted = await interruptedSwitch(fixture, phase);
        if (phase === 'committed') await fs.promises.unlink(path.join(interrupted.previous, 'manifest.json'));
        await fixture.client.recover();
        const keptNew = ['installed', 'committed'].includes(phase);
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), keptNew ? interrupted.remoteCommit : fixture.firstCommit);
        assert.equal(await git.currentBranch({ fs, dir: fixture.local }), keptNew ? 'next' : 'main');
        assert.equal(JSON.parse(await fs.promises.readFile(path.join(fixture.local, 'manifest.json'))).version, keptNew ? 'next' : '1');
        assert.deepEqual(await fixture.client.status(), []);
        await assertNoTemporaryDirectories(fixture);
    });
}

test('recovery handles both rename boundaries before their journal phase was updated', async () => {
    for (const boundary of ['original-moved', 'prepared-installed']) {
        const fixture = await makeFixture();
        const interrupted = await interruptedSwitch(fixture, boundary === 'original-moved' ? 'prepared' : 'previous');
        if (boundary === 'original-moved') await fs.promises.rename(fixture.local, interrupted.previous);
        else await fs.promises.rename(interrupted.prepared, fixture.local);
        await fixture.client.recover();
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), boundary === 'original-moved' ? fixture.firstCommit : interrupted.remoteCommit);
        await assertNoTemporaryDirectories(fixture);
    }
});

for (const kind of ['symlink', 'regular file']) {
    test(`recovery preserves an existing ${kind} temporary journal and all repository/victim bytes`, async context => {
        // installed recovery would publish committed; prepared recovery would
        // otherwise clean up the transaction. Both must preserve an existing tmp.
        for (const phase of ['prepared', 'installed']) {
            const fixture = await makeFixture();
            const interrupted = await interruptedSwitch(fixture, phase);
            const temporary = path.join(interrupted.directory, 'journal.json.tmp');
            const victim = path.join(path.dirname(fixture.extensions), 'victim.txt');
            const victimBytes = Buffer.from('Synthetic victim outside the owned Git transaction\n한글');
            await fs.promises.writeFile(victim, victimBytes);
            if (kind === 'symlink') {
                try {
                    await fs.promises.symlink(victim, temporary, 'file');
                } catch (error) {
                    if (process.platform === 'win32' && error.code === 'EPERM') {
                        context.skip('Windows requires file-symlink privileges; macOS CI executes the actual symlink/victim regression.');
                        return;
                    }
                    throw error;
                }
            } else await fs.promises.writeFile(temporary, 'Existing temporary journal owned by another writer');
            const current = await fixtureSnapshot(fixture.local);
            const copy = phase === 'installed' ? interrupted.previous : interrupted.prepared;
            const retained = await fixtureSnapshot(copy);
            const journalBytes = await fs.promises.readFile(path.join(interrupted.directory, 'journal.json'));
            const temporarySnapshot = await fixtureSnapshot(temporary);

            await assert.rejects(fixture.client.recover(), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED' && error.status === 409);

            assert.deepEqual(await fixtureSnapshot(fixture.local), current);
            assert.deepEqual(await fixtureSnapshot(copy), retained);
            assert.deepEqual(await fs.promises.readFile(path.join(interrupted.directory, 'journal.json')), journalBytes);
            assert.deepEqual(await fixtureSnapshot(temporary), temporarySnapshot);
            assert.deepEqual(await fs.promises.readFile(victim), victimBytes);
            assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), phase === 'installed' ? interrupted.remoteCommit : fixture.firstCommit);
        }
    });
}

test('missing installed path restores previous user edits before the endpoint existence guard', async () => {
    const fixture = await makeFixture();
    const interrupted = await interruptedSwitch(fixture, 'previous');
    await fs.promises.writeFile(path.join(interrupted.previous, 'notes.txt'), 'User notes during interruption');
    defaultHttp.request = fixture.transport.request.bind(fixture.transport);
    try {
        const response = await requestEndpoint('POST', '/branches', { extensionName: '/extension' }, fixture);
        assert.equal(response.status, 200, 'An interrupted original rename must not become a permanent 404');
    } finally { defaultHttp.request = originalRequest; }
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'notes.txt'), 'utf8'), 'User notes during interruption');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    await assertNoTemporaryDirectories(fixture);
});

test('discovery restores an interrupted extension before listing it', async () => {
    const fixture = await makeFixture();
    await interruptedSwitch(fixture, 'previous');
    const response = await requestEndpoint('GET', '/discover', undefined, fixture);
    assert.equal(response.status, 200);
    assert.ok(response.body.some(item => item.type === 'local' && item.name === 'third-party/extension'));
    assert.equal(await git.currentBranch({ fs, dir: fixture.local }), 'main');
    await assertNoTemporaryDirectories(fixture);
});

test('interrupted installed copies with concurrent files return 409 and preserve both copies', async () => {
    const fixture = await makeFixture();
    const interrupted = await interruptedSwitch(fixture, 'installed');
    await fs.promises.writeFile(path.join(fixture.local, 'notes.txt'), 'Installed user bytes');
    await fs.promises.writeFile(path.join(interrupted.previous, 'notes.txt'), 'Previous user bytes');
    const response = await requestEndpoint('POST', '/branches', { extensionName: '/extension' }, fixture);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED');
    assert.equal(await fs.promises.readFile(path.join(fixture.local, 'notes.txt'), 'utf8'), 'Installed user bytes');
    assert.equal(await fs.promises.readFile(path.join(interrupted.previous, 'notes.txt'), 'utf8'), 'Previous user bytes');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), interrupted.remoteCommit);
});

test('recovery does not discard unknown files in a partially removed committed backup', async () => {
    const fixture = await makeFixture();
    const interrupted = await interruptedSwitch(fixture, 'committed');
    await fs.promises.unlink(path.join(interrupted.previous, 'manifest.json'));
    await fs.promises.writeFile(path.join(interrupted.previous, 'notes.txt'), 'Unknown backup user bytes');
    await assert.rejects(fixture.client.recover(), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED');
    assert.equal(await fs.promises.readFile(path.join(interrupted.previous, 'notes.txt'), 'utf8'), 'Unknown backup user bytes');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), interrupted.remoteCommit);
});

test('malformed traversal journals cannot restore or remove paths outside their extension parent', async () => {
    const fixture = await makeFixture();
    const interrupted = await interruptedSwitch(fixture, 'prepared');
    interrupted.journal.target = '../outside';
    await fs.promises.writeFile(path.join(interrupted.directory, 'journal.json'), JSON.stringify(interrupted.journal));
    await assert.rejects(fixture.client.recover(), error => error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), fixture.firstCommit);
    assert.ok(fs.existsSync(interrupted.prepared));
});

test('symbolic repository roots and metadata directories are rejected before writes', async () => {
    const fixture = await makeFixture();
    const linked = path.join(fixture.extensions, 'linked');
    await fs.promises.symlink(fixture.local, linked, 'junction');
    const client = new IOSGitClient(linked, { http: fixture.transport });
    assert.equal(await client.checkIsRepo(), false);
    await assert.rejects(client.switchBranch('main'), error => error.code === 'IOS_EXTENSION_NO_GIT_REPOSITORY');
    const metadata = path.join(fixture.local, '.git', 'refs');
    const external = path.join(path.dirname(fixture.extensions), 'external-refs');
    await fs.promises.rename(metadata, external);
    await fs.promises.symlink(external, metadata, 'junction');
    const requests = fixture.transport.requests;
    await assert.rejects(fixture.client.switchBranch('main'), error => error.code === 'IOS_EXTENSION_GIT_UNSAFE_METADATA');
    await assert.rejects(fixture.client.update(), error => error.code === 'IOS_EXTENSION_GIT_UNSAFE_METADATA');
    assert.equal(fixture.transport.requests, requests);
    assert.equal(await fs.promises.readFile(path.join(external, 'heads', 'main'), 'utf8'), `${fixture.firstCommit}\n`);
});

test('switch, branch query and update serialize across separate clients', async () => {
    const fixture = await makeFixture();
    const remoteCommit = await makeRemoteBranch(fixture);
    const other = new IOSGitClient(fixture.local, { http: fixture.transport });
    const [, updated, branches] = await Promise.all([
        fixture.client.switchBranch('origin/next'), other.update(), other.branches(),
    ]);
    assert.equal(updated.isUpToDate, true);
    assert.equal(updated.shortCommitHash, remoteCommit.slice(0, 7));
    assert.equal(branches.find(item => item.current)?.name, 'next');
    assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), remoteCommit);
    assert.deepEqual(await fixture.client.status(), []);
    await assertNoTemporaryDirectories(fixture);
});

test('iOS branch endpoints preserve successful response shape, missing-branch errors and global permissions', async () => {
    const fixture = await makeFixture();
    await makeRemoteBranch(fixture);
    defaultHttp.request = fixture.transport.request.bind(fixture.transport);
    try {
        const listed = await requestEndpoint('POST', '/branches', { extensionName: '/extension' }, fixture);
        assert.equal(listed.status, 200);
        assert.ok(listed.body.some(item => item.name === 'origin/next' && item.current === false && item.label === 'Commit on next'));
        const switched = await requestEndpoint('POST', '/switch', { extensionName: '/extension', branch: 'origin/next' }, fixture);
        assert.equal(switched.status, 204);
        assert.equal(await git.currentBranch({ fs, dir: fixture.local }), 'next');
        const missing = await requestEndpoint('POST', '/switch', { extensionName: '/extension', branch: 'missing' }, fixture);
        assert.equal(missing.status, 404);
        for (const route of ['/branches', '/switch']) {
            const denied = await requestEndpoint('POST', route, { extensionName: '/extension', branch: 'main', global: true }, fixture, { admin: false });
            assert.equal(denied.status, 403);
        }
    } finally { defaultHttp.request = originalRequest; }
});

test('actual loopback smart HTTP install/list/switch passes through iOS middleware and the extension router', async () => {
    const fixture = await makeFixture({ clone: false });
    const remoteCommit = await makeRemoteBranch(fixture, 'feature/mobile');
    await git.tag({ fs, dir: fixture.remote, ref: 'feature/mobile', object: fixture.firstCommit });
    const provider = http.createServer(async (request, response) => {
        try {
            const result = await fixture.transport.request({ url: request.url, method: request.method, body: request });
            response.writeHead(result.statusCode, result.headers);
            for await (const chunk of result.body) response.write(chunk);
            response.end();
        } catch (error) {
            response.writeHead(500); response.end(error.message);
        }
    });
    const app = express();
    app.use(express.json());
    app.use((request, _, next) => {
        request.user = { profile: { admin: true, handle: 'generated-fixture' }, directories: { extensions: fixture.extensions } };
        next();
    });
    installIOSRoutes(app);
    app.use('/api/extensions', router);
    const server = http.createServer(app);
    try {
        const remote = `${await listen(provider)}/extension.git`;
        const base = await listen(server);
        const installed = await postJSON(`${base}/api/extensions/install`, { url: remote });
        assert.equal(installed.status, 200);
        assert.equal(installed.body.folderName, 'extension');
        const named = await postJSON(`${base}/api/extensions/install`, { url: remote.replace('/extension.git', '/extension-branch.git'), branch: 'feature/mobile' });
        assert.equal(named.status, 200);
        const namedDirectory = path.join(fixture.extensions, 'extension-branch');
        assert.equal(await git.currentBranch({ fs, dir: namedDirectory }), 'feature/mobile');
        assert.equal(await git.resolveRef({ fs, dir: namedDirectory, ref: 'HEAD' }), remoteCommit, 'Named install must choose the branch rather than a tag with the same name');
        const listed = await postJSON(`${base}/api/extensions/branches`, { extensionName: '/extension' });
        assert.equal(listed.status, 200, 'The iOS pre-route guard must allow supported branch operations');
        assert.ok(listed.body.some(item => item.name === 'origin/feature/mobile' && item.commit === remoteCommit.slice(0, 7)));
        const switched = await postJSON(`${base}/api/extensions/switch`, { extensionName: '/extension', branch: 'origin/feature/mobile' });
        assert.equal(switched.status, 204);
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), remoteCommit);
        assert.equal(await git.currentBranch({ fs, dir: fixture.local }), 'feature/mobile');
        const invalid = await postJSON(`${base}/api/extensions/switch`, { extensionName: '/extension', branch: 'origin/../escape' });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.code, 'IOS_EXTENSION_GIT_INVALID_BRANCH');
        assert.equal(await git.resolveRef({ fs, dir: fixture.local, ref: 'HEAD' }), remoteCommit);
        await assertNoTemporaryDirectories(fixture);
    } finally {
        await Promise.all([closeServer(server), closeServer(provider)]);
    }
});
