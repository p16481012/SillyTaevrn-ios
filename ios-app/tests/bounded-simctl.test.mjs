import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundedSimctlArguments, runBoundedSimctl } from '../scripts/bounded-simctl.mjs';

test('bounded simctl requires a known phase, finite bounded timeout and a command', () => {
    assert.deepEqual(parseBoundedSimctlArguments([
        '--phase', 'bootstatus', '--timeout-ms', '600000', '--', 'bootstatus', 'A-B', '-b',
    ]), { phase: 'bootstatus', timeoutMs: 600000, args: ['bootstatus', 'A-B', '-b'] });
    for (const argv of [
        ['--phase', 'boot', '--timeout-ms', '0', '--', 'boot'],
        ['--phase', 'boot', '--timeout-ms', '600001', '--', 'boot'],
        ['--phase', 'boot', '--timeout-ms', '1.5', '--', 'boot'],
        ['--phase', 'boot;echo', '--timeout-ms', '120000', '--', 'boot'],
        ['--phase', 'boot', '--phase', 'install', '--timeout-ms', '120000', '--', 'boot'],
        ['--phase', 'boot', '--timeout-ms', '120000', '--'],
        ['--command', 'sh', '--timeout-ms', '120000', '--', 'boot'],
    ]) assert.throws(() => parseBoundedSimctlArguments(argv));
});

test('bounded simctl invokes xcrun without a shell and preserves raw stdout', async () => {
    const calls = [];
    const stdout = [];
    const stderr = [];
    let elapsed = 0;
    await runBoundedSimctl({ phase: 'list', timeoutMs: 120000, args: ['list', '--json', "an'argument"] }, {
        runCommand: async (...args) => { calls.push(args); elapsed = 17; return { stdout: '{"devices":[]}\n', stderr: 'simctl note\n' }; },
        writeStdout: value => stdout.push(value),
        writeStderr: value => stderr.push(value),
        now: () => elapsed,
    });
    assert.deepEqual(calls, [['xcrun', ['simctl', 'list', '--json', "an'argument"], 120000]]);
    assert.equal(stdout.join(''), '{"devices":[]}\n');
    assert.match(stderr.join(''), /\[simctl:list\] start timeoutMs=120000/);
    assert.match(stderr.join(''), /simctl note\n/);
    assert.match(stderr.join(''), /\[simctl:list\] passed elapsedMs=17/);
});

test('bounded simctl reports timeout and partial output without turning failure into success', async () => {
    const stdout = [];
    const stderr = [];
    const timeout = Object.assign(new Error('timed out'), {
        stdout: 'partial stdout', stderr: 'partial stderr', timedOut: true, code: 'ETIMEDOUT', signal: 'SIGKILL',
    });
    await assert.rejects(runBoundedSimctl({ phase: 'bootstatus', timeoutMs: 600000, args: ['bootstatus', 'A', '-b'] }, {
        runCommand: async () => { throw timeout; },
        writeStdout: value => stdout.push(value),
        writeStderr: value => stderr.push(value),
        now: () => 1,
    }), error => error === timeout);
    assert.equal(stdout.join(''), 'partial stdout');
    assert.match(stderr.join(''), /partial stderr/);
    assert.match(stderr.join(''), /\[simctl:bootstatus\] failed .*timedOut=true code=ETIMEDOUT signal=SIGKILL/);
});
