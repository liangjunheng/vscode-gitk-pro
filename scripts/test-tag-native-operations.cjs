const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}
function loadOperations() {
  delete require.cache[require.resolve('../out/git/gitNativeOperations')];
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => false }) } };
      if (request === './nativeGitBinding') return {
        invokeNativeGit: async (operation, payload) => {
          if (operation !== 'resolveRevision') throw new Error('Unexpected native operation: ' + operation);
          return payload.specs.map(spec => git(payload.rootPath, ['rev-parse', spec]));
        },
      };
      return originalLoad.call(this, request, parent, isMain);
    };
    return require('../out/git/gitNativeOperations');
  } finally {
    Module._load = originalLoad;
  }
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastergit-tags-'));
  const repo = path.join(temp, 'repo');
  const remote = path.join(temp, 'remote.git');
  fs.mkdirSync(repo);
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'Tag Test']);
  git(repo, ['config', 'user.email', 'tag@example.com']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-m', 'base']);
  const hash = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', '-a', 'local-only', '-m', 'local only']);
  git(repo, ['tag', '-a', 'shared', '-m', 'shared']);
  git(repo, ['tag', 'remote-only']);
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', 'origin', 'refs/tags/shared:refs/tags/shared', 'refs/tags/remote-only:refs/tags/remote-only']);
  git(repo, ['tag', '-d', 'remote-only']);

  const operations = loadOperations();
  const rootUri = { fsPath: repo };
  let state = await operations.readCommitTagState(rootUri, hash);
  assert.deepEqual(state.localTags, ['local-only', 'shared']);
  assert.deepEqual(state.remoteTags, [{ remote: 'origin', name: 'remote-only' }, { remote: 'origin', name: 'shared' }]);
  assert.deepEqual(state.pushableTags, [{ remote: 'origin', name: 'local-only' }]);
  assert.deepEqual(state.remoteErrors, []);

  await operations.pushTag(rootUri, 'origin', 'local-only');
  state = await operations.readCommitTagState(rootUri, hash);
  assert.deepEqual(state.pushableTags, []);
  assert.ok(state.remoteTags.some(tag => tag.name === 'local-only'));

  await operations.deleteRemoteTag(rootUri, 'origin', 'shared');
  state = await operations.readCommitTagState(rootUri, hash);
  assert.ok(!state.remoteTags.some(tag => tag.name === 'shared'));
  assert.ok(state.pushableTags.some(tag => tag.name === 'shared'));

  await operations.deleteLocalTag(rootUri, 'shared');
  state = await operations.readCommitTagState(rootUri, hash);
  assert.deepEqual(state.localTags, ['local-only']);
  assert.ok(!state.pushableTags.some(tag => tag.name === 'shared'));
  console.log('Tag native operations passed: local/remote discovery, push, remote delete, local delete');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
