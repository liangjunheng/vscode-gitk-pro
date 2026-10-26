const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
let events = [], answer = '中止操作', failure, operation = 'merge';
const vscode = {
    ProgressLocation: { Notification: 15 },
    Uri: { parse: value => ({ fsPath: value }) },
    window: {
        showWarningMessage: async () => { events.push('confirm'); return answer; },
        withProgress: async (options, task) => {
            events.push(['start', options]);
            try { return await task({ report: value => events.push(['report', value.message]) }); }
            finally { events.push('end'); }
        },
        showInformationMessage: message => events.push(['success', message]),
        showErrorMessage: message => events.push(['error', message]),
    },
};
let Provider;
try {
    Module._load = function(name, ...args) {
        if (name === 'vscode') return vscode;
        if (name === '../git/mergeOperation') return {
            readMergeOperation: async () => operation,
            describeMergeOperation: value => value === 'stash-pop' ? 'Stash Pop' : value,
            runMergeOperation: async () => { events.push('git'); if (failure) throw new Error(failure); },
        };
        return original.call(this, name, ...args);
    };
    Provider = require('../out/webview/gitkViewProvider').GitkViewProvider;
} finally { Module._load = original; }

async function run(action) {
    events = [];
    const provider = Object.create(Provider.prototype);
    Object.defineProperty(provider, 'repositories', { value: [{ path: '/fixture', label: 'fixture' }] });
    Object.assign(provider, {
        mergeOperationBusy: new Set(), schedulePushState() {},
        commitPanel: { isVisible: () => false },
        refreshCommitPanel: async () => events.push('panel'),
        refreshMergeOperation: async () => events.push('operation-state'),
        uncommittedFilesWatcher: {
            refreshHeadBranch: async () => { assert.equal(provider.mergeOperationBusy.has('/fixture'), true); events.push('head'); },
            listCurrentHeadBranches: () => [{ repoOption: { path: '/fixture' } }],
            refreshUncommittedFilesByHeadBranch: async () => events.push('files'),
        },
    });
    await provider.handleMergeOperation('/fixture', action);
    assert.equal(provider.mergeOperationBusy.size, 0);
    return events;
}
async function main() {
    for (const action of ['continue', 'abort']) {
        const result = await run(action);
        const start = result.find(item => Array.isArray(item) && item[0] === 'start');
        assert.equal(start[1].location, vscode.ProgressLocation.Notification);
        assert.equal(start[1].cancellable, false);
        assert.ok(start[1].title.includes(action === 'continue' ? '继续 merge' : '中止 merge'));
        assert.ok(result.indexOf('git') < result.indexOf('head'));
        assert.ok(result.indexOf('panel') < result.indexOf('end'), 'notification spans repository refresh');
        assert.ok(result.some(item => item[0] === 'success'));
        if (action === 'abort') assert.ok(result.indexOf('confirm') < result.indexOf(start));
    }
    operation = 'stash-pop';
    const stashComplete = await run('continue');
    const stashStart = stashComplete.find(item => Array.isArray(item) && item[0] === 'start');
    assert.ok(stashStart[1].title.includes('完成 Stash Pop'));
    operation = 'merge';
    failure = 'unresolved conflicts';
    const failed = await run('continue');
    assert.ok(failed.includes('files'), 'failure still refreshes repository inside progress');
    assert.ok(failed.some(item => item[0] === 'error' && item[1].includes(failure)));
    assert.ok(!failed.some(item => item[0] === 'success'));
    failure = undefined; answer = undefined;
    assert.deepEqual(await run('abort'), ['confirm'], 'cancelled abort does not start Git or progress');
    console.log('Merge notification progress: Continue, Abort, refresh lifetime, failure, cancellation passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
