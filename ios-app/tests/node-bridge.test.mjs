import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchNodeBridge, patchInstalledNodeBridge } from '../scripts/patch-node-bridge.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixture = await fs.readFile(path.join(testDirectory, 'fixtures', 'capacitor-node-js-1.0.2', 'NodeProcess.mm'), 'utf8');
const temporaryRoot = path.join(testDirectory, '..', '.test-tmp');

async function installedFixture(t, { version = '1.0.2', source = fixture } = {}) {
    await fs.mkdir(temporaryRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'node-bridge-'));
    t.after(async () => {
        const relative = path.relative(temporaryRoot, directory);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const bridge = path.join(directory, 'ios', 'Bridge', 'NodeProcess.mm');
    await fs.mkdir(path.dirname(bridge), { recursive: true });
    await fs.writeFile(bridge, source);
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@choreruiz/capacitor-node-js', version }));
    return { directory, bridge };
}

test('reviewed npm bridge loses process-wide pipe forwarding while retaining engine and IPC calls', () => {
    const patched = patchNodeBridge(fixture);
    assert.doesNotMatch(patched, /dup2|stdoutThreadFunc|stderrThreadFunc|startRedirectingStdoutStderr/);
    for (const entry of ['RegisterCallback(&receiveMessageFromNode);', 'node_start(argc, argv);',
        'SendMessageToNode([channel UTF8String], [message UTF8String]);']) {
        assert.ok(patched.includes(entry), `Native runtime entry must remain: ${entry}`);
    }
    assert.equal(patchNodeBridge(patched), patched);
    assert.equal(patchNodeBridge(fixture.replace(/\r?\n/g, '\r\n')), patched);
});

test('preparation patches a fresh pinned installation and repeated preparation leaves its bytes unchanged', async t => {
    const { directory, bridge } = await installedFixture(t);
    await patchInstalledNodeBridge(directory);
    const patched = await fs.readFile(bridge, 'utf8');
    assert.equal(patched, patchNodeBridge(fixture));
    await patchInstalledNodeBridge(directory);
    assert.equal(await fs.readFile(bridge, 'utf8'), patched);
});

test('a changed plugin version is refused before overwriting native source', async t => {
    const { directory, bridge } = await installedFixture(t, { version: '1.0.3' });
    const before = await fs.readFile(bridge);
    await assert.rejects(patchInstalledNodeBridge(directory), /requires.*1\.0\.2/);
    assert.deepEqual(await fs.readFile(bridge), before);
});

test('unreviewed changes to pinned bridge source are refused and preserved', async t => {
    const { directory, bridge } = await installedFixture(t, { source: fixture + '\n// locally changed\n' });
    const before = await fs.readFile(bridge);
    await assert.rejects(patchInstalledNodeBridge(directory), /Unknown.*bridge source/);
    assert.deepEqual(await fs.readFile(bridge), before);
});
