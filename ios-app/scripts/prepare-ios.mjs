#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bundleServer } from './bundle-server.mjs';
import { writeRuntimeManifest, verifyRuntimeManifest } from './runtime-manifest.mjs';
import { patchInstalledNodeBridge } from './patch-node-bridge.mjs';

const iosAppDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.dirname(iosAppDir);
const projectDir = path.join(iosAppDir, 'nodejs-project');
const deployDir = path.join(iosAppDir, 'nodejs-project-deploy');
const publicDir = path.join(iosAppDir, 'ios', 'App', 'App', 'public');
const pluginDir = path.join(iosAppDir, 'node_modules', '@choreruiz', 'capacitor-node-js');
const appRequire = createRequire(path.join(iosAppDir, 'package.json'));
const backendRequire = createRequire(path.join(projectDir, 'package.json'));
const rootRequire = createRequire(path.join(repoRoot, 'package.json'));
const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

function checkGeneratedTarget(target) {
    const relative = path.relative(iosAppDir, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Refusing to replace a path outside ios-app: ${target}`);
    }
}

async function replaceDirectory(source, target) {
    checkGeneratedTarget(target);
    await fs.access(source);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true, dereference: false });
}

async function checkDependencies() {
    const app = await readJson(path.join(iosAppDir, 'package.json'));
    const expected = app.dependencies['@capacitor/core'];
    for (const name of ['@capacitor/core', '@capacitor/ios', '@capacitor/cli']) {
        const installed = appRequire(`${name}/package.json`).version;
        if (installed !== expected) throw new Error(`${name} must be exactly ${expected}, found ${installed}. Run npm ci in ios-app.`);
    }
    backendRequire.resolve('js-tiktoken/lite');
    backendRequire.resolve('@jimp/js-png');
    rootRequire.resolve('webpack');
    const header = await fs.readFile(path.join(pluginDir, 'ios', 'libnode', 'include', 'node', 'node_version.h'), 'utf8');
    const major = Number(header.match(/^#define NODE_MAJOR_VERSION\s+(\d+)/m)?.[1]);
    if (major !== 18) throw new Error(`Bundled Node major changed to ${major}; review target and runtime compatibility.`);
    // Align the local plugin's SPM dependency; npm ci always reinstalls the original pin.
    const swiftPath = path.join(pluginDir, 'Package.swift');
    const swift = await fs.readFile(swiftPath, 'utf8');
    if (!/capacitor-swift-pm\.git/.test(swift) || !/exact:\s*"8\.\d+\.\d+"/.test(swift)) {
        throw new Error('Unknown Capacitor Node plugin Package.swift; review its dependency manually.');
    }
    await fs.writeFile(swiftPath, swift.replace(/exact:\s*"8\.\d+\.\d+"/g, `exact: "${expected}"`));
    await patchInstalledNodeBridge(pluginDir);
    return expected;
}

async function buildFrontend() {
    const previous = process.cwd();
    process.chdir(repoRoot);
    try {
        const { default: getPublicLibConfig } = await import(pathToFileURL(path.join(repoRoot, 'webpack.config.js')).href);
        const config = getPublicLibConfig({ forceDist: true });
        const compiler = rootRequire('webpack')(config);
        const stats = await new Promise((resolve, reject) => {
            compiler.run((error, result) => {
                compiler.close(closeError => {
                    if (error || closeError) reject(error || closeError);
                    else if (!result || result.hasErrors()) reject(new Error(result?.toString({ all: false, errors: true }) || 'Webpack produced no stats.'));
                    else resolve(result);
                });
            });
        });
        console.log(stats.toString({ all: false, timings: true, errors: true }));
        const filename = path.join(config.output.path, config.output.filename);
        if ((await fs.stat(filename)).size === 0) throw new Error('Webpack produced an empty frontend bundle.');
        return { directory: config.output.path, assets: stats.compilation.getAssets().map(asset => asset.name) };
    } finally { process.chdir(previous); }
}

async function packRanks() {
    const directory = path.join(projectDir, 'assets', 'tiktoken');
    await fs.mkdir(directory, { recursive: true });
    for (const name of ['gpt2', 'r50k_base', 'p50k_base', 'p50k_edit', 'cl100k_base', 'o200k_base']) {
        const module = await import(pathToFileURL(backendRequire.resolve(`js-tiktoken/ranks/${name}`)).href);
        const ranks = module.default?.default ?? module.default;
        if (!ranks?.bpe_ranks || !ranks.pat_str) throw new Error(`Invalid rank data: ${name}`);
        await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(ranks));
    }
}

async function thirdPartyNotices(runtimeInputs) {
    const packages = new Map();
    // Find actual bundle packages plus js-tiktoken's separately packaged rank assets.
    for (const filename of [...runtimeInputs, backendRequire.resolve('js-tiktoken/lite')]) {
        if (!filename.includes(`${path.sep}node_modules${path.sep}`)) continue;
        let directory = path.dirname(filename);
        while (directory !== path.dirname(directory)) {
            try {
                const pkg = await readJson(path.join(directory, 'package.json'));
                if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg }); break; }
            } catch { /* continue toward the package root */ }
            directory = path.dirname(directory);
        }
    }
    const notices = ['SillyTavern iOS bundled runtime third-party notices\n'];
    for (const [name, { directory, pkg }] of [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const licenses = (await fs.readdir(directory)).filter(file => /^(license|copying|notice)([.\-_]|$)/i.test(file)).sort();
        notices.push(`\n=== ${name} (${typeof pkg.license === 'string' ? pkg.license : 'see package license'}) ===\n`);
        for (const license of licenses) {
            const filename = path.join(directory, license);
            if ((await fs.stat(filename)).isFile()) notices.push(await fs.readFile(filename, 'utf8'));
        }
    }
    await fs.writeFile(path.join(deployDir, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
}

export async function prepareIos({ sync = false } = {}) {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Build host requires Node 22 or newer (mobile runtime remains Node 18).');
    if (sync && process.platform !== 'darwin') throw new Error('Capacitor iOS sync requires macOS. Use prepare:ios to build runtime assets on Windows.');
    const capacitorVersion = await checkDependencies();
    const rootPackage = await readJson(path.join(repoRoot, 'package.json'));
    const backendPackage = await readJson(path.join(projectDir, 'package.json'));
    if (backendPackage.version !== rootPackage.version) throw new Error('Backend package version must match the root application version.');
    console.log(`Preparing SillyTavern ${rootPackage.version}; Capacitor ${capacitorVersion}, mobile Node 18.`);
    await replaceDirectory(path.join(repoRoot, 'src'), path.join(projectDir, 'src'));
    await fs.copyFile(path.join(repoRoot, 'plugins.js'), path.join(projectDir, 'plugins.js'));
    await packRanks();
    const { runtimeInputs } = await bundleServer();
    const frontend = await buildFrontend();

    checkGeneratedTarget(deployDir);
    await fs.rm(deployDir, { recursive: true, force: true });
    await fs.mkdir(deployDir, { recursive: true });
    for (const file of ['server-ios.js', 'startup-log.mjs', 'runtime-polyfills.mjs', 'server-bundle.mjs', 'config.yaml', 'package.json']) {
        await fs.copyFile(path.join(projectDir, file), path.join(deployDir, file));
    }
    await fs.cp(path.join(projectDir, 'assets'), path.join(deployDir, 'assets'), { recursive: true });
    await fs.cp(path.join(repoRoot, 'src', 'tokenizers'), path.join(deployDir, 'src', 'tokenizers'), { recursive: true });
    await fs.cp(path.join(repoRoot, 'plugins'), path.join(deployDir, 'plugins'), { recursive: true });
    await fs.copyFile(path.join(repoRoot, 'LICENSE'), path.join(deployDir, 'LICENSE'));
    await thirdPartyNotices(runtimeInputs);
    const manifest = await writeRuntimeManifest(deployDir, rootPackage.version);
    await verifyRuntimeManifest(deployDir);

    if (sync) {
        const cli = appRequire.resolve('@capacitor/cli/bin/capacitor');
        const result = spawnSync(process.execPath, [cli, 'sync', 'ios'], { cwd: iosAppDir, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Capacitor sync failed (${result.status}).`);
    }
    // All assets are prepared on every host; cap sync cannot replace the compiled lib.
    await replaceDirectory(path.join(repoRoot, 'public'), publicDir);
    for (const asset of frontend.assets) {
        const target = path.resolve(publicDir, asset);
        const relative = path.relative(publicDir, target);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Invalid frontend asset path: ${asset}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(frontend.directory, asset), target);
    }
    await fs.cp(deployDir, path.join(publicDir, 'nodejs-project'), { recursive: true });
    await fs.cp(path.join(repoRoot, 'default'), path.join(publicDir, 'st-defaults', 'default'), { recursive: true });
    await fs.cp(path.join(pluginDir, 'ios', 'assets', 'builtin_modules'), path.join(publicDir, 'builtin_modules'), { recursive: true });
    await verifyRuntimeManifest(path.join(publicDir, 'nodejs-project'));
    console.log(`Runtime ready: ${manifest.files.length} files, deployment ${manifest.deploymentId}.`);
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const unknown = process.argv.slice(2).filter(arg => arg !== '--sync');
    if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
    await prepareIos({ sync: process.argv.includes('--sync') });
}
