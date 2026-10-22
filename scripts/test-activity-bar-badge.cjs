const assert = require('node:assert/strict');
const Module = require('node:module');

const load = Module._load;
let commandDisposed = false;
let registeredCommand;
let CommitPanelViewTitleController;
try {
  Module._load = function(name, ...args) {
    if (name === 'vscode') return {
      commands: {
        registerCommand(name, callback) {
          registeredCommand = { name, callback };
          return { dispose() { commandDisposed = true; } };
        },
      },
    };
    return load.call(this, name, ...args);
  };
  ({ CommitPanelViewTitleController } = require('../out/webview/commitPanelViewTitleController'));
} finally {
  Module._load = load;
}

const file = path => ({ path, status: 'M' });
const repository = (repositoryPath, staged = [], unstaged = []) => ({
  repositoryPath, staged: staged.map(file), unstaged: unstaged.map(file),
});
let opened = 0;
const controller = new CommitPanelViewTitleController(() => { opened++; });
assert.equal(registeredCommand.name, 'fastergit.openCommitPanel');
registeredCommand.callback();
assert.equal(opened, 1);
assert.doesNotThrow(() => controller.update([]));

const view = {};
controller.bindView(view, [repository('main', [], ['a', 'b', 'c'])]);
assert.equal(view.badge.value, 3, 'one dirty repository with three files shows three');
assert.equal(view.badge.tooltip, '3 个未提交变更文件');

controller.update([
  repository('main', ['same', 'staged'], ['same', 'unstaged']),
  repository('child', [], ['same', 'untracked']),
  repository('clean'),
]);
assert.equal(view.badge.value, 5, 'deduplicate within a repository, not across repositories');
assert.equal(view.badge.tooltip, '5 个未提交变更文件');

controller.update([repository('main', ['same'], ['same'])]);
assert.equal(view.badge.value, 1, 'staging and modifying the same file counts once');
controller.update([repository('main', ['staged'])]);
assert.equal(view.badge.value, 1, 'staged-only files count');
controller.update([repository('clean')]);
assert.equal(view.badge, undefined, 'clean repositories hide the badge');
controller.update([]);
assert.equal(view.badge, undefined, 'removing all repositories hides the badge');

const replacementView = {};
controller.bindView(replacementView, [repository('child', [], ['a', 'b'])]);
controller.unbindView(view);
controller.update([repository('child', [], ['a'])]);
assert.equal(replacementView.badge.value, 1, 'disposing an old view does not unbind the replacement');
controller.unbindView(replacementView);
controller.update([]);
assert.equal(replacementView.badge.value, 1, 'unbound views are not updated');
controller.dispose();
assert.equal(commandDisposed, true);
console.log('Activity bar badge tests passed.');
