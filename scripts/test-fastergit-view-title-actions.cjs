const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');
const { renderGitkWebviewHtml } = require('../out/webview/gitkWebviewDocument');
const manifest = require('../package.json');

const viewTitleActions = manifest.contributes.menus['view/title']
  .filter(item => item.when.includes('view == fastergit.panelView'));
assert.deepEqual(viewTitleActions.map(item => [item.command, item.group]), [
  ['fastergit.openCommitPanel', 'navigation@1'],
  ['fastergit.refresh', 'navigation@2'],
  ['fastergit.changedFiles.useFlatView', 'navigation@3'],
  ['fastergit.changedFiles.useTreeView', 'navigation@3'],
]);
assert.match(viewTitleActions[2].when, /changedFilesDisplayMode == tree/);
assert.match(viewTitleActions[3].when, /changedFilesDisplayMode == flat/);
const contributedCommands = new Map(manifest.contributes.commands.map(command => [command.command, command]));
assert.equal(contributedCommands.get('fastergit.refresh').icon, '$(refresh)');
assert.equal(contributedCommands.get('fastergit.changedFiles.useFlatView').icon, '$(list-tree)');
assert.equal(contributedCommands.get('fastergit.changedFiles.useTreeView').icon, '$(list-flat)');

const registeredCommands = new Map();
const contextValues = new Map();
const configurationListeners = [];
const configuration = { changedFilesDisplayMode: 'flat', multiDiffRenderSideBySide: true };
const disposables = [];
let providerInstance;

class MockGitkViewProvider {
  static viewType = 'fastergit.panelView';
  constructor() {
    providerInstance = this;
    this.onDidChangeRepositoryState = () => ({ dispose() {} });
    this.onDidChangeWorkingTreeSummary = () => ({ dispose() {} });
    this.hasRepositories = false;
    this.refreshCount = 0;
  }
  initializeBackground() {}
  setMultiDiffRenderSideBySide(value) { this.renderSideBySide = value; }
  refreshCurrentView() { this.refreshCount++; }
  selectCommit() {}
  navigateMultiDiffChange() {}
  showMultiDiffSearch() {}
  getWorkingTreeSummary() { return { repositories: 0, files: 0 }; }
}
class MockGitkStatusBar {
  async initialize() {}
}
class MockGitCommitEditMsgEditor {
  dispose() {}
}

const vscode = {
  ConfigurationTarget: { Global: 1 },
  commands: {
    registerCommand(name, callback) {
      registeredCommands.set(name, callback);
      return { dispose() {} };
    },
    async executeCommand(name, ...args) {
      if (name === 'setContext') {
        contextValues.set(args[0], args[1]);
        return;
      }
      const command = registeredCommands.get(name);
      if (command) return command(...args);
    },
  },
  workspace: {
    registerTextDocumentContentProvider() { return { dispose() {} }; },
    getConfiguration(section) {
      assert.equal(section, 'fastergit');
      return {
        get(key, fallback) { return configuration[key] ?? fallback; },
        async update(key, value, target) {
          assert.equal(target, vscode.ConfigurationTarget.Global);
          configuration[key] = value;
          await Promise.all(configurationListeners.map(listener => listener({
            affectsConfiguration(candidate) { return candidate === `fastergit.${key}`; },
          })));
        },
      };
    },
    onDidChangeConfiguration(listener) {
      configurationListeners.push(listener);
      return { dispose() {} };
    },
  },
  window: {
    registerWebviewViewProvider(viewType, provider) {
      assert.equal(viewType, 'fastergit.panelView');
      assert.equal(provider, providerInstance);
      return { dispose() {} };
    },
  },
};

async function verifyActivation() {
  const originalLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (request === 'vscode') return vscode;
      if (request === './webview/gitkViewProvider') return { GitkViewProvider: MockGitkViewProvider };
      if (request === './statusBar') return { GitkStatusBar: MockGitkStatusBar };
      if (request === './webview/gitCommitEditMsgEditor') return { GitCommitEditMsgEditor: MockGitCommitEditMsgEditor };
      return originalLoad.call(this, request, parent, isMain);
    };
    const extensionPath = path.resolve(__dirname, '..');
    const context = { extensionPath, subscriptions: { push(...items) { disposables.push(...items); } } };
    const { activate } = require('../out/extension');
    await activate(context);
  } finally {
    Module._load = originalLoad;
  }

  assert.equal(contextValues.get('fastergit:changedFilesDisplayMode'), 'flat');
  assert.equal(contextValues.get('fastergit:multiDiffRenderSideBySide'), true);
  assert.ok(registeredCommands.has('fastergit.refresh'));
  assert.ok(registeredCommands.has('fastergit.changedFiles.useFlatView'));
  assert.ok(registeredCommands.has('fastergit.changedFiles.useTreeView'));

  await registeredCommands.get('fastergit.refresh')();
  assert.equal(providerInstance.refreshCount, 1, 'title refresh delegates to the existing provider refresh path');

  await registeredCommands.get('fastergit.changedFiles.useTreeView')();
  assert.equal(configuration.changedFilesDisplayMode, 'tree');
  assert.equal(contextValues.get('fastergit:changedFilesDisplayMode'), 'tree');
  await registeredCommands.get('fastergit.changedFiles.useFlatView')();
  assert.equal(configuration.changedFilesDisplayMode, 'flat');
  assert.equal(contextValues.get('fastergit:changedFilesDisplayMode'), 'flat');
  assert.ok(disposables.length > 0);
}

async function verifyWebview() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({}), setState() {} });
    });
    await page.setContent(renderGitkWebviewHtml('codicon.css', 'seti.woff', {}));
    assert.equal(await page.locator('#filesRefreshBtn').count(), 0);
    assert.equal(await page.locator('#filesModeBtn').count(), 0);
    assert.equal(await page.locator('#filesHeader').count(), 0, 'changed-files title row is removed');

    const repositoryPath = 'file:///view-title-fixture';
    const state = {
      repositoryChanges: [{
        repositoryPath,
        repositoryLabel: 'fixture',
        isMainRepository: true,
        headLabel: 'main',
        staged: [],
        unstaged: [{ path: 'src/a.cpp', status: 'M' }, { path: 'src/deep/b.cpp', status: 'M' }],
      }],
      selectedRepositoryPaths: [repositoryPath],
      selectedCommit: { hash: 'uncommitted', repositoryPath },
      commits: [], branches: [], selectedBranches: [], files: [], filesLoading: false, filesMode: 'flat',
    };
    const publish = () => page.evaluate(state => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'stateUpdate', state } }));
    }, state);
    await publish();
    assert.equal(await page.locator('.repo-folder').count(), 0, 'flat mode still renders from host state');
    state.filesMode = 'tree';
    await publish();
    assert.deepEqual(await page.locator('.repo-folder-name').allTextContents(), ['src', 'src/deep']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

async function main() {
  await verifyActivation();
  await verifyWebview();
  console.log('FasterGit view-title action tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
