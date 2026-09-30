#!/usr/bin/env node
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const iosAppDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(iosAppDir, 'nodejs-project');
const adapterDir = path.join(projectDir, 'adapters');
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Bundle only runtime code. Every non-builtin import must be included. */
export async function bundleServer() {
    const aliases = {
        tiktoken: path.join(adapterDir, 'tiktoken.mjs'),
        'sillytavern-transformers': path.join(adapterDir, 'transformers.mjs'),
        '@agnai/web-tokenizers': path.join(adapterDir, 'web-tokenizers.mjs'),
        '@agnai/sentencepiece-js': path.join(adapterDir, 'sentencepiece.mjs'),
        '@jimp/wasm-png': '@jimp/js-png',
        '@jimp/wasm-jpeg': '@jimp/js-jpeg',
        '@jimp/wasm-webp': path.join(adapterDir, 'webp.mjs'),
        '@jimp/wasm-avif': path.join(adapterDir, 'avif.mjs'),
        'simple-git': path.join(adapterDir, 'simple-git.mjs'),
        'command-exists': path.join(adapterDir, 'command-exists.mjs'),
        'pac-proxy-agent': path.join(adapterDir, 'pac-proxy-agent.mjs'),
        open: path.join(adapterDir, 'open.mjs'),
    };
    const result = await build({
        absWorkingDir: projectDir,
        entryPoints: [path.join(projectDir, 'server-ios-entry.js')],
        outfile: path.join(projectDir, 'server-bundle.mjs'),
        bundle: true,
        platform: 'node',
        // @choreruiz/capacitor-node-js 1.0.2 ships Node 18.20.4, ABI 108.
        target: 'node18',
        format: 'esm',
        mainFields: ['main', 'module'],
        conditions: ['node', 'require', 'default'],
        alias: aliases,
        metafile: true,
        sourcemap: false,
        logLevel: 'warning',
        banner: {
            js: [
                "import { createRequire as __iosCreateRequire } from 'node:module';",
                "import { fileURLToPath as __iosFileURLToPath } from 'node:url';",
                "import { dirname as __iosDirname } from 'node:path';",
                'const require = __iosCreateRequire(import.meta.url);',
                'const __filename = __iosFileURLToPath(import.meta.url);',
                'const __dirname = __iosDirname(__filename);',
            ].join('\n'),
        },
        plugins: [{
            name: 'ios-prebuilt-frontend',
            setup(builder) {
                builder.onResolve({ filter: /^vectra$/ }, () => ({ path: path.join(adapterDir, 'vectra.mjs') }));
                builder.onResolve({ filter: /webpack-serve\.js$/ }, args => {
                    if (path.resolve(args.resolveDir, args.path) === path.join(projectDir, 'src', 'middleware', 'webpack-serve.js')) {
                        return { path: path.join(adapterDir, 'webpack-serve.mjs') };
                    }
                });
            },
        }],
    });

    const unresolved = Object.values(result.metafile.outputs).flatMap(output => output.imports)
        .filter(item => item.external && !builtins.has(item.path));
    if (unresolved.length) {
        throw new Error(`Unbundled runtime imports: ${[...new Set(unresolved.map(item => item.path))].join(', ')}`);
    }
    const unexpected = Object.keys(result.metafile.inputs).filter(input => /\.wasm$|\.node$|gpt-3-encoder|onnxruntime|quickjs-emscripten|degenerator|wasm-(png|jpeg|webp|avif)/.test(input));
    if (unexpected.length) {
        throw new Error(`Native/WASM runtime inputs were bundled: ${unexpected.join(', ')}`);
    }
    const runtimeInputs = Object.keys(result.metafile.inputs).map(input => path.resolve(projectDir, input));
    await fs.writeFile(path.join(projectDir, 'bundle-audit.json'), JSON.stringify({
        target: 'node18', externalImports: [], inputs: runtimeInputs.map(input => path.relative(projectDir, input).replaceAll('\\', '/')),
    }, null, 2) + '\n');
    return { runtimeInputs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await bundleServer();
    console.log('Backend bundled; no unresolved package imports.');
}
