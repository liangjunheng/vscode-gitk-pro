const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-cli-remote-'));
const origin = path.join(root, 'origin.git');
const local = path.join(root, 'local');
const other = path.join(root, 'other');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function loadOperations(invokeNativeGit) {
    const originalLoad = Module._load;
    const modulePath = require.resolve('../out/git/gitNativeOperations');
    delete require.cache[modulePath];
    try {
        Module._load = function(request, parent, isMain) {
            if (request === 'vscode') return {
                Uri: { file: fsPath => ({ fsPath }) },
                workspace: {
                    getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
                },
            };
            if (request === './nativeGitBinding') return { invokeNativeGit };
            return originalLoad.call(this, request, parent, isMain);
        };
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

async function main() {
    try {
        execFileSync('git', ['init', '--bare', origin]);
        execFileSync('git', ['clone', origin, local]);
        git(local, 'config', 'user.name', 'Gitk Test');
        git(local, 'config', 'user.email', 'gitk@example.com');
        fs.writeFileSync(path.join(local, 'initial.txt'), 'initial\n');
        git(local, 'add', 'initial.txt');
        git(local, 'commit', '-m', 'initial');
        git(local, 'push', '-u', 'origin', 'HEAD');

        execFileSync('git', ['clone', origin, other]);
        git(other, 'config', 'user.name', 'Gitk Test');
        git(other, 'config', 'user.email', 'gitk@example.com');
        fs.writeFileSync(path.join(other, 'remote.txt'), 'remote\n');
        git(other, 'add', 'remote.txt');
        git(other, 'commit', '-m', 'remote');
        git(other, 'push');

        const nativeOperations = [];
        const operations = loadOperations(async (operation, payload) => {
            nativeOperations.push(operation);
            if (operation === 'resolveRevision') {
                return [git(payload.rootPath, 'rev-parse', 'HEAD^{}')];
            }
            throw new Error(`Remote operations must not reach libgit2: ${operation}`);
        });
        const rootUri = { fsPath: local };

        await operations.fetchRemotes(rootUri, 'origin');
        assert.equal(git(local, 'rev-parse', 'origin/HEAD'), git(other, 'rev-parse', 'HEAD'));

        await operations.pull(rootUri, 'origin', git(local, 'branch', '--show-current'));
        assert.equal(git(local, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));

        fs.writeFileSync(path.join(local, 'pushed.txt'), 'pushed\n');
        git(local, 'add', 'pushed.txt');
        git(local, 'commit', '-m', 'pushed');
        const branch = git(local, 'branch', '--show-current');
        const pushed = await operations.push(rootUri, { remote: 'origin', remoteBranch: branch, sourceBranchName: branch });
        assert.equal(git(origin, 'rev-parse', `refs/heads/${branch}`), git(local, 'rev-parse', 'HEAD'));
        assert.equal(pushed.remote, 'origin');
        assert.equal(pushed.remoteBranch, branch);

        await operations.updateSubmodules(rootUri);
        assert.deepEqual(nativeOperations, ['resolveRevision']);
        console.log('Git CLI remote-operation tests passed: fetch, pull, push, and submodule update bypass libgit2.');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
