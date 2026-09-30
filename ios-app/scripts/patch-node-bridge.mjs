import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const originalSHA256 = 'd8fa68f62aa066bb9b48122497ad3c8256533a78f2e55dda13181b4bd6683d9c';
const patchedSHA256 = '798b5d6cf5dd7dfc122b441c04f7498e8d8071b782968cdbd5cf248743698cab';
const digest = source => createHash('sha256').update(source).digest('hex');

/** Only the reviewed, pinned bridge can be changed; npm ci restores it. */
export function patchNodeBridge(source) {
    const normalized = source.replace(/\r\n/g, '\n');
    const hash = digest(normalized);
    if (hash === patchedSHA256) return normalized;
    if (hash !== originalSHA256) throw new Error('Unknown Capacitor Node bridge source; review the native logging patch before building.');
    const patched = normalized
        .replace('#include <pthread.h>\n', '')
        .replace('#include <unistd.h>\n', '')
        .replace(/\/\/ ---- stdout\/stderr redirection to os_log ----[\s\S]*?(?=\/\/ ---- NodeProcess implementation ----)/,
            '// Keep the process stdout/stderr descriptors intact. Under Xcode,\n'
            + '// os_log may mirror to stderr; piping stderr back to os_log loops.\n'
            + '// SillyTavern already writes bounded startup diagnostics to a file.\n\n')
        .replace('    // Redirect stdout/stderr to os_log\n'
            + '    if (startRedirectingStdoutStderr() == -1) {\n'
            + '        os_log_error(nodeLog, "Failed to redirect stdout/stderr to os_log.");\n'
            + '    }\n\n', '');
    if (digest(patched) !== patchedSHA256) throw new Error('Unexpected native logging patch result; refusing to write the bridge.');
    return patched;
}

export async function patchInstalledNodeBridge(pluginDirectory) {
    const packagePath = path.join(pluginDirectory, 'package.json');
    const installed = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    if (installed.name !== '@choreruiz/capacitor-node-js' || installed.version !== '1.0.2') {
        throw new Error('Native logging patch requires @choreruiz/capacitor-node-js 1.0.2.');
    }
    const bridgePath = path.join(pluginDirectory, 'ios', 'Bridge', 'NodeProcess.mm');
    const source = await fs.readFile(bridgePath, 'utf8');
    const patched = patchNodeBridge(source);
    if (patched !== source) await fs.writeFile(bridgePath, patched);
}
