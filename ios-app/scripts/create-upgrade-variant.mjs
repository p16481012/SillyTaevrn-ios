#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest, writeRuntimeManifest } from './runtime-manifest.mjs';
import { fileDigest } from './simulator-data-fixture.mjs';

const execute = promisify(execFile);
const markerName = 'validation-deployment-variant.json';
const within = (root, target) => {
    const relative = path.relative(root, target);
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function destination(filename) {
    const suffix = [];
    let current = path.resolve(filename);
    while (true) {
        try { return path.join(await fs.realpath(current), ...suffix.reverse()); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            suffix.push(path.basename(current));
            const parent = path.dirname(current);
            if (parent === current) throw error;
            current = parent;
        }
    }
}

async function rejectLinks(directory) {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Upgrade artifacts must not contain symlinks.');
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error(`Upgrade artifact contains a symlink: ${item.name}`);
        if (item.isDirectory()) await rejectLinks(path.join(directory, item.name));
        else if (!item.isFile()) throw new Error(`Unsupported artifact file: ${item.name}`);
    }
}

export async function createUpgradeVariant(options, dependencies = {}) {
    if (!path.isAbsolute(options.sourceApp ?? '') || !/\.app$/i.test(options.sourceApp)
        || !path.isAbsolute(options.outputRoot ?? '')) throw new Error('Use absolute --source-app App.app and --output-root directory paths.');
    const source = await fs.realpath(options.sourceApp);
    const outputRoot = await destination(options.outputRoot);
    const devices = await destination(path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices'));
    if (outputRoot === source || within(source, outputRoot) || within(outputRoot, source)
        || outputRoot === devices || within(devices, outputRoot)) throw new Error('Output must be separate from the source app and Simulator data.');
    await rejectLinks(options.sourceApp);
    const run = dependencies.runCommand ?? ((command, args) => execute(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 }));
    const infoPath = path.join(source, 'Info.plist');
    const originalInfo = await fs.readFile(infoPath);
    const read = async (key, format = 'raw') => (await run('plutil', ['-extract', key, format, '-o', '-', infoPath])).stdout.trim();
    const bundleID = await read('CFBundleIdentifier');
    const platforms = JSON.parse(await read('CFBundleSupportedPlatforms', 'json'));
    const fromBuild = await read('CFBundleVersion');
    if (!platforms.includes('iPhoneSimulator') || !/^\d+$/.test(fromBuild)) throw new Error('Source must be a Simulator build with a numeric CFBundleVersion.');
    if (await fs.stat(path.join(source, '_CodeSignature')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        throw new Error('Use an unsigned Simulator app; modifying a signed app invalidates its signature.');
    }
    const runtimePath = path.join(source, 'public', 'nodejs-project');
    const original = await verifyRuntimeManifest(runtimePath);
    const toBuild = String(BigInt(fromBuild) + 1n);
    await fs.mkdir(outputRoot, { recursive: true });
    if ((await fs.lstat(outputRoot)).isSymbolicLink() || (await fs.readdir(outputRoot)).length) throw new Error('Output root must be a new or empty non-symlink directory.');
    const target = path.join(outputRoot, 'UpgradeB.app');
    const metadataPath = path.join(outputRoot, 'upgrade-variant.json');
    const staging = await fs.mkdtemp(path.join(outputRoot, '.upgrade-copy-'));
    const stagingTarget = path.join(staging, 'UpgradeB.app');
    let ownsTarget = false;
    try {
        await fs.cp(source, stagingTarget, { recursive: true, force: false, errorOnExist: true });
        await rejectLinks(stagingTarget);
        if (await fs.lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
            throw new Error('Upgrade output app already exists.');
        }
        await fs.rename(stagingTarget, target);
        ownsTarget = true;
        await run('plutil', ['-replace', 'CFBundleVersion', '-string', toBuild, path.join(target, 'Info.plist')]);
        const marker = { formatVersion: 1, classification: 'controlled-deployment-variant', sameApplicationSource: true,
            notDifferentSillyTavernVersion: true, sourceDeploymentId: original.deploymentId, fromBuild, toBuild };
        const variantRuntime = path.join(target, 'public', 'nodejs-project');
        await fs.writeFile(path.join(variantRuntime, markerName), JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
        const upgraded = await writeRuntimeManifest(variantRuntime, original.applicationVersion);
        if (upgraded.deploymentId === original.deploymentId) throw new Error('Variant did not produce a different deployment.');
        await verifyRuntimeManifest(variantRuntime);
        if (!originalInfo.equals(await fs.readFile(infoPath))
            || JSON.stringify(await verifyRuntimeManifest(runtimePath)) !== JSON.stringify(original)) throw new Error('Source app changed while creating variant.');
        const metadata = { ...marker, sourceApp: source, upgradeApp: target, bundleID, applicationVersion: original.applicationVersion,
            targetDeploymentId: upgraded.deploymentId, sourceInfoSHA256: fileDigest(originalInfo) };
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
        return { ...metadata, metadataPath };
    } catch (error) {
        if (ownsTarget && within(outputRoot, target) && !(await fs.lstat(target)).isSymbolicLink()) await fs.rm(target, { recursive: true, force: true });
        throw error;
    } finally {
        if (within(outputRoot, staging) && !(await fs.lstat(staging)).isSymbolicLink()) await fs.rm(staging, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 4 || args[0] !== '--source-app' || args[2] !== '--output-root') {
            throw new Error('Usage: node ios-app/scripts/create-upgrade-variant.mjs --source-app /absolute/App.app --output-root /absolute/empty-directory');
        }
        console.log(JSON.stringify(await createUpgradeVariant({ sourceApp: args[1], outputRoot: args[3] }), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
