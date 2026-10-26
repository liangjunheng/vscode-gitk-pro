const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const binding = require('../out/git/nativeGitBinding').loadNativeGitBinding();

class EventEmitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const uri = fsPath => ({ fsPath, toString: () => pathToFileURL(fsPath).href });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitk-topology-'));
let fallback = false;
let calls = [];
const vscode = {
  EventEmitter,
  Uri: { file: uri, parse: value => uri(fileURLToPath(value)) },
  RelativePattern: class {},
  Disposable: { from: (...items) => ({ dispose() { items.forEach(item => item.dispose()); } }) },
  workspace: {
    workspaceFolders: [{ uri: uri(root) }],
    createFileSystemWatcher: () => ({
      onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }), dispose() {},
    }),
  },
};
const originalLoad = Module._load;
let RepoSubmoduleWatcher;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return vscode;
    if (name === './nativeGitBinding') return {
      invokeNativeGitPriorityRead: async (operation, payload) => {
        calls.push(operation);
        if (operation === 'discover') return { workdir: payload.path };
        if (fallback) throw new Error('old native module');
        return JSON.parse(await binding.invokePriorityRead(operation, JSON.stringify(payload)));
      },
    };
    return originalLoad.call(this, name, ...args);
  };
  ({ RepoSubmoduleWatcher } = require('../out/git/gitRepoSubmoduleWatcher'));
} finally { Module._load = originalLoad; }

const write = (relative, value) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
};
const snapshot = options => options.map(option => JSON.parse(JSON.stringify(option)));

async function main() {
  write('.gitmodules', '[submodule "b"]\r\n path = b\r\n path = missing\r\n path = a space\r\n');
  write('b/.git', 'gitdir: ../metadata/b\r\n');
  write('metadata/b/HEAD', 'ref: refs/heads/main\n');
  write('b/.gitmodules', ' path = nested/../nested\n');
  write('b/nested/.git/HEAD', 'ref: refs/heads/main\n');
  write('a space/.git/HEAD', 'ref: refs/heads/main\n');
  const native = new RepoSubmoduleWatcher();
  const old = new RepoSubmoduleWatcher();
  const nativeEvents = [], oldEvents = [];
  native.onTotalRepoListChanged(options => nativeEvents.push(snapshot(options)));
  old.onTotalRepoListChanged(options => oldEvents.push(snapshot(options)));
  try {
    const actual = await native.initialize();
    assert.equal(calls.filter(op => op === 'submoduleTopology').length, 1);
    fallback = true;
    const expected = await old.initialize();
    assert.deepEqual(snapshot(actual), snapshot(expected));
    assert.deepEqual(nativeEvents, oldEvents, 'card publication, ancestry, flags and order stay identical');
    assert.deepEqual(actual.map(x => x.label), [path.basename(root), 'b', 'nested', 'a space']);
    assert.deepEqual(native.getRepositoryAncestry(actual[2].path).map(x => x.label), [path.basename(root), 'b', 'nested']);
    // Re-read truth after initialization/deinitialization; never reuse cached topology.
    write('missing/.git/HEAD', 'ref: refs/heads/main\n');
    fs.unlinkSync(path.join(root, 'a space/.git/HEAD'));
    fallback = false;
    const next = await native.rescan();
    fallback = true;
    assert.deepEqual(snapshot(next), snapshot(await old.rescan()));
    assert.deepEqual(next.map(x => x.label), [path.basename(root), 'b', 'nested', 'missing']);
    write('b/.gitmodules', '');
    fallback = false;
    const partial = await native.rescanRepository(uri(path.join(root, 'b')).toString());
    fallback = true;
    assert.deepEqual(snapshot(partial), snapshot(await old.rescanRepository(uri(path.join(root, 'b')).toString())));
    console.log('Initialization topology passed: native/fallback parity, publication sequence, flags, ancestry, nested order, fresh init/deinit and partial removal.');
  } finally { native.dispose(); old.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
