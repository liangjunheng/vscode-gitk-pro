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
const childOrigin = path.join(root, 'child.git');
const childSeed = path.join(root, 'child-seed');
const nestedOrigin = path.join(root, 'nested.git');
const nestedSeed = path.join(root, 'nested-seed');
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
        assert.deepEqual((await operations.listRemotes(rootUri)).map(remote => remote.name), ['origin']);
        await operations.setRemoteAsUpstream(rootUri, 'origin');
        assert.equal(git(local, 'rev-parse', '--symbolic-full-name', '@{upstream}'), 'refs/remotes/origin/main');
        await operations.addRemote(rootUri, 'backup', origin);
        assert.deepEqual((await operations.listRemotes(rootUri)).map(remote => remote.name), ['backup', 'origin']);
        await operations.removeRemote(rootUri, 'backup');
        assert.deepEqual((await operations.listRemotes(rootUri)).map(remote => remote.name), ['origin']);

        const fetch = operations.fetchRemotes(rootUri, 'origin');
        const overlappingFetch = operations.fetchRemotes(rootUri, 'origin');
        assert.equal(overlappingFetch, fetch, 'overlapping fetch callers share the same Git process');
        await fetch;
        assert.equal(git(local, 'rev-parse', 'origin/HEAD'), git(other, 'rev-parse', 'HEAD'));
        const laterFetch = operations.fetchRemotes(rootUri, 'origin');
        assert.notEqual(laterFetch, fetch, 'a later fetch is not suppressed after completion');
        await laterFetch;

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

        execFileSync('git', ['init', '--bare', nestedOrigin]);
        execFileSync('git', ['clone', nestedOrigin, nestedSeed]);
        git(nestedSeed, 'config', 'user.name', 'Gitk Test');
        git(nestedSeed, 'config', 'user.email', 'gitk@example.com');
        fs.writeFileSync(path.join(nestedSeed, 'nested.txt'), 'nested\n');
        git(nestedSeed, 'add', 'nested.txt');
        git(nestedSeed, 'commit', '-m', 'nested');
        git(nestedSeed, 'push', '-u', 'origin', 'HEAD');

        execFileSync('git', ['init', '--bare', childOrigin]);
        execFileSync('git', ['clone', childOrigin, childSeed]);
        git(childSeed, 'config', 'user.name', 'Gitk Test');
        git(childSeed, 'config', 'user.email', 'gitk@example.com');
        fs.writeFileSync(path.join(childSeed, 'child.txt'), 'child\n');
        git(childSeed, 'add', 'child.txt');
        git(childSeed, 'commit', '-m', 'child');
        execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', childSeed,
            'submodule', 'add', nestedOrigin, 'nested']);
        git(childSeed, 'commit', '-m', 'add nested submodule');
        git(childSeed, 'push', '-u', 'origin', 'HEAD');

        execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', local,
            'submodule', 'add', childOrigin, 'modules/child']);
        git(local, 'commit', '-m', 'add child submodule');
        git(local, 'submodule', 'deinit', '-f', '--', 'modules/child');
        assert.equal(fs.existsSync(path.join(local, 'modules', 'child', 'child.txt')), false,
            'fixture starts with the child submodule uninitialized');

        const previousAllowedProtocols = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = 'file';
        try {
            await operations.updateSubmodules(rootUri, ['modules/child']);
        } finally {
            if (previousAllowedProtocols === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
            else process.env.GIT_ALLOW_PROTOCOL = previousAllowedProtocols;
        }
        assert.equal(fs.existsSync(path.join(local, 'modules', 'child', 'child.txt')), true,
            'submodule update initializes the selected child before checkout');
        assert.equal(fs.existsSync(path.join(local, 'modules', 'child', 'nested', 'nested.txt')), true,
            'submodule update recursively initializes nested children');
        assert.deepEqual(nativeOperations, ['resolveRevision']);
        console.log('Git CLI remote-operation tests passed: fetch single-flight/retry, pull, push, and recursive submodule initialization bypass libgit2.');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
