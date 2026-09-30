import fs from 'node:fs';
import path from 'node:path';

export function redactDiagnostic(value) {
    return String(value)
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/\b(?:sk-|sk_)[\w-]+/g, '[redacted]')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/((?:api[_-]?key|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
        .slice(0, 2048);
}

export function createStartupLogger(directory, { maxBytes = 256 * 1024, maxFiles = 3 } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 4096 || !Number.isInteger(maxFiles) || maxFiles < 2) {
        throw new Error('Invalid startup log limits');
    }
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, 'startup.log');
    let pending = '';
    let size = fs.existsSync(filename) ? fs.statSync(filename).size : 0;
    let timer;

    function flush() {
        clearTimeout(timer);
        timer = undefined;
        if (!pending) return;
        const text = pending;
        pending = '';
        try {
            const bytes = Buffer.byteLength(text);
            if (size + bytes > maxBytes) {
                const oldest = `${filename}.${maxFiles - 1}`;
                if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
                for (let i = maxFiles - 2; i >= 1; --i) {
                    const older = `${filename}.${i}`;
                    if (fs.existsSync(older)) fs.renameSync(older, `${filename}.${i + 1}`);
                }
                if (fs.existsSync(filename)) fs.renameSync(filename, `${filename}.1`);
                size = 0;
            }
            fs.appendFileSync(filename, text);
            size += bytes;
        } catch {
            // Logging must not stop an otherwise healthy server.
        }
    }

    function log(message) {
        const line = `[${new Date().toISOString()}] ${redactDiagnostic(message).slice(0, 900)}\n`;
        if (Buffer.byteLength(pending + line) > Math.min(maxBytes, 32 * 1024)) flush();
        pending += line;
        timer ??= setTimeout(flush, 250).unref();
    }

    return { log, flush };
}

export function redirectConsole(logger, diagnostics = false) {
    for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
        console[level] = (...args) => {
            if (diagnostics) {
                const text = args.map(value => value instanceof Error ? value.message : typeof value === 'string' ? value : '[structured data omitted]').join(' ');
                logger.log(`${level.toUpperCase()}: ${text}`);
            } else if (level === 'warn' || level === 'error') {
                const error = args.find(value => value instanceof Error);
                const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : '';
                logger.log(`${level.toUpperCase()}: Application ${level}${code}; details omitted`);
            }
        };
    }
}
