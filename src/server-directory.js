import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveDirectory(name, fallback) {
    const value = process.env[name];
    if (!value) return fallback;
    if (!path.isAbsolute(value)) {
        throw new Error(`${name} must be an absolute directory path`);
    }
    return path.normalize(value);
}

const sourceRoot = path.dirname(import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)));
export const isIOS = process.env.ST_IOS === '1';
export const serverDirectory = resolveDirectory('ST_SERVER_DIR', sourceRoot);
export const publicDirectory = resolveDirectory('ST_PUBLIC_DIR', path.join(serverDirectory, 'public'));
export const defaultDirectory = resolveDirectory('ST_DEFAULTS_DIR', path.join(serverDirectory, 'default'));
export const tokenizersDirectory = resolveDirectory('ST_TOKENIZERS_DIR', path.join(serverDirectory, 'src', 'tokenizers'));
export const writableDirectory = resolveDirectory('ST_USER_DATA_DIR', serverDirectory);
