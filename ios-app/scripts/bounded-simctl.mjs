#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunCommand } from './validate-simulator-data.mjs';

export function parseBoundedSimctlArguments(argv) {
    const separator = argv.indexOf('--');
    if (separator < 0 || separator === argv.length - 1 || separator % 2 !== 0) {
        throw new Error('Expected --phase <label> --timeout-ms <1..600000> -- <simctl arguments>.');
    }
    const options = {};
    for (let index = 0; index < separator; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (!['--phase', '--timeout-ms'].includes(name) || !value || options[name] !== undefined) {
            throw new Error('Invalid or repeated bounded simctl option.');
        }
        options[name] = value;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(options['--phase'] ?? '')) throw new Error('A short phase label is required.');
    const timeoutText = options['--timeout-ms'] ?? '';
    if (!/^[1-9][0-9]*$/.test(timeoutText) || Number(timeoutText) > 600000) {
        throw new Error('simctl timeout must be 1..600000 milliseconds.');
    }
    return { phase: options['--phase'], timeoutMs: Number(timeoutText), args: argv.slice(separator + 1) };
}

export async function runBoundedSimctl({ phase, timeoutMs, args }, {
    runCommand = defaultRunCommand,
    writeStdout = value => process.stdout.write(value),
    writeStderr = value => process.stderr.write(value),
    now = () => Date.now(),
} = {}) {
    const startedAt = now();
    writeStderr(`[simctl:${phase}] start timeoutMs=${timeoutMs}\n`);
    try {
        const result = await runCommand('xcrun', ['simctl', ...args], timeoutMs);
        if (result.stdout) writeStdout(result.stdout);
        if (result.stderr) writeStderr(result.stderr);
        writeStderr(`[simctl:${phase}] passed elapsedMs=${now() - startedAt}\n`);
        return result;
    } catch (error) {
        if (error.stdout) writeStdout(error.stdout);
        if (error.stderr) writeStderr(error.stderr);
        writeStderr(`[simctl:${phase}] failed elapsedMs=${now() - startedAt} timeoutMs=${timeoutMs} timedOut=${error.timedOut === true} code=${String(error.code ?? '')} signal=${String(error.signal ?? '')}\n`);
        throw error;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await runBoundedSimctl(parseBoundedSimctlArguments(process.argv.slice(2)));
    } catch (error) {
        if (!error.code && !error.timedOut) console.error(error.message);
        process.exitCode = 1;
    }
}
