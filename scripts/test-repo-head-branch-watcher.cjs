const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

class EventEmitter {
    listeners = new Set();
    event = listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) { for (const listener of [...this.listeners]) listener(value); }
    dispose() { this.listeners.clear(); }
}

const uri = fsPath => ({ fsPath, toString: () => fsPath });
const fileWatchers = [];
const vscode = {
    EventEmitter,
    Uri: { parse: uri, file: uri },
    RelativePattern: class {
        constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    Disposable: {
        from: (...items) => ({ dispose() { items.forEach(item => item.dispose()); } }),
    },
    workspace: {
        createFileSystemWatcher(pattern) {
            const create = new EventEmitter();
            const change = new EventEmitter();
            const remove = new EventEmitter();
            const watcher = {
                pattern,
                create,
                change,
                remove,
                onDidCreate: create.event,
                onDidChange: change.event,
                onDidDelete: remove.event,
                dispose() { create.dispose(); change.dispose(); remove.dispose(); },
            };
            fileWatchers.push(watcher);
            return watcher;
        },
    },
};

const originalLoad = Module._load;
let RepoHeadBranchWatcher;
try {
    Module._load = function(request, parent, isMain) {
        if (request === 'vscode') return vscode;
        if (request === '../types') {
            return { GitBranchOption: class { constructor(value) { Object.assign(this, value); } } };
        }
        if (request === './gitLogProvider') {
            return { buildDetachedHeadBranch: (_rootUri, hash, repository) => ({
                repoOption: repository, name: hash, label: hash.slice(0, 8), hash, kind: 'current',
            }) };
        }
        if (request === './nativeGitBinding') {
            return { invokeNativeGit: async (operation, payload) => {
                if (operation === 'discover') return { gitDir: path.join(payload.path, '.git') };
                if (operation === 'head') return { branch: 'refs/heads/main', hash: 'head-1' };
                throw new Error(`Unexpected native operation: ${operation}`);
            } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    ({ RepoHeadBranchWatcher } = require('../out/git/eachRepoHeadBranchWatcher'));
} finally {
    Module._load = originalLoad;
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForWatcher() {
    for (let attempt = 0; attempt < 100; attempt++) {
        const remoteWatcher = fileWatchers.find(item => item.pattern.pattern === '{refs/remotes/**,packed-refs}');
        if (remoteWatcher) return remoteWatcher;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Remote refs watcher was not created');
}

async function main() {
    const repository = { path: path.resolve('/remote-ref-fixture'), label: 'fixture' };
    const repositoriesChanged = new EventEmitter();
    const repoController = {
        totalRepoList: [repository],
        ontotalRepoListChanged: repositoriesChanged.event,
    };
    const watcher = new RepoHeadBranchWatcher(repoController);
    const notifications = [];
    const subscription = watcher.onEachRepoRemoteRefsChanged(event => notifications.push(event));
    try {
        const remoteWatcher = await waitForWatcher();
        remoteWatcher.create.fire();
        remoteWatcher.change.fire();
        remoteWatcher.remove.fire();
        await delay(25);
        assert.equal(notifications.length, 0, 'a burst waits for the remote-ref coalescing window');
        await delay(80);
        assert.deepEqual(notifications, [{ repositoryPath: repository.path }],
            'create/change/delete bursts publish one repository notification');

        remoteWatcher.create.fire();
        await delay(40);
        remoteWatcher.change.fire();
        await delay(40);
        assert.equal(notifications.length, 1, 'a later event restarts the trailing debounce window');
        await delay(60);
        assert.equal(notifications.length, 2, 'the quiet period publishes the next coalesced notification');

        remoteWatcher.create.fire();
        watcher.dispose();
        await delay(100);
        assert.equal(notifications.length, 2, 'disposing the repository watcher cancels a pending notification');
        console.log('Repository remote-ref watcher tests passed: bursts are trailing-debounced and disposal cancels pending work.');
    } finally {
        subscription.dispose();
        watcher.dispose();
        repositoriesChanged.dispose();
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
