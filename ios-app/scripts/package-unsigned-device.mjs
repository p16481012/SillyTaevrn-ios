#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeManifest } from './runtime-manifest.mjs';

const applicationVersion = '1.19.0';
const bundleIdentifier = 'com.sillytavern.ios';
const ipaName = `SillyTavern-iOS-${applicationVersion}-unsigned.ipa`;
const reportName = 'unsigned-device-build.json';
const inside = (root, candidate) => {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function parseUnsignedDeviceArguments(args) {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    const options = {};
    const names = { '--app': 'app', '--output-root': 'outputRoot' };
    for (let index = 0; index < args.length; index += 2) {
        const name = names[args[index]];
        const value = args[index + 1];
        if (!name || options[name] !== undefined || typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`Invalid packaging option: ${args[index]}`);
        if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an ordinary absolute path.`);
        options[name] = value;
    }
    if (!options.app?.endsWith('.app') || !options.outputRoot) throw new Error('An absolute built .app and output root are required.');
    return options;
}

async function resolvedDestination(filename) {
    let current = path.resolve(filename);
    const missing = [];
    while (true) {
        try { return path.join(await fs.realpath(current), ...missing.reverse()); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            missing.push(path.basename(current));
            current = parent;
        }
    }
}

export async function checkUnsignedOutputRoot(outputRoot, app) {
    if (!path.isAbsolute(outputRoot) || !path.isAbsolute(app)) throw new Error('App and output paths must be absolute.');
    const source = await fs.realpath(app);
    const target = await resolvedDestination(outputRoot);
    if (target === path.parse(target).root || target === source || inside(source, target) || inside(target, source)) throw new Error('Packaging output must be separate from the source app.');
    try {
        const stat = await fs.lstat(outputRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.readdir(outputRoot)).length !== 0) throw new Error('Output root must be new or an empty ordinary directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return target;
}

export function checkDeviceBundleInfo(info, manifest) {
    if (info?.CFBundleIdentifier !== bundleIdentifier || info.CFBundlePackageType !== 'APPL'
        || info.CFBundleShortVersionString !== applicationVersion || manifest?.applicationVersion !== applicationVersion
        || !Array.isArray(info.CFBundleSupportedPlatforms) || info.CFBundleSupportedPlatforms.length !== 1
        || info.CFBundleSupportedPlatforms[0] !== 'iPhoneOS'
        || (info.DTPlatformName !== undefined && info.DTPlatformName !== 'iphoneos')) {
        throw new Error('An actual SillyTavern 1.19.0 iPhoneOS application is required.');
    }
    if (typeof info.CFBundleExecutable !== 'string' || !info.CFBundleExecutable
        || /[/\\\x00-\x1f\x7f]/.test(info.CFBundleExecutable) || ['.', '..'].includes(info.CFBundleExecutable)
        || !/^[a-f0-9]{64}$/.test(manifest.deploymentId)) throw new Error('Invalid app executable or runtime deployment id.');
}

/** A generic codesign error cannot be mistaken for proof of an unsigned app. */
export function checkUnsignedCodeSign(result, app) {
    const diagnostic = `${app}: code object is not signed at all`;
    const line = result.stderr?.trim() ?? '';
    const architecturePrefix = `${diagnostic} in architecture: `;
    const architectureDiagnostic = line.startsWith(architecturePrefix) && /^[A-Za-z0-9_]+$/.test(line.slice(architecturePrefix.length));
    if (result.exitCode !== 1 || result.signal || result.killed || (result.stdout ?? '').trim()
        || (line !== diagnostic && !architectureDiagnostic)
        || /[\r\n]/.test(line)) throw new Error('codesign did not confirm that the main application is unsigned.');
    return { mainApplication: 'unsigned', checkedBy: 'codesign --display --verbose=2', exitCode: 1, diagnostic: 'code object is not signed at all' };
}

async function run(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, LANG: 'C', LC_ALL: 'C' } }, (error, stdout, stderr) => {
            if (error && (typeof error.code !== 'number' || error.killed || error.signal)) return reject(error);
            resolve({ exitCode: error?.code ?? 0, stdout, stderr, signal: error?.signal ?? null, killed: error?.killed ?? false });
        });
    });
}

async function requireSuccess(result, operation) {
    if (result.exitCode !== 0 || result.signal || result.killed) throw new Error(`${operation} failed: ${(result.stderr ?? '').slice(-2048)}`);
    return result;
}

async function checksum(filename) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

/** Reject links/special files before copying; compare all copied app bytes. */
export async function fingerprintApp(app) {
    const entries = [];
    let files = 0;
    const walk = async (directory, prefix = '') => {
        const directoryStat = await fs.lstat(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('App directories must be ordinary directories without symlinks.');
        for (const name of (await fs.readdir(directory)).sort()) {
            if (/[\\\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid bundle filename.');
            const relative = prefix ? `${prefix}/${name}` : name;
            const filename = path.join(directory, name);
            const stat = await fs.lstat(filename);
            if (stat.isSymbolicLink()) throw new Error('App symlinks are not allowed.');
            if (stat.isDirectory()) {
                entries.push(`${relative}\tdirectory\n`);
                await walk(filename, relative);
            } else if (stat.isFile()) {
                entries.push(`${relative}\t${stat.size}\t${await checksum(filename)}\n`);
                files++;
            } else throw new Error('Special files are not allowed in the app bundle.');
        }
    };
    await walk(app);
    return { sha256: createHash('sha256').update(entries.sort().join('')).digest('hex'), files };
}

/** Command injection exists only for host unit fixtures; the CLI uses macOS tools. */
export async function packageUnsignedDevice(options, { platform = process.platform, command = run, sourceRevision = process.env.GITHUB_SHA ?? null } = {}) {
    if (platform !== 'darwin') throw new Error('Packaging the actual iPhoneOS build requires macOS tools.');
    if (sourceRevision !== null && !/^[a-f0-9]{40}$/i.test(sourceRevision)) throw new Error('Source revision must be a full Git commit SHA.');
    parseUnsignedDeviceArguments(['--app', options.app, '--output-root', options.outputRoot]);
    if ((await fs.lstat(options.app)).isSymbolicLink()) throw new Error('Source app cannot be a symlink.');
    const app = await fs.realpath(options.app);
    const outputRoot = await checkUnsignedOutputRoot(options.outputRoot, app);
    const sourceFingerprint = await fingerprintApp(app);
    const runtime = path.join(app, 'public', 'nodejs-project');
    const manifest = await verifyRuntimeManifest(runtime);
    const infoResult = await requireSuccess(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]), 'Reading Info.plist');
    const info = JSON.parse(infoResult.stdout);
    checkDeviceBundleInfo(info, manifest);
    if (!(await fs.lstat(path.join(app, info.CFBundleExecutable))).isFile()) throw new Error('The app executable is missing.');
    const signature = checkUnsignedCodeSign(await command('/usr/bin/codesign', ['--display', '--verbose=2', app]), app);

    // Never recursively remove the requested output root. Only a uniquely
    // owned staging directory and exact files created by this run are cleaned.
    await fs.mkdir(outputRoot, { recursive: true });
    const rootStat = await fs.lstat(outputRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || await fs.realpath(outputRoot) !== outputRoot) throw new Error('Output root changed before ownership could be reserved.');
    if ((await fs.readdir(outputRoot)).length !== 0) throw new Error('Output root became nonempty before packaging.');
    const token = randomUUID();
    const owner = path.join(outputRoot, '.unsigned-package-owner');
    const staging = path.join(outputRoot, `.unsigned-package-${token}`);
    const partialIPA = path.join(outputRoot, `.${ipaName}.${token}.partial`);
    const ipa = path.join(outputRoot, ipaName);
    const report = path.join(outputRoot, reportName);
    await fs.writeFile(owner, token, { flag: 'wx', mode: 0o600 });
    const ownedFiles = new Set();
    let createdStaging = false;
    let completed = false;
    const assertOwnership = async () => {
        const stat = await fs.lstat(outputRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(outputRoot) !== outputRoot
            || (await fs.lstat(owner)).isSymbolicLink() || await fs.readFile(owner, 'utf8') !== token) {
            throw new Error('Cannot prove packaging output ownership; refusing cleanup.');
        }
    };
    try {
        await assertOwnership();
        await fs.mkdir(staging, { mode: 0o700 });
        createdStaging = true;
        const payload = path.join(staging, 'Payload');
        await fs.mkdir(payload);
        const copy = path.join(payload, 'App.app');
        await fs.cp(app, copy, { recursive: true, force: false, errorOnExist: true, dereference: false });
        const copiedFingerprint = await fingerprintApp(copy);
        if (copiedFingerprint.sha256 !== sourceFingerprint.sha256) throw new Error('Copied application differs from the source bundle.');
        await verifyRuntimeManifest(path.join(copy, 'public', 'nodejs-project'));
        checkUnsignedCodeSign(await command('/usr/bin/codesign', ['--display', '--verbose=2', copy]), copy);
        ownedFiles.add(partialIPA);
        await requireSuccess(await command('/usr/bin/ditto', ['-c', '-k', '--keepParent', payload, partialIPA]), 'Creating unsigned IPA');
        const ipaStat = await fs.lstat(partialIPA);
        if (!ipaStat.isFile() || ipaStat.isSymbolicLink() || ipaStat.size === 0) throw new Error('ditto did not create an ordinary nonempty IPA.');
        const ipaSha256 = await checksum(partialIPA);
        if ((await fingerprintApp(app)).sha256 !== sourceFingerprint.sha256) throw new Error('Source app changed during packaging.');
        await assertOwnership();
        // Hard-link publication refuses an existing final name atomically.
        await fs.link(partialIPA, ipa);
        ownedFiles.add(ipa);
        await fs.unlink(partialIPA);
        ownedFiles.delete(partialIPA);
        const metadata = { formatVersion: 1, status: 'packaged', artifactType: 'unsigned-iphoneos-ipa', createdAt: new Date().toISOString(),
            bundleIdentifier, applicationVersion, buildVersion: info.CFBundleVersion ?? null, sourceRevision,
            supportedPlatforms: info.CFBundleSupportedPlatforms, minimumOSVersion: info.MinimumOSVersion ?? null,
            deploymentId: manifest.deploymentId, sourceBundleFingerprint: sourceFingerprint,
            sourcePreservationVerified: true, signature,
            ipa: { filename: ipaName, sha256: ipaSha256, bytes: ipaStat.size, payloadApp: 'Payload/App.app' },
            installRequiresSigning: true, signingCredentialsRequiredForPackaging: false,
            physicalDeviceValidated: false, appStoreValidated: false };
        // Reserve before writing so a failed partial JSON remains owned too.
        const handle = await fs.open(report, 'wx', 0o644);
        ownedFiles.add(report);
        try { await handle.writeFile(JSON.stringify(metadata, null, 2) + '\n'); }
        finally { await handle.close(); }
        completed = true;
        return metadata;
    } finally {
        await assertOwnership();
        if (createdStaging) {
            const stat = await fs.lstat(staging);
            if (!inside(outputRoot, staging) || stat.isSymbolicLink() || !stat.isDirectory() || await fs.realpath(staging) !== staging) throw new Error('Unsafe staging cleanup path.');
            await fs.rm(staging, { recursive: true });
        }
        if (!completed) for (const filename of ownedFiles) {
            if (!inside(outputRoot, filename)) throw new Error('Unsafe owned-file cleanup path.');
            await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        await fs.unlink(owner);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parseUnsignedDeviceArguments(process.argv.slice(2));
        if (options.help) console.log('Usage: node package-unsigned-device.mjs --app /absolute/iphoneos/App.app --output-root /absolute/new-or-empty-output');
        else {
            const result = await packageUnsignedDevice(options);
            console.log(`Unsigned IPA: ${result.ipa.filename}; SHA256 ${result.ipa.sha256}; installation still requires signing.`);
        }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
