const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fastergit-stash-fault-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let failDrop = true;
const original = Module._load;
let writeStashOperation, readMergeOperation, runMergeOperation;
try {
    Module._load = function(name, ...args) {
        if (name === 'vscode') return {};
        if (name === './nativeGitBinding') return {
            invokeNativeGit: async (operation, payload) => {
                if (operation === 'discover') return { gitDir: path.join(root, '.git') };
                if (operation === 'resolveRevision') return payload.specs.map(() => git('rev-parse', 'HEAD'));
                if (operation === 'hasConflicts') return false;
                if (operation === 'stashDrop') {
                    if (failDrop) throw new Error('injected drop failure');
                    const hashes = git('stash', 'list', '--format=%H').split(/\r?\n/).filter(Boolean);
                    const index = hashes.indexOf(payload.stash);
                    if (index < 0) throw new Error('stash already missing');
                    git('stash', 'drop', `stash@{${index}}`);
                    return undefined;
                }
                throw new Error(`unexpected native operation: ${operation}`);
            },
        };
        return original.call(this, name, ...args);
    };
    ({ writeStashOperation, readMergeOperation, runMergeOperation } = require('../out/git/mergeOperation'));
} finally { Module._load = original; }

async function main() {
    try {
        git('init', '-q');
        git('config', 'user.name', 'Test');
        git('config', 'user.email', 'test@example.com');
        fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
        git('add', 'file.txt');
        git('commit', '-qm', 'base');
        fs.writeFileSync(path.join(root, 'file.txt'), 'stash\n');
        git('stash', 'push', '-qm', 'fault');
        const stash = git('rev-parse', 'refs/stash');
        const head = git('rev-parse', 'HEAD');
        const uri = { fsPath: root };
        const markerPath = path.join(root, '.git', 'fastergit-stash-operation.json');

        await writeStashOperation(uri, 'stash-pop', stash, head, ['file.txt'], 'conflicted');
        await assert.rejects(() => runMergeOperation(uri, 'stash-pop', 'continue'), /injected drop failure/);
        assert.equal(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase, 'finishing', 'Drop failure preserves a retryable finishing marker');
        assert.equal(git('rev-parse', 'refs/stash'), stash, 'Drop failure preserves the exact stash');

        failDrop = false;
        await runMergeOperation(uri, 'stash-pop', 'continue');
        assert.equal(await readMergeOperation(uri), undefined, 'retry clears the finishing marker');
        assert.throws(() => git('rev-parse', '--verify', 'refs/stash'), 'retry drops the exact stash once');
        console.log('Merge operation fault injection: Pop drop failure and idempotent retry passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
