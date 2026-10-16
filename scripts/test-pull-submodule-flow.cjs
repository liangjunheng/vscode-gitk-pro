const nodeAssert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;

function loadFresh(modulePath, mocks) {
    delete require.cache[require.resolve(modulePath)];
    try {
        Module._load = function(request, parent, isMain) {
            if (Object.prototype.hasOwnProperty.call(mocks, request)) {
                return mocks[request];
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

async function testPullChecksStaleSubmodulesWithoutHeadChange() {
    const progress = [];
    const updateCalls = [];
    const head = 'a'.repeat(40);
    const invokeNativeGit = async operation => {
        if (operation === 'head') return { hash: head };
        if (operation === 'branches') return { local: [], remote: [] };
        if (operation === 'submodules') return [
            { path: 'modules/current', indexId: '1'.repeat(40), workdirId: '1'.repeat(40) },
            { path: 'modules/stale', indexId: '2'.repeat(40), workdirId: '1'.repeat(40) },
            { path: 'modules/missing', indexId: '3'.repeat(40), workdirId: null },
        ];
        throw new Error(`Unexpected native operation: ${operation}`);
    };
    const provider = loadFresh('../out/git/gitLogProvider', {
        vscode: { Uri: { file: fsPath => ({ fsPath, toString: () => fsPath }) } },
        './nativeGitBinding': { invokeNativeGit },
        './gitNativeOperations': {
            fetchRemotes: async () => {},
            pull: async () => {},
            push: async () => ({}),
            updateSubmodules: async (_rootUri, paths) => updateCalls.push([...paths]),
        },
    });
    const rootUri = { fsPath: '/fixture', toString: () => '/fixture' };
    const result = await provider.runGitSync(rootUri, 'pull', message => progress.push(message));
    nodeAssert.equal(result.headChanged, false);
    nodeAssert.equal(result.submodulesNeedUpdate, true, 'a no-op pull still checks submodule state');
    nodeAssert.deepEqual(result.submodulePaths, ['modules/stale', 'modules/missing']);
    nodeAssert.equal(result.summary, '代码拉取完成：当前分支已是最新状态（aaaaaaaa）');
    nodeAssert.ok(progress.includes('正在检查子模块是否需要更新...'));

    const updateProgress = [];
    await provider.updateGitSubmodules(rootUri, result.submodulePaths, message => updateProgress.push(message));
    nodeAssert.deepEqual(updateCalls, [['modules/stale'], ['modules/missing']], 'submodules update one at a time');
    nodeAssert.deepEqual(updateProgress, [
        '正在更新子模块（1/2）：modules/stale',
        '子模块更新完成（1/2）：modules/stale',
        '正在更新子模块（2/2）：modules/missing',
        '子模块更新完成（2/2）：modules/missing',
    ]);
}

async function testPullPromptsBeforeUpdatingSubmodules() {
    let answer = '更新子模块';
    let events = [];
    const updateCalls = [];
    const result = {
        headChanged: false,
        submodulesNeedUpdate: true,
        submoduleTopologyChanged: false,
        submodulePaths: ['modules/stale', 'modules/missing'],
        summary: '代码拉取完成：当前分支已是最新状态（aaaaaaaa）',
        details: [],
    };
    const vscode = {
        ProgressLocation: { Notification: 15 },
        window: {
            withProgress: async (options, task) => {
                events.push(['start', options]);
                return task({ report: value => events.push(['progress', value.message]) });
            },
            showWarningMessage: async (...args) => {
                events.push(['prompt', ...args]);
                return answer;
            },
            showInformationMessage: message => events.push(['information', message]),
            showErrorMessage: message => events.push(['error', message]),
        },
        env: { clipboard: { writeText: async () => {} } },
    };
    const actions = loadFresh('../out/services/gitActions', {
        vscode,
        '../git/gitLogProvider': {
            getPushBranches: async () => [],
            runGitSync: async () => result,
            updateGitSubmodules: async (_rootUri, paths, onProgress) => {
                updateCalls.push([...paths]);
                for (const path of paths) onProgress(`正在更新子模块：${path}`);
            },
        },
        '../git/gitNativeOperations': {
            checkout: async () => {}, cherryPick: async () => {}, createBranch: async () => {}, createTag: async () => {},
            merge: async () => {}, rebase: async () => {}, reset: async () => {}, revertCommit: async () => {},
            stageAll: async () => {}, statusSummary: async () => ({ hasStagedChanges: false, hasUnstagedChanges: false }),
        },
        '../webview/gitCommitEditMsgEditor': { GitCommitEditMsgEditor: class {} },
        './pushDialogs': {
            confirmPush: async () => true, pickPushBranches: async () => [], showPushResult: async () => {},
        },
    });
    const mutated = [];
    const runner = new actions.GitActionRunner(
        () => ({ fsPath: '/fixture' }),
        async (...args) => mutated.push(args),
        {},
    );

    await runner.syncRepository('pull', '/fixture');
    const prompt = events.find(event => event[0] === 'prompt');
    nodeAssert.ok(prompt, 'a no-op pull still prompts when submodules are stale');
    nodeAssert.ok(prompt[1].includes('2 个子模块版本不一致'));
    nodeAssert.equal(prompt[2].modal, true);
    nodeAssert.ok(prompt[2].detail.includes('modules/stale'));
    nodeAssert.ok(prompt[2].detail.includes('modules/missing'));
    nodeAssert.deepEqual(updateCalls, [['modules/stale', 'modules/missing']]);
    nodeAssert.ok(events.some(event => event[0] === 'progress' && event[1].includes('modules/stale')));
    nodeAssert.ok(events.some(event => event[0] === 'information'
        && event[1] === '代码拉取完成：当前分支已是最新状态（aaaaaaaa）；已更新 2 个子模块。'));

    answer = '暂不更新';
    events = [];
    await runner.syncRepository('pull', '/fixture');
    nodeAssert.equal(updateCalls.length, 1, 'declining the prompt does not update submodules');
    nodeAssert.ok(events.some(event => event[0] === 'information'
        && event[1] === '代码拉取完成：当前分支已是最新状态（aaaaaaaa）；有 2 个子模块暂未更新。'));
    nodeAssert.equal(mutated.length, 2);
}

async function main() {
    await testPullChecksStaleSubmodulesWithoutHeadChange();
    await testPullPromptsBeforeUpdatingSubmodules();
    console.log('Pull submodule flow: no-op check, confirmation, per-module progress, updated/skipped copy passed');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
