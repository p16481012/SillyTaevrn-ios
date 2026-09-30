import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';

const repositoryOperations = new Map();

/** @param {string} name Branch name, without a refs/heads prefix @param {boolean} [configuration=false] Whether config must safely round-trip the name */
function validateBranchName(name, configuration = false) {
    if (typeof name !== 'string' || !name || name === '@' || name === 'HEAD'
        || name.startsWith('-') || name.startsWith('refs/') || name.endsWith('.')
        || name.includes('..') || name.includes('@{') || /[\x00-\x20\x7f~^:?*[\]\\]/.test(name)
        || name.split('/').some(part => !part || part.startsWith('.') || /\.lock$/i.test(part))) {
        throw new IOSGitError('IOS_EXTENSION_GIT_INVALID_BRANCH', 'A valid local branch or origin/<branch> name is required.', 400);
    }
    if (configuration && /["#;]/.test(name)) {
        throw new IOSGitError('IOS_EXTENSION_GIT_UNSUPPORTED_BRANCH', 'The bundled Git configuration writer cannot safely represent branch names containing quotes, # or ;. Choose another branch.', 400);
    }
}

/**
 * Include Git metadata as well as file bytes: a concurrent commit or config edit
 * must not be lost when replacing a prepared repository. Never follow symlinks.
 * @param {string} directory Repository root
 * @returns {Promise<{fingerprint: string, entries: Object[]}>} Content and file-type snapshot
 */
async function repositorySnapshot(directory) {
    const entries = [];
    async function visit(relative) {
        const absolute = path.join(directory, relative);
        const stat = await fs.promises.lstat(absolute);
        const entry = { path: relative.split(path.sep).join('/'), mode: stat.mode };
        if (stat.isSymbolicLink()) {
            entry.kind = 'link';
            entry.sha256 = createHash('sha256').update(await fs.promises.readlink(absolute)).digest('hex');
            entries.push(entry);
        } else if (stat.isDirectory()) {
            entry.kind = 'directory';
            entries.push(entry);
            for (const entry of (await fs.promises.readdir(absolute)).sort()) await visit(path.join(relative, entry));
        } else if (stat.isFile()) {
            entry.kind = 'file'; entry.size = stat.size;
            const hash = createHash('sha256');
            for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
            entry.sha256 = hash.digest('hex');
            entries.push(entry);
        } else {
            throw new IOSGitError('IOS_EXTENSION_GIT_CHANGED', 'The extension contains a file type that cannot be safely copied.');
        }
    }
    await visit('');
    return { fingerprint: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

/** @param {string} directory Repository root @returns {Promise<string>} */
async function repositoryFingerprint(directory) {
    return (await repositorySnapshot(directory)).fingerprint;
}

const transactionPrefix = /^\.st-ios-git-switch-[a-zA-Z0-9_-]{6}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

/** @param {string} directory Owned transaction directory @returns {Promise<Object|undefined>} */
async function readJournal(directory) {
    try {
        if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('Invalid transaction directory');
        const journalPath = path.join(directory, 'journal.json');
        if (!(await fs.promises.lstat(journalPath)).isFile()) throw new Error('Invalid journal file');
        const record = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
        if (record.formatVersion !== 1 || record.operation !== 'switch' || typeof record.target !== 'string'
            || !record.target || ['.', '..'].includes(record.target) || /[\0/\\]/.test(record.target)
            || path.basename(record.target) !== record.target || path.win32.basename(record.target) !== record.target
            || !['preparing', 'prepared', 'previous', 'installed', 'committed'].includes(record.phase)
            || !sha256Pattern.test(record.originalFingerprint) || !Array.isArray(record.originalEntries)
            || createHash('sha256').update(JSON.stringify(record.originalEntries)).digest('hex') !== record.originalFingerprint
            || (record.phase !== 'preparing' && !sha256Pattern.test(record.preparedFingerprint))) throw new Error('Invalid journal');
        return record;
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw new IOSGitError('IOS_EXTENSION_GIT_RECOVERY_REQUIRED', `The interrupted extension Git operation at ${directory} has an invalid recovery record. Preserve its files and resolve the record before retrying.`);
    }
}

/** @param {string} directory Owned transaction directory @param {Object} record Journal */
async function writeJournal(directory, record) {
    const temporary = path.join(directory, 'journal.json.tmp');
    try {
        // Exclusive creation must reject an existing file or symbolic link without
        // opening it. A preflight lstat followed by a truncating write is unsafe.
        await fs.promises.writeFile(temporary, JSON.stringify(record), { flag: 'wx' });
    } catch (error) {
        if (error.code === 'EEXIST') {
            throw new IOSGitError('IOS_EXTENSION_GIT_RECOVERY_REQUIRED', `The interrupted extension Git operation at ${directory} contains an existing temporary journal. Its files were preserved; inspect the recovery directory before retrying.`);
        }
        throw error;
    }
    await fs.promises.rename(temporary, path.join(directory, 'journal.json'));
}

export class IOSGitError extends Error {
    /**
     * @param {string} code Error identifier
     * @param {string} message User-facing explanation
     * @param {number} [status=409] HTTP status
     */
    constructor(code, message, status = 409) {
        super(message);
        this.name = 'IOSGitError';
        this.code = code;
        this.status = status;
    }
}

/**
 * Git operations for writable iOS extensions. No system Git process is needed.
 */
export class IOSGitClient {
    /** @param {string} name Branch to create with the bundled configuration writer */
    static validateBranch(name) {
        validateBranchName(name, true);
    }

    /**
     * @param {string} directory Extension repository root
     * @param {{ http?: import('isomorphic-git').HttpClient }} [options] HTTP transport
     */
    constructor(directory, options = {}) {
        this.directory = path.resolve(directory);
        this.http = options.http ?? http;
    }

    /** @returns {Promise<boolean>} Whether the directory has its own non-bare Git repository */
    async checkIsRepo() {
        try {
            if (!(await fs.promises.lstat(this.directory)).isDirectory()) return false;
            const metadata = await fs.promises.lstat(path.join(this.directory, '.git'));
            if (!metadata.isDirectory()) return false;
            const root = await git.findRoot({ fs, filepath: this.directory });
            return path.resolve(root) === this.directory;
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'NotFoundError') return false;
            throw error;
        }
    }

    /** @returns {Promise<string[]>} Locally changed, staged, untracked or ignored files */
    async status() {
        await this.requireRepository();
        let committed;
        try {
            committed = await git.listFiles({ fs, dir: this.directory, ref: 'HEAD' });
        } catch (error) {
            if (error.code === 'NotFoundError') {
                throw new IOSGitError('IOS_EXTENSION_NO_GIT_COMMITS', 'The extension Git repository has no commit to update.');
            }
            throw error;
        }
        const staged = await git.listFiles({ fs, dir: this.directory });
        const working = await fs.promises.readdir(this.directory);
        // Include ignored user files, but prune Git's own metadata directory.
        // HEAD/index names also catch files deleted from the working directory.
        const filepaths = [...new Set([...committed, ...staged, ...working].map(filename => filename.split('/')[0]))].filter(filename => filename !== '.git');
        if (filepaths.length === 0) return [];
        const matrix = await git.statusMatrix({ fs, dir: this.directory, filepaths, ignored: true });
        return matrix.filter(([, head, workdir, stage]) => head !== workdir || head !== stage).map(([filename]) => filename);
    }

    /** @returns {Promise<{ currentBranchName: string, currentCommitHash: string, isUpToDate: boolean, remoteUrl: string }>} */
    async version() {
        return this.serialize(async () => {
            await this.recoverPending();
            const state = await this.fetchState();
            return this.publicVersion(state);
        });
    }

    /** @returns {Promise<Array<{current: boolean, commit: string, name: string, label: string}>>} */
    async branches() {
        return this.serialize(async () => {
            await this.recoverPending();
            const state = await this.headState();
            const origin = await this.origin();
            const locals = await git.listBranches({ fs, dir: this.directory });
            const remoteBranches = await this.remoteBranches(origin.url);
            const temporary = await this.temporaryDirectory('query');
            try {
                await git.init({ fs, dir: temporary, defaultBranch: 'main' });
                await git.addRemote({ fs, dir: temporary, remote: 'origin', url: origin.url });
                // Fetch branch tips in isolation. A depth-limited query must not
                // alter the installed repository's shallow boundaries or refs.
                if (remoteBranches.length) {
                    await this.fetchBranch(temporary, remoteBranches[0].name, { singleBranch: false });
                }
                const result = [];
                for (const name of locals) {
                    validateBranchName(name);
                    const oid = await git.resolveRef({ fs, dir: this.directory, ref: `refs/heads/${name}` });
                    result.push(await this.branchDescription(this.directory, name, oid, name === state.currentBranchName));
                }
                for (const branch of remoteBranches) {
                    const oid = await git.resolveRef({ fs, dir: temporary, ref: `refs/remotes/origin/${branch.name}` });
                    if (oid !== branch.oid) throw this.changedError();
                    result.push(await this.branchDescription(temporary, `origin/${branch.name}`, oid, false));
                }
                await this.requireSameHead(state);
                return result;
            } finally {
                await fs.promises.rm(temporary, { recursive: true, force: true });
            }
        });
    }

    /** @param {string} requested Local branch name or origin/<branch> @returns {Promise<void>} */
    async switchBranch(requested) {
        const fromOrigin = typeof requested === 'string' && requested.startsWith('origin/');
        const branch = fromOrigin ? requested.slice('origin/'.length) : requested;
        validateBranchName(branch, true);
        return this.serialize(async () => {
            await this.recoverPending();
            await this.requireClean();
            const state = await this.headState();
            const locals = await git.listBranches({ fs, dir: this.directory });
            const existsLocally = locals.includes(branch);
            if (!existsLocally && !fromOrigin) {
                throw new IOSGitError('IOS_EXTENSION_GIT_BRANCH_UNAVAILABLE', `Branch ${branch} does not exist locally`, 404);
            }
            if (existsLocally) {
                const remote = await git.getConfig({ fs, dir: this.directory, path: `branch.${branch}.remote` });
                if (remote && remote !== 'origin') {
                    throw new IOSGitError('IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE', 'This branch tracks a remote other than origin. Its tracking configuration must be resolved before switching.');
                }
                if (state.currentBranchName === branch) return;
            }
            const snapshot = await repositorySnapshot(this.directory);
            const fingerprint = snapshot.fingerprint;
            const temporary = await this.temporaryDirectory('switch');
            const prepared = path.join(temporary, 'prepared');
            let preserveRecovery = false;
            const journal = { formatVersion: 1, operation: 'switch', target: path.basename(this.directory),
                phase: 'preparing', originalFingerprint: fingerprint, originalEntries: snapshot.entries };
            try {
                await writeJournal(temporary, journal);
                await fs.promises.cp(this.directory, prepared, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
                if (await repositoryFingerprint(prepared) !== fingerprint) throw this.changedError();
                if (!existsLocally) {
                    const origin = await this.origin();
                    const remoteBranches = await this.remoteBranches(origin.url);
                    const advertised = remoteBranches.find(item => item.name === branch);
                    if (!advertised) {
                        throw new IOSGitError('IOS_EXTENSION_GIT_BRANCH_UNAVAILABLE', `Branch origin/${branch} does not exist remotely`, 404);
                    }
                    const fetched = await this.fetchBranch(prepared, branch);
                    if (fetched.fetchHead !== advertised.oid) throw this.changedError();
                    await git.writeRef({ fs, dir: prepared, ref: `refs/heads/${branch}`, value: fetched.fetchHead });
                    await git.writeRef({ fs, dir: prepared, ref: `refs/remotes/origin/${branch}`, value: fetched.fetchHead, force: true });
                    await git.setConfig({ fs, dir: prepared, path: `branch.${branch}.remote`, value: 'origin' });
                    await git.setConfig({ fs, dir: prepared, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
                }
                await git.checkout({ fs, dir: prepared, ref: `refs/heads/${branch}`, force: false, track: false });
                await new IOSGitClient(prepared).requireClean();
                journal.preparedFingerprint = await repositoryFingerprint(prepared);
                journal.phase = 'prepared';
                await writeJournal(temporary, journal);
                await this.requireClean();
                await this.requireSameHead(state);
                if (await repositoryFingerprint(this.directory) !== fingerprint) throw this.changedError();
                // A failed checkout only touched the disposable copy. Keep the
                // original repository until replacement and race checks finish.
                const previous = path.join(temporary, 'previous');
                await fs.promises.rename(this.directory, previous);
                let installed = false;
                try {
                    journal.phase = 'previous';
                    await writeJournal(temporary, journal);
                    if (await repositoryFingerprint(previous) !== fingerprint) throw this.changedError();
                    await fs.promises.rename(prepared, this.directory);
                    installed = true;
                    journal.phase = 'installed';
                    await writeJournal(temporary, journal);
                    if (await repositoryFingerprint(previous) !== fingerprint) throw this.changedError();
                    journal.phase = 'committed';
                    await writeJournal(temporary, journal);
                } catch (error) {
                    try {
                        if (installed) {
                            await new IOSGitClient(this.directory).requireClean();
                            if (await repositoryFingerprint(this.directory) !== journal.preparedFingerprint) throw this.changedError();
                            await fs.promises.rename(this.directory, prepared);
                        }
                        // Never overwrite a directory created by another writer.
                        if (fs.existsSync(this.directory)) throw this.changedError();
                        await fs.promises.rename(previous, this.directory);
                    } catch {
                        preserveRecovery = true;
                        throw new IOSGitError('IOS_EXTENSION_GIT_RECOVERY_REQUIRED', `Branch replacement could not be completed safely. The original extension is preserved at ${previous}; resolve concurrent file changes before retrying.`);
                    }
                    throw error;
                }
            } catch (error) {
                if (error instanceof IOSGitError) {
                    if (error.code === 'IOS_EXTENSION_GIT_RECOVERY_REQUIRED') preserveRecovery = true;
                    throw error;
                }
                if (['NotFoundError', 'CommitNotFetchedError'].includes(error.code)) {
                    throw new IOSGitError('IOS_EXTENSION_GIT_HISTORY_INCOMPLETE', 'The selected branch commit or files are missing. No installed files were replaced.');
                }
                throw new IOSGitError('IOS_EXTENSION_GIT_SWITCH_FAILED', 'Could not prepare or replace the extension branch. Check available storage and finish other file operations, then retry.', 502);
            } finally {
                if (!preserveRecovery) await this.removeTransaction(temporary);
            }
        });
    }

    /** @param {string} purpose Temporary operation name @returns {Promise<string>} */
    async temporaryDirectory(purpose) {
        return fs.promises.mkdtemp(path.join(path.dirname(this.directory), `.st-ios-git-${purpose}-`));
    }

    /** @returns {Promise<void>} Recover an interrupted replacement before path existence checks */
    async recover() {
        return this.serialize(() => this.recoverPending());
    }

    /** @param {string} directory Extension parent @returns {Promise<void>} */
    static async recoverAll(directory) {
        if (!fs.existsSync(directory)) return;
        const targets = new Set();
        for (const name of (await fs.promises.readdir(directory)).filter(name => transactionPrefix.test(name))) {
            const record = await readJournal(path.join(directory, name));
            if (record) targets.add(record.target);
        }
        for (const target of targets) await new IOSGitClient(path.join(directory, target)).recover();
    }

    /** @returns {Promise<void>} Runs under the same repository lock as update/switch/query */
    async recoverPending() {
        const parent = path.dirname(this.directory);
        if (!fs.existsSync(parent)) return;
        const pending = [];
        for (const name of (await fs.promises.readdir(parent)).filter(name => transactionPrefix.test(name))) {
            const directory = path.join(parent, name);
            const journal = await readJournal(directory);
            if (journal?.target === path.basename(this.directory)) pending.push({ directory, journal });
        }
        if (pending.length > 1) {
            throw new IOSGitError('IOS_EXTENSION_GIT_RECOVERY_REQUIRED', 'Multiple interrupted branch operations need inspection. All extension files have been preserved.');
        }
        for (const { directory, journal } of pending) {
            const previous = path.join(directory, 'previous');
            const prepared = path.join(directory, 'prepared');
            const installed = fs.existsSync(this.directory);
            const hasPrevious = fs.existsSync(previous);
            const conflict = () => new IOSGitError('IOS_EXTENSION_GIT_RECOVERY_REQUIRED', `An interrupted branch operation contains concurrent or incomplete files. Nothing was deleted or overwritten. Inspect ${directory} before retrying.`);
            if (!installed) {
                if (!hasPrevious || !await new IOSGitClient(previous).checkIsRepo()) throw conflict();
                // Restore the original including any late user edits. The ready
                // copy is never installed over an absent original during recovery.
                await fs.promises.rename(previous, this.directory);
                if (fs.existsSync(prepared) && journal.preparedFingerprint
                    && await repositoryFingerprint(prepared) !== journal.preparedFingerprint) throw conflict();
                await this.removeTransaction(directory);
                continue;
            }
            const currentFingerprint = await repositoryFingerprint(this.directory);
            if (hasPrevious) {
                const old = await repositorySnapshot(previous);
                if (currentFingerprint !== journal.preparedFingerprint || fs.existsSync(prepared)) throw conflict();
                if (journal.phase === 'committed') {
                    // A crash during backup removal may leave only some original
                    // entries. Unknown/new bytes still block cleanup, never vanish.
                    const expected = new Map(journal.originalEntries.map(entry => [entry.path, JSON.stringify(entry)]));
                    if (!old.entries.every(entry => expected.get(entry.path) === JSON.stringify(entry))) throw conflict();
                } else if (old.fingerprint !== journal.originalFingerprint) throw conflict();
                journal.phase = 'committed';
                await writeJournal(directory, journal);
            } else {
                const expected = ['installed', 'committed'].includes(journal.phase) ? journal.preparedFingerprint : journal.originalFingerprint;
                if (currentFingerprint !== expected) throw conflict();
            }
            await this.removeTransaction(directory);
        }
    }

    /** @param {string} directory Owned temporary directory; remove the journal last */
    async removeTransaction(directory) {
        const conflict = () => new IOSGitError('IOS_EXTENSION_GIT_RECOVERY_REQUIRED', `Concurrent files were found while cleaning up ${directory}. They were preserved; inspect the recovery directory before retrying.`);
        // A leftover temporary journal may belong to another writer, including a
        // symlink. Preserve it and every repository copy instead of deleting it.
        try {
            await fs.promises.lstat(path.join(directory, 'journal.json.tmp'));
            throw conflict();
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const journal = await readJournal(directory);
        const prepared = path.join(directory, 'prepared');
        const previous = path.join(directory, 'previous');
        if (journal?.preparedFingerprint && fs.existsSync(prepared)
            && await repositoryFingerprint(prepared) !== journal.preparedFingerprint) throw conflict();
        if (fs.existsSync(previous)) {
            if (!journal) throw conflict();
            const snapshot = await repositorySnapshot(previous);
            const expected = new Map(journal.originalEntries.map(entry => [entry.path, JSON.stringify(entry)]));
            if (!snapshot.entries.every(entry => expected.get(entry.path) === JSON.stringify(entry))) throw conflict();
            // Only unlink verified original entries. rmdir, rather than recursive
            // rm, preserves a new user filename arriving after the snapshot.
            for (const entry of snapshot.entries.reverse()) {
                const absolute = path.join(previous, entry.path);
                try {
                    if (entry.kind === 'directory') {
                        const stat = await fs.promises.lstat(absolute);
                        if (!stat.isDirectory() || stat.mode !== entry.mode) throw conflict();
                        await fs.promises.rmdir(absolute);
                    } else {
                        const current = (await repositorySnapshot(absolute)).entries[0];
                        current.path = entry.path;
                        if (JSON.stringify(current) !== expected.get(entry.path)) throw conflict();
                        await fs.promises.unlink(absolute);
                    }
                } catch {
                    throw conflict();
                }
            }
        }
        await fs.promises.rm(prepared, { recursive: true, force: true });
        await fs.promises.rm(path.join(directory, 'journal.json'), { force: true });
        await fs.promises.rmdir(directory);
    }

    /** @returns {IOSGitError} Concurrent repository change */
    changedError() {
        return new IOSGitError('IOS_EXTENSION_GIT_CHANGED', 'The extension changed during the Git operation. No concurrent changes will be overwritten; finish other changes and retry.');
    }

    /** @returns {Promise<{currentBranchName: string, currentCommitHash: string}>} */
    async headState() {
        await this.requireRepository();
        const currentBranchName = await git.currentBranch({ fs, dir: this.directory });
        if (!currentBranchName) {
            throw new IOSGitError('IOS_EXTENSION_GIT_DETACHED', 'The extension is not on a branch. Preserve any detached commits with a Git client before changing its branch.');
        }
        validateBranchName(currentBranchName);
        let currentCommitHash;
        try {
            currentCommitHash = await git.resolveRef({ fs, dir: this.directory, ref: 'HEAD' });
        } catch (error) {
            if (error.code === 'NotFoundError') throw new IOSGitError('IOS_EXTENSION_NO_GIT_COMMITS', 'The extension Git repository has no commit to select a branch from.');
            throw error;
        }
        return { currentBranchName, currentCommitHash };
    }

    /** @param {{currentBranchName: string, currentCommitHash: string}} state Original HEAD */
    async requireSameHead(state) {
        const current = await this.headState();
        if (current.currentBranchName !== state.currentBranchName || current.currentCommitHash !== state.currentCommitHash) throw this.changedError();
    }

    /** @returns {Promise<{url: string, publicUrl: string}>} Validated origin URL */
    async origin() {
        const url = await git.getConfig({ fs, dir: this.directory, path: 'remote.origin.url' });
        try {
            const parsed = new URL(url);
            if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported Git transport');
            parsed.username = ''; parsed.password = '';
            return { url, publicUrl: parsed.href };
        } catch {
            throw new IOSGitError('IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE', 'The extension has no HTTP or HTTPS origin repository to check.');
        }
    }

    /** @param {string} url Origin URL @returns {Promise<Array<{name: string, oid: string}>>} */
    async remoteBranches(url) {
        let refs;
        try {
            refs = await git.listServerRefs({ http: this.http, url, prefix: 'refs/heads/', protocolVersion: 1 });
        } catch {
            throw new IOSGitError('IOS_EXTENSION_GIT_FETCH_FAILED', 'Could not list the extension repository branches. Check the connection and repository access, then retry.', 502);
        }
        return refs.map(ref => {
            const name = ref.ref.slice('refs/heads/'.length);
            validateBranchName(name);
            if (!/^[a-f0-9]{40}$/.test(ref.oid)) throw this.changedError();
            return { name, oid: ref.oid };
        }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }

    /** @param {string} directory Temporary repository @param {string} branch Branch name @param {{singleBranch?: boolean}} [options] Fetch scope */
    async fetchBranch(directory, branch, { singleBranch = true } = {}) {
        try {
            return await git.fetch({ fs, http: this.http, dir: directory, remote: 'origin', ref: branch,
                remoteRef: `refs/heads/${branch}`, singleBranch, tags: false, depth: 1 });
        } catch {
            throw new IOSGitError('IOS_EXTENSION_GIT_FETCH_FAILED', 'Could not fetch the selected extension branch. Check the connection and repository access, then retry.', 502);
        }
    }

    /** @param {string} directory Repository @param {string} name Public branch name @param {string} oid Commit @param {boolean} current Selected branch */
    async branchDescription(directory, name, oid, current) {
        const { commit } = await git.readCommit({ fs, dir: directory, oid });
        return { current, commit: oid.slice(0, 7), name, label: commit.message.split(/\r?\n/)[0] };
    }

    /** @returns {Promise<{ shortCommitHash: string, isUpToDate: boolean, remoteUrl: string }>} */
    async update() {
        return this.serialize(async () => {
            await this.recoverPending();
            await this.requireClean();
            const state = await this.fetchState();
            await this.requireClean();
            const currentHead = await git.resolveRef({ fs, dir: this.directory, ref: 'HEAD' });
            const currentBranch = await git.currentBranch({ fs, dir: this.directory });
            if (currentHead !== state.currentCommitHash || currentBranch !== state.currentBranchName) {
                throw new IOSGitError('IOS_EXTENSION_GIT_CHANGED', 'The extension Git state changed during the update. Retry after finishing other changes.');
            }

            if (!state.isUpToDate) {
                const canFastForward = await this.isDescendent(state.remoteCommitHash, state.currentCommitHash);
                if (!canFastForward) {
                    throw new IOSGitError('IOS_EXTENSION_GIT_DIVERGED', 'The extension has local commits or rewritten remote history. A fast-forward update cannot preserve both histories.');
                }

                // Checkout validates conflicts before writing. Keep HEAD unchanged until
                // the working tree and index are ready; never force or merge local files.
                try {
                    await git.checkout({
                        fs,
                        dir: this.directory,
                        ref: state.remoteCommitHash,
                        noUpdateHead: true,
                        force: false,
                    });
                } catch (error) {
                    if (error.code === 'CheckoutConflictError') {
                        throw new IOSGitError('IOS_EXTENSION_GIT_DIRTY', 'The extension has local file changes. Save or move those changes before updating; no files were overwritten.');
                    }
                    throw error;
                }
                await git.writeRef({
                    fs,
                    dir: this.directory,
                    ref: `refs/heads/${state.currentBranchName}`,
                    value: state.remoteCommitHash,
                    force: true,
                });
            }

            const commit = await git.resolveRef({ fs, dir: this.directory, ref: 'HEAD' });
            return {
                shortCommitHash: commit.slice(0, 7),
                // The frontend uses the previous state to distinguish an update from a no-op.
                isUpToDate: state.isUpToDate,
                remoteUrl: state.remoteUrl,
            };
        });
    }

    /** @returns {Promise<void>} */
    async requireRepository() {
        if (!await this.checkIsRepo()) {
            throw new IOSGitError('IOS_EXTENSION_NO_GIT_REPOSITORY', 'This extension has no Git history and cannot be updated from a remote repository.');
        }
        const inspect = async directory => {
            for (const name of await fs.promises.readdir(directory)) {
                const absolute = path.join(directory, name);
                const stat = await fs.promises.lstat(absolute);
                if (stat.isSymbolicLink()) {
                    throw new IOSGitError('IOS_EXTENSION_GIT_UNSAFE_METADATA', 'The extension Git metadata contains symbolic links. Use an independent repository before changing or fetching its branches.');
                }
                if (stat.isDirectory()) await inspect(absolute);
            }
        };
        await inspect(path.join(this.directory, '.git'));
    }

    /** @returns {Promise<void>} */
    async requireClean() {
        if ((await this.status()).length > 0) {
            throw new IOSGitError('IOS_EXTENSION_GIT_DIRTY', 'The extension has local file changes. Save or move those changes before updating; no files were overwritten.');
        }
    }

    /** @returns {Promise<Object>} Repository state after fetching the current upstream branch */
    async fetchState() {
        await this.requireRepository();
        const currentBranchName = await git.currentBranch({ fs, dir: this.directory });
        if (!currentBranchName) {
            throw new IOSGitError('IOS_EXTENSION_GIT_DETACHED', 'The extension is not on a branch. Select a branch on another device before updating.');
        }
        validateBranchName(currentBranchName);
        let currentCommitHash;
        try {
            currentCommitHash = await git.resolveRef({ fs, dir: this.directory, ref: 'HEAD' });
        } catch (error) {
            if (error.code === 'NotFoundError') {
                throw new IOSGitError('IOS_EXTENSION_NO_GIT_COMMITS', 'The extension Git repository has no commit to update.');
            }
            throw error;
        }

        const url = await git.getConfig({ fs, dir: this.directory, path: 'remote.origin.url' });
        let remoteUrl;
        try {
            remoteUrl = new URL(url);
            if (!['http:', 'https:'].includes(remoteUrl.protocol)) throw new Error('Unsupported Git transport');
        } catch {
            throw new IOSGitError('IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE', 'The extension has no HTTP or HTTPS origin repository to check.');
        }
        // Do not return credentials embedded in a manually edited Git config.
        remoteUrl.username = '';
        remoteUrl.password = '';

        const trackingRemote = await git.getConfig({ fs, dir: this.directory, path: `branch.${currentBranchName}.remote` });
        if (trackingRemote && trackingRemote !== 'origin') {
            throw new IOSGitError('IOS_EXTENSION_GIT_REMOTE_UNAVAILABLE', 'This branch tracks a remote other than origin. Its tracking configuration must be resolved before updating.');
        }
        const mergeRef = await git.getConfig({ fs, dir: this.directory, path: `branch.${currentBranchName}.merge` });
        if (mergeRef && !mergeRef.startsWith('refs/heads/')) {
            throw new IOSGitError('IOS_EXTENSION_GIT_REMOTE_BRANCH_UNAVAILABLE', 'The extension does not track a remote branch.');
        }
        const remoteBranch = mergeRef ? mergeRef.slice('refs/heads/'.length) : currentBranchName;
        validateBranchName(remoteBranch);
        let fetched;
        try {
            fetched = await git.fetch({
                fs,
                http: this.http,
                dir: this.directory,
                remote: 'origin',
                ref: `refs/heads/${currentBranchName}`,
                remoteRef: `refs/heads/${remoteBranch}`,
                singleBranch: true,
                tags: false,
            });
        } catch {
            throw new IOSGitError('IOS_EXTENSION_GIT_FETCH_FAILED', 'Could not check the extension repository. Check the connection and repository access, then retry.', 502);
        }
        const remoteCommitHash = fetched.fetchHead;
        if (!remoteCommitHash) {
            throw new IOSGitError('IOS_EXTENSION_GIT_REMOTE_BRANCH_UNAVAILABLE', 'The extension origin did not provide the tracked branch.');
        }
        const isUpToDate = currentCommitHash === remoteCommitHash || await this.isDescendent(currentCommitHash, remoteCommitHash);
        return { currentBranchName, currentCommitHash, remoteCommitHash, isUpToDate, remoteUrl: remoteUrl.href };
    }

    /**
     * @param {string} oid Possible descendant
     * @param {string} ancestor Expected ancestor
     * @returns {Promise<boolean>}
     */
    async isDescendent(oid, ancestor) {
        try {
            return await git.isDescendent({ fs, dir: this.directory, oid, ancestor });
        } catch (error) {
            if (error.code === 'NotFoundError') {
                throw new IOSGitError('IOS_EXTENSION_GIT_HISTORY_INCOMPLETE', 'The extension Git history is incomplete, so a safe update could not be verified.');
            }
            throw error;
        }
    }

    /**
     * @param {Object} state Internal repository state
     * @returns {{ currentBranchName: string, currentCommitHash: string, isUpToDate: boolean, remoteUrl: string }}
     */
    publicVersion(state) {
        return {
            currentBranchName: state.currentBranchName,
            currentCommitHash: state.currentCommitHash,
            isUpToDate: state.isUpToDate,
            remoteUrl: state.remoteUrl,
        };
    }

    /**
     * @template T
     * @param {() => Promise<T>} operation Repository operation
     * @returns {Promise<T>}
     */
    async serialize(operation) {
        const previous = repositoryOperations.get(this.directory) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(operation);
        repositoryOperations.set(this.directory, pending);
        try {
            return await pending;
        } finally {
            if (repositoryOperations.get(this.directory) === pending) repositoryOperations.delete(this.directory);
        }
    }
}
