import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST_NAME = 'runtime-manifest.json';
const sha256 = data => createHash('sha256').update(data).digest('hex');

async function listFiles(directory, prefix = '') {
    const files = [];
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (/[\x00-\x1f\x7f\\]/.test(relative)) throw new Error(`Invalid runtime filename: ${relative}`);
        if (item.isSymbolicLink()) throw new Error(`Runtime symlinks are not allowed: ${relative}`);
        if (item.isDirectory()) files.push(...await listFiles(path.join(directory, item.name), relative));
        else if (item.isFile() && relative !== MANIFEST_NAME) files.push(relative);
    }
    return files.sort();
}

export async function writeRuntimeManifest(directory, applicationVersion) {
    const files = [];
    for (const filename of await listFiles(directory)) {
        const data = await fs.readFile(path.join(directory, filename));
        files.push({ path: filename, sha256: sha256(data), size: data.length });
    }
    // One canonical UTF-8 line per file; no timestamps or absolute host paths.
    const canonical = files.map(file => `${file.path}\t${file.sha256}\t${file.size}\n`).join('');
    const manifest = { formatVersion: 1, applicationVersion, deploymentId: sha256(canonical), files };
    await fs.writeFile(path.join(directory, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

export async function verifyRuntimeManifest(directory) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, MANIFEST_NAME), 'utf8'));
    if (manifest.formatVersion !== 1 || typeof manifest.applicationVersion !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.deploymentId) || !Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error('Invalid runtime manifest.');
    }
    const actual = await listFiles(directory);
    const declared = manifest.files.map(file => file.path);
    if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error('Runtime manifest file list differs.');
    for (const file of manifest.files) {
        if (typeof file.path !== 'string' || !file.path || /^[A-Za-z]:/.test(file.path) || file.path.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(file.path) || file.path.split('/').some(part => part === '..' || part === '.' || !part)) {
            throw new Error(`Invalid runtime path: ${file.path}`);
        }
        if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid runtime checksum: ${file.path}`);
        const data = await fs.readFile(path.join(directory, file.path));
        if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`Runtime integrity failure: ${file.path}`);
    }
    const canonical = manifest.files.map(file => `${file.path}\t${file.sha256}\t${file.size}\n`).join('');
    if (sha256(canonical) !== manifest.deploymentId) throw new Error('Runtime deployment id differs.');
    return manifest;
}
