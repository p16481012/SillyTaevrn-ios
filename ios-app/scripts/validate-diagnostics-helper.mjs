import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--report' || !path.isAbsolute(args[1])) {
        throw new Error('Usage: node ios-app/scripts/validate-diagnostics-helper.mjs --report /absolute/report.json');
    }
    if (process.platform !== 'darwin') throw new Error('Foundation Swift helper validation requires macOS and Xcode.');
    const reportFile = args[1];
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'st-diagnostics-swift-'));
    try {
        const binary = path.join(scratch, 'diagnostics-helper-tests');
        await run('xcrun', ['swiftc',
            path.join(repository, 'ios-app/ios/App/App/DiagnosticsExport.swift'),
            path.join(repository, 'ios-app/tests/swift-diagnostics/main.swift'), '-o', binary,
        ], { timeout: 60_000, maxBuffer: 1024 * 1024 });
        let stdout;
        try {
            ({ stdout } = await run(binary, [], { timeout: 30_000, maxBuffer: 1024 * 1024 }));
        } catch (error) {
            if (!error.stdout) throw error;
            stdout = error.stdout;
        }
        const report = JSON.parse(stdout);
        if (report.executionScope !== 'Foundation-helper-host' || !Number.isInteger(report.testCount) || report.testCount < 1
            || report.cases?.length !== report.testCount || report.passed + report.failed !== report.testCount) {
            throw new Error('The actual Foundation Swift helper produced an invalid report.');
        }
        await fs.mkdir(path.dirname(reportFile), { recursive: true });
        await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
        if (report.failed !== 0 || report.passed !== report.testCount) {
            throw new Error(`The actual Foundation Swift helper checks did not pass: ${report.cases.filter(item => item.status === 'failed').map(item => item.name).join(', ')}`);
        }
        process.stdout.write(`${report.passed}/${report.testCount} actual Foundation helper checks passed\n`);
    } finally {
        // mkdtemp returned an owned directory beneath the OS temporary root.
        await fs.rm(scratch, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    if (error.stderr) process.stderr.write(String(error.stderr).slice(-8000));
    process.exitCode = 1;
});
