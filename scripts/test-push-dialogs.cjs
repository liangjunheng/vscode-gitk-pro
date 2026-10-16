const assert = require('node:assert/strict');
const Module = require('node:module');

let lastQuickPick;
class ThemeIcon { constructor(id) { this.id = id; } }
function createQuickPick() {
  const listeners = { accept: [], hide: [], button: [], active: [] };
  const quickPick = {
    title: '', placeholder: '', items: [], activeItems: [], selectedItems: [], buttons: [],
    canSelectMany: false, keepScrollPosition: false,
    onDidAccept(listener) { listeners.accept.push(listener); return { dispose() {} }; },
    onDidHide(listener) { listeners.hide.push(listener); return { dispose() {} }; },
    onDidTriggerButton(listener) { listeners.button.push(listener); return { dispose() {} }; },
    onDidChangeActive(listener) { listeners.active.push(listener); return { dispose() {} }; },
    show() {},
    hide() { listeners.hide.forEach(listener => listener()); },
    dispose() {},
    accept() { listeners.accept.forEach(listener => listener()); },
    activate(item) { this.activeItems = [item]; listeners.active.forEach(listener => listener([item])); },
  };
  lastQuickPick = quickPick;
  return quickPick;
}

async function main() {
  const load = Module._load;
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return {
        QuickPickItemKind: { Separator: -1 }, ThemeIcon,
        window: { createQuickPick },
      };
      return load.call(this, name, ...args);
    };
    const { confirmPush } = require('../out/services/pushDialogs');
    const pending = confirmPush({
      pullBeforePush: true,
      targets: [
        'inkengine22：ink_dev → origin/develop',
        'ink-render：feature/gpu → upstream/feature/gpu',
      ],
    });
    assert.equal(lastQuickPick.title, '确认推送');
    assert.equal(lastQuickPick.items[0].action, 'push');
    assert.equal(lastQuickPick.items[0].description, '2 个推送目标');
    assert.deepEqual(lastQuickPick.items.slice(1, 4).map(item => [item.label, item.detail]), [
      ['$(sync) 推送前先拉取并更新本地分支', '每个目标会先更新本地分支，再执行推送'],
      ['$(arrow-right) inkengine22：ink_dev → origin/develop', '推送目标'],
      ['$(arrow-right) ink-render：feature/gpu → upstream/feature/gpu', '推送目标'],
    ]);
    assert.equal(lastQuickPick.items[4].action, 'cancel');
    lastQuickPick.activate(lastQuickPick.items[1]);
    assert.equal(lastQuickPick.activeItems[0].action, 'push', 'informational target rows cannot replace the active command');
    assert.ok(lastQuickPick.items.every(item => !String(item.detail ?? '').includes('\n')), 'confirmation rows must not rely on multiline QuickPick detail');
    lastQuickPick.activeItems = [lastQuickPick.items[0]];
    lastQuickPick.accept();
    assert.equal(await pending, true);

    const cancelPending = confirmPush({ targets: ['main → origin/main'] });
    const cancelItem = lastQuickPick.items.find(item => item.action === 'cancel');
    lastQuickPick.activeItems = [cancelItem];
    lastQuickPick.accept();
    assert.equal(await cancelPending, false, 'cancel row keeps the existing confirmation behavior');
    console.log('Push dialog tests passed: pull notice and every push target render on separate non-selectable rows.');
  } finally {
    Module._load = load;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
