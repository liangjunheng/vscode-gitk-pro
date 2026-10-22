const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
function loadFresh(modulePath, mocks) {
  delete require.cache[require.resolve(modulePath)];
  try {
    Module._load = function(request, parent, isMain) {
      if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
      return originalLoad.call(this, request, parent, isMain);
    };
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

async function main() {
  const calls = [];
  const confirmations = [];
  let tagStateReads = 0;
  const tagState = {
    localTags: ['v1', 'v2'],
    remoteTags: [{ remote: 'origin', name: 'v1' }, { remote: 'upstream', name: 'v2' }],
    pushableTags: [{ remote: 'origin', name: 'v2' }],
    remoteErrors: [],
  };
  const vscode = {
    env: { clipboard: { writeText: async value => calls.push(['copy', value]) } },
    window: {
      showInputBox: async () => 'v3',
      showQuickPick: async items => items.at(-1),
      showWarningMessage: async (message, options, ...choices) => {
        confirmations.push([message, options, choices]);
        return choices[0];
      },
      showInformationMessage: () => {},
      showErrorMessage: message => calls.push(['error', message]),
    },
    ProgressLocation: { Notification: 1 },
  };
  const native = {
    readCommitTagState: async () => { tagStateReads++; await new Promise(resolve => setImmediate(resolve)); return tagState; },
    createTag: async (_root, name, hash, message) => calls.push(['create', name, hash, message]),
    deleteLocalTag: async (_root, name) => calls.push(['deleteLocal', name]),
    deleteRemoteTag: async (_root, remote, name) => calls.push(['deleteRemote', remote, name]),
    pushTag: async (_root, remote, name) => calls.push(['pushTag', remote, name]),
    checkout: async () => {}, cherryPick: async () => {}, createBranch: async () => {}, merge: async () => {},
    rebase: async () => {}, reset: async () => {}, revertCommit: async () => {}, stageAll: async () => {},
    statusSummary: async () => ({ hasStagedChanges: false, hasUnstagedChanges: false }),
  };
  const actions = loadFresh('../out/services/gitActions', {
    vscode,
    '../git/gitLogProvider': { defaultPushTarget: () => undefined, getPushPlan: async () => undefined, runGitSync: async () => ({}), updateGitSubmodules: async () => {} },
    '../git/gitNativeOperations': native,
    '../webview/gitCommitEditMsgEditor': { GitCommitEditMsgEditor: class {} },
    './pushDialogs': { confirmPush: async () => true, pickPushTargets: async () => [], showPushResult: async () => {} },
  });
  const mutated = [];
  const runner = new actions.GitActionRunner(() => ({ fsPath: '/repo' }), async root => mutated.push(root.fsPath), {});
  const concurrent = await Promise.all([runner.getCommitTagState('abc', 'repo'), runner.getCommitTagState('abc', 'repo')]);
  assert.equal(tagStateReads, 1, 'concurrent menu state requests share one remote lookup');
  assert.deepEqual(concurrent[0], tagState);

  await runner.runCommitAction('createTag', 'abc', 'repo');
  await runner.runCommitAction('deleteTag', 'abc', 'repo');
  await runner.runCommitAction('deleteRemoteTag', 'abc', 'repo');
  await runner.runCommitAction('pushTag', 'abc', 'repo');
  assert.deepEqual(calls, [
    ['create', 'v3', 'abc', 'Tag v3'],
    ['deleteLocal', 'v2'],
    ['deleteRemote', 'upstream', 'v2'],
    ['pushTag', 'origin', 'v2'],
  ]);
  assert.equal(mutated.length, 4);
  assert.deepEqual(confirmations.map(item => item[2][0]), ['删除 Tag', '删除远程 Tag', 'Push Tag']);
  console.log('Tag action runner passed: state dedupe, create, local delete, remote delete, push');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
